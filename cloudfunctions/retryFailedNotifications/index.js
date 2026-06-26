const crypto = require('crypto')
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const ADMIN_OPENID = 'ouQIY0UogBHEkYzGs9A9BqP7JAL4'
const DELIVERY_TASK_COLLECTION = 'notice_delivery_tasks'
const DELIVERY_ATTEMPT_COLLECTION = 'notice_delivery_attempts'

function deliveryTaskId(notice) {
  return crypto.createHash('sha1').update(notice.url).digest('hex')
}

function deliveryAttemptId(taskId) {
  return `${taskId}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
}

function errorText(error) {
  return String(error && (error.errMsg || error.message || error)).slice(0, 500)
}

function errorCode(error) {
  if (!error) return null
  if (typeof error.errCode === 'number') return error.errCode
  if (typeof error.errcode === 'number') return error.errcode
  const text = errorText(error)
  const match = text.match(/errCode[:：]?\s*(-?\d+)|errcode[:：]?\s*(-?\d+)/i)
  return match ? Number(match[1] || match[2]) : null
}

function isAuthorizationInvalidError(error) {
  const code = errorCode(error)
  if (code === 43101) return true
  const text = errorText(error).toLowerCase()
  return /user refuse|not subscribe|not accept|subscribe.*expired|没有订阅|未订阅|拒绝/.test(text)
}

function messageData(notice) {
  return {
    thing1: { value: notice.title.slice(0, 20) },
    date2: { value: notice.date && notice.date.length === 10 ? notice.date : new Date().toISOString().slice(0, 10) },
    thing3: { value: '软考成绩查询通知已发布，请及时查询' }
  }
}

function chunkArray(items, size) {
  const chunks = []
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }
  return chunks
}

function emptyDelivery() {
  return { sent: 0, failed: 0, authFailed: 0, updateFailed: 0 }
}

function mergeDelivery(base, extra) {
  return {
    sent: Number((base && base.sent) || 0) + Number((extra && extra.sent) || 0),
    failed: Number((base && base.failed) || 0) + Number((extra && extra.failed) || 0),
    authFailed: Number((base && base.authFailed) || 0) + Number((extra && extra.authFailed) || 0),
    updateFailed: Number((base && base.updateFailed) || 0) + Number((extra && extra.updateFailed) || 0)
  }
}

function groupSendResults(results, keyOf) {
  const groups = new Map()
  for (const result of results) {
    const key = keyOf(result)
    if (!groups.has(key)) groups.set(key, { sample: result, ids: [] })
    groups.get(key).ids.push(result.subscriber._id)
  }
  return [...groups.values()]
}

async function updateSubscriptionsByIds(ids, data) {
  if (!ids.length) return 0
  let updated = 0
  for (const chunk of chunkArray(ids, 100)) {
    const result = await db.collection('subscriptions').where({ _id: _.in(chunk) }).update({ data })
    updated += result && result.stats ? Number(result.stats.updated || 0) : 0
  }
  return updated
}

async function flushSendResults(notice, results) {
  let updateFailed = 0
  const successResults = results.filter(result => result.status === 'success')
  const authFailedResults = results.filter(result => result.status === 'authorization_invalid')
  const temporaryFailedResults = results.filter(result => result.status === 'temporary_or_unknown')

  try {
    const updated = await updateSubscriptionsByIds(successResults.map(result => result.subscriber._id), {
      active: false,
      notifiedAt: db.serverDate(),
      noticeUrl: notice.url,
      failedNoticeUrl: '',
      lastFailureType: '',
      lastError: '',
      lastErrCode: null
    })
    if (updated < successResults.length) updateFailed += successResults.length - updated
  } catch (error) {
    updateFailed += successResults.length
    console.error('批量更新重试成功订阅记录失败', { count: successResults.length, error: errorText(error) })
  }

  const failedGroups = [
    ...groupSendResults(authFailedResults, result => `authorization_invalid:${result.errCode}:${result.errorText}`)
      .map(group => ({
        ids: group.ids,
        data: {
          active: false,
          failedAt: db.serverDate(),
          failedNoticeUrl: notice.url,
          lastError: group.sample.errorText,
          lastErrCode: group.sample.errCode,
          lastFailureType: 'authorization_invalid'
        }
      })),
    ...groupSendResults(temporaryFailedResults, result => `temporary_or_unknown:${result.errCode}:${result.errorText}`)
      .map(group => ({
        ids: group.ids,
        data: {
          active: true,
          failedAt: db.serverDate(),
          failedNoticeUrl: notice.url,
          lastError: group.sample.errorText,
          lastErrCode: group.sample.errCode,
          lastFailureType: 'temporary_or_unknown'
        }
      }))
  ]

  for (const group of failedGroups) {
    try {
      const updated = await updateSubscriptionsByIds(group.ids, group.data)
      if (updated < group.ids.length) updateFailed += group.ids.length - updated
    } catch (error) {
      updateFailed += group.ids.length
      console.error('批量更新重试失败订阅记录失败', { count: group.ids.length, error: errorText(error) })
    }
  }

  return updateFailed
}

async function acquireDeliveryTask(notice) {
  const taskId = deliveryTaskId(notice)
  try {
    await db.collection(DELIVERY_TASK_COLLECTION).add({
      data: {
        _id: taskId,
        noticeUrl: notice.url,
        noticeTitle: notice.title,
        noticeDate: notice.date,
        triggerType: 'admin_retry',
        delivery: emptyDelivery(),
        status: 'sending',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
    return { acquired: true, taskId, delivery: emptyDelivery() }
  } catch (error) {
    const existing = await db.collection(DELIVERY_TASK_COLLECTION).doc(taskId).get().catch(() => null)
    if (!existing || !existing.data) throw error
    if (existing.data.status === 'sending') {
      return { acquired: false, taskId, status: existing.data.status, delivery: existing.data.delivery || emptyDelivery() }
    }
    const lockResult = await db.collection(DELIVERY_TASK_COLLECTION).where({
      _id: taskId,
      status: _.neq('sending')
    }).update({
      data: {
        triggerType: 'admin_retry',
        status: 'sending',
        error: '',
        updatedAt: db.serverDate()
      }
    })
    const locked = lockResult && lockResult.stats && lockResult.stats.updated > 0
    return {
      acquired: locked,
      taskId,
      status: locked ? 'sending' : (existing.data.status || 'unknown'),
      delivery: existing.data.delivery || emptyDelivery()
    }
  }
}

async function finishDeliveryTask(taskId, status, delivery, error) {
  await db.collection(DELIVERY_TASK_COLLECTION).doc(taskId).update({
    data: {
      status,
      delivery: delivery || null,
      error: error ? errorText(error) : '',
      updatedAt: db.serverDate(),
      finishedAt: db.serverDate()
    }
  }).catch(updateError => {
    console.error('更新重试任务失败', updateError)
  })
}

async function recordDeliveryAttempt(taskId, attemptId, notice, status, delivery, results, error) {
  await db.collection(DELIVERY_ATTEMPT_COLLECTION).add({
    data: {
      _id: attemptId,
      taskId,
      noticeUrl: notice.url,
      noticeTitle: notice.title,
      noticeDate: notice.date,
      triggerType: 'admin_retry',
      status,
      delivery: delivery || emptyDelivery(),
      total: results.length,
      results: results.map(result => ({
        openid: result.subscriber._openid,
        subscriberId: result.subscriber._id,
        status: result.status,
        errCode: result.errCode || null,
        errorText: result.errorText || ''
      })),
      error: error ? errorText(error) : '',
      createdAt: db.serverDate()
    }
  }).catch(recordError => {
    console.error('写入重试发送明细失败', recordError)
  })
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  if (OPENID !== ADMIN_OPENID) return { ok: false, message: '无权限访问' }

  const state = await db.collection('system_state').doc('score_notice').get().catch(() => null)
  const notice = state && state.data && state.data.latestNotice
  if (!notice || !notice.url) return { ok: false, message: '暂无可重试的成绩公告' }

  const deliveryTask = await acquireDeliveryTask(notice)
  if (!deliveryTask.acquired) {
    return {
      ok: true,
      skipped: true,
      message: '当前公告发送任务仍在执行，请稍后刷新查看结果',
      delivery: { sent: 0, failed: 0, authFailed: 0, updateFailed: 0 },
      taskId: deliveryTask.taskId,
      status: deliveryTask.status
    }
  }

  const delivery = { sent: 0, failed: 0, authFailed: 0, updateFailed: 0 }
  const sendResults = []
  const attemptId = deliveryAttemptId(deliveryTask.taskId)
  let lastId = ''
  try {
    while (true) {
      const condition = {
        active: true,
        status: 'subscribed',
        failedNoticeUrl: notice.url,
        lastFailureType: 'temporary_or_unknown',
        ...(lastId ? { _id: _.gt(lastId) } : {})
      }
      const { data } = await db.collection('subscriptions')
        .where(condition)
        .orderBy('_id', 'asc')
        .limit(100)
        .get()
      if (!data.length) break

      for (const subscriber of data) {
        try {
          await cloud.openapi.subscribeMessage.send({
            touser: subscriber._openid,
            templateId: subscriber.templateId,
            page: 'pages/index/index',
            miniprogramState: 'formal',
            lang: 'zh_CN',
            data: messageData(notice)
          })
          delivery.sent += 1
          sendResults.push({ status: 'success', subscriber })
        } catch (error) {
          delivery.failed += 1
          const isAuthInvalid = isAuthorizationInvalidError(error)
          if (isAuthInvalid) delivery.authFailed += 1
          sendResults.push({
            status: isAuthInvalid ? 'authorization_invalid' : 'temporary_or_unknown',
            subscriber,
            errorText: errorText(error),
            errCode: errorCode(error)
          })
        }
      }
      lastId = data[data.length - 1]._id
      if (data.length < 100) break
    }
    delivery.updateFailed += await flushSendResults(notice, sendResults)
    await recordDeliveryAttempt(deliveryTask.taskId, attemptId, notice, 'finished', delivery, sendResults)
    const mergedDelivery = mergeDelivery(deliveryTask.delivery, delivery)
    await finishDeliveryTask(deliveryTask.taskId, 'finished', mergedDelivery)
    return { ok: true, delivery, taskId: deliveryTask.taskId, attemptId }
  } catch (error) {
    await recordDeliveryAttempt(deliveryTask.taskId, attemptId, notice, 'failed', delivery, sendResults, error)
    await finishDeliveryTask(deliveryTask.taskId, 'failed', mergeDelivery(deliveryTask.delivery, delivery), error)
    throw error
  }
}
