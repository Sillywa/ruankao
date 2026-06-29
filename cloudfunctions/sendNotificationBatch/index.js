const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const ADMIN_OPENID = 'ouQIY0UogBHEkYzGs9A9BqP7JAL4'
const DELIVERY_TASK_COLLECTION = 'notice_delivery_tasks'
const DELIVERY_ATTEMPT_COLLECTION = 'notice_delivery_attempts'
const DELIVERY_QUEUE_COLLECTION = 'notice_delivery_queue'
const BATCH_SIZE = 10
const DB_RETRY_LIMIT = 5

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRetriableDbError(error) {
  const code = errorCode(error)
  const text = errorText(error).toLowerCase()
  return code === -501001 || /resource system error|internal server error|500/.test(text)
}

async function retryDb(operation, label) {
  let lastError
  for (let attempt = 1; attempt <= DB_RETRY_LIMIT; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isRetriableDbError(error) || attempt >= DB_RETRY_LIMIT) break
      console.warn(`${label} 失败，准备重试`, { attempt, error: errorText(error) })
      await sleep(300 * attempt)
    }
  }
  throw lastError
}

function emptyDelivery() {
  return { queued: 0, sent: 0, failed: 0, authFailed: 0, updateFailed: 0 }
}

function mergeDelivery(base, extra) {
  return {
    queued: Number((base && base.queued) || 0) + Number((extra && extra.queued) || 0),
    sent: Number((base && base.sent) || 0) + Number((extra && extra.sent) || 0),
    failed: Number((base && base.failed) || 0) + Number((extra && extra.failed) || 0),
    authFailed: Number((base && base.authFailed) || 0) + Number((extra && extra.authFailed) || 0),
    updateFailed: Number((base && base.updateFailed) || 0) + Number((extra && extra.updateFailed) || 0)
  }
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

function addResultToDelivery(delivery, result) {
  if (result.status === 'success') {
    delivery.sent += 1
    return
  }
  delivery.failed += 1
  if (result.status === 'authorization_invalid') delivery.authFailed += 1
}

async function sendQueueItem(item, notice) {
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: item.openid,
      templateId: item.templateId,
      page: 'pages/index/index',
      miniprogramState: 'formal',
      lang: 'zh_CN',
      data: messageData(notice)
    })
    return { status: 'success', item }
  } catch (error) {
    const isAuthInvalid = isAuthorizationInvalidError(error)
    return {
      status: isAuthInvalid ? 'authorization_invalid' : 'temporary_or_unknown',
      item,
      errorText: errorText(error),
      errCode: errorCode(error)
    }
  }
}

async function updateSubscriptionAfterSend(notice, result) {
  const subscriberId = result && result.item && result.item.subscriberId
  if (!subscriberId) return false

  let data
  if (result.status === 'success') {
    data = {
      active: false,
      notifiedAt: db.serverDate(),
      noticeUrl: notice.url,
      failedNoticeUrl: '',
      lastFailureType: '',
      lastError: '',
      lastErrCode: null
    }
  } else if (result.status === 'authorization_invalid') {
    data = {
      active: true,
      failedAt: db.serverDate(),
      failedNoticeUrl: notice.url,
      lastError: result.errorText || '',
      lastErrCode: result.errCode || null,
      lastFailureType: 'authorization_invalid'
    }
  } else {
    data = {
      active: true,
      failedAt: db.serverDate(),
      failedNoticeUrl: notice.url,
      lastError: result.errorText || '',
      lastErrCode: result.errCode || null,
      lastFailureType: 'temporary_or_unknown'
    }
  }

  try {
    await retryDb(() => db.collection('subscriptions').doc(subscriberId).update({ data }), '更新单个订阅发送结果')
    return true
  } catch (error) {
    console.error('更新单个订阅发送结果失败，继续处理下一个用户', {
      subscriberId,
      error: errorText(error)
    })
    return false
  }
}

async function removeQueueItem(item) {
  try {
    await retryDb(() => db.collection(DELIVERY_QUEUE_COLLECTION).doc(item._id).remove(), '删除已处理发送队列')
    return true
  } catch (error) {
    console.error('删除已处理发送队列失败，继续处理下一个用户', {
      queueId: item._id,
      error: errorText(error)
    })
    return false
  }
}

async function recordDeliveryAttempt(task, attemptId, delivery, results, error) {
  await retryDb(() => db.collection(DELIVERY_ATTEMPT_COLLECTION).add({
    data: {
      _id: attemptId,
      taskId: task._id,
      noticeUrl: task.noticeUrl,
      noticeTitle: task.noticeTitle,
      noticeDate: task.noticeDate,
      triggerType: task.triggerType || '',
      status: error ? 'failed' : 'finished',
      delivery,
      total: results.length,
      results: results.map(result => ({
        openid: result.item.openid,
        subscriberId: result.item.subscriberId,
        status: result.status,
        errCode: result.errCode || null,
        errorText: result.errorText || ''
      })),
      error: error ? errorText(error) : '',
      createdAt: db.serverDate()
    }
  }), '写入通知发送明细').catch(recordError => {
    console.error('写入通知发送明细失败', recordError)
  })
}

async function updateTask(taskId, data) {
  await retryDb(() => db.collection(DELIVERY_TASK_COLLECTION).doc(taskId).update({ data }), '更新通知发送任务')
    .catch(error => console.error('更新通知发送任务失败', error))
}

async function finishTaskIfDone(task, delivery) {
  const remaining = await retryDb(() => db.collection(DELIVERY_QUEUE_COLLECTION).where({
    taskId: task._id
  }).count(), '统计待发送队列').catch(() => ({ total: 1 }))

  const data = {
    delivery,
    updatedAt: db.serverDate()
  }
  if (!remaining.total) {
    data.status = 'finished'
    data.finishedAt = db.serverDate()
    data.error = ''
  }
  await updateTask(task._id, data)
  return !remaining.total
}

async function getTask(taskId) {
  if (taskId) {
    const task = await retryDb(() => db.collection(DELIVERY_TASK_COLLECTION).doc(taskId).get(), '读取通知发送任务')
      .catch(() => null)
    return task && task.data
  }
  const { data } = await retryDb(() => db.collection(DELIVERY_TASK_COLLECTION)
    .where({ status: 'sending' })
    .orderBy('createdAt', 'asc')
    .limit(1)
    .get(), '读取最新发送任务')
    .catch(() => ({ data: [] }))
  return data[0] || null
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (OPENID && OPENID !== ADMIN_OPENID) return { ok: false, message: '无权限访问' }

  const task = await getTask(event.taskId)
  if (!task || !task._id) return { ok: false, message: '暂无发送任务' }

  const { data: items } = await retryDb(() => db.collection(DELIVERY_QUEUE_COLLECTION)
    .where({ taskId: task._id })
    .orderBy('createdAt', 'asc')
    .limit(BATCH_SIZE)
    .get(), '读取待发送队列')
    .catch(error => {
      console.error('读取待发送队列失败', error)
      return { data: [] }
    })

  if (!items.length) {
    const finished = await finishTaskIfDone(task, task.delivery || emptyDelivery())
    return { ok: true, taskId: task._id, processed: 0, hasMore: !finished, delivery: task.delivery || emptyDelivery() }
  }

  const batchDelivery = emptyDelivery()
  const results = []
  const notice = { title: task.noticeTitle, date: task.noticeDate, url: task.noticeUrl }

  for (const item of items) {
    const result = await sendQueueItem(item, notice)
    addResultToDelivery(batchDelivery, result)

    const subscriptionUpdated = await updateSubscriptionAfterSend(notice, result)
    if (!subscriptionUpdated) batchDelivery.updateFailed += 1

    const queueRemoved = await removeQueueItem(item)
    if (!queueRemoved) batchDelivery.updateFailed += 1

    results.push(result)
  }

  const mergedDelivery = mergeDelivery(task.delivery || emptyDelivery(), batchDelivery)
  const attemptId = `${task._id}_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`
  await recordDeliveryAttempt(task, attemptId, batchDelivery, results)
  const finished = await finishTaskIfDone(task, mergedDelivery)

  return {
    ok: true,
    taskId: task._id,
    processed: results.length,
    hasMore: !finished,
    delivery: mergedDelivery
  }
}
