const https = require('https')
const crypto = require('crypto')
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const SOURCE_URLS = [
  'https://www.ruankao.org.cn/index.html',
  'https://www.ruankao.org.cn/index/work.html'
]
const DELIVERY_TASK_COLLECTION = 'notice_delivery_tasks'
const DELIVERY_ATTEMPT_COLLECTION = 'notice_delivery_attempts'
const DELIVERY_QUEUE_COLLECTION = 'notice_delivery_queue'
const DELIVERY_TASK_TIMEOUT_MS = 15 * 60 * 1000
const READ_PAGE_SIZE = 100
const ADMIN_OPENID = 'ouQIY0UogBHEkYzGs9A9BqP7JAL4'
const DB_RETRY_LIMIT = 5

async function appendAutomaticCheckLog(data) {
  try {
    await db.collection('check_logs').add({ data: { ...data, checkedAt: db.serverDate() } })
  } catch (error) {
    console.error('写入自动检查记录失败', error)
  }
}

async function appendManualCheckLog(openid, data) {
  try {
    await db.collection('manual_check_logs').add({
      data: { ...data, userOpenid: openid, checkedAt: db.serverDate() }
    })
  } catch (error) {
    console.error('写入手动查询记录失败', error)
  }
}

function appendCheckLogLater(isAutomatic, openid, data) {
  if (isAutomatic) {
    appendAutomaticCheckLog(data)
    return
  }
  appendManualCheckLog(openid, data)
}

function fetchHtml(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RuankaoScoreNotifier/1.0)' }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 3) {
        response.resume()
        return resolve(fetchHtml(new URL(response.headers.location, url).toString(), redirects + 1))
      }
      if (response.statusCode !== 200) {
        response.resume()
        return reject(new Error(`软考网返回 HTTP ${response.statusCode}`))
      }
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    request.on('timeout', () => request.destroy(new Error('访问软考网超时')))
    request.on('error', reject)
  })
}

function decodeHtml(text) {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim()
}

function parseNotices(html, year) {
  const notices = []
  const anchorPattern = /<a\b([^>]*href=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi
  let match
  while ((match = anchorPattern.exec(html))) {
    const attrs = match[1]
    const titleMatch = attrs.match(/title=["']([^"']+)["']/i)
    const title = decodeHtml(titleMatch ? titleMatch[1] : match[3])
    if (!title.includes(String(year))) continue
    if (!/(成绩.{0,8}(查询|公布|发布)|查询.{0,8}成绩)/.test(title)) continue

    const nearby = html.slice(Math.max(0, match.index - 180), match.index + match[0].length + 80)
    const dateMatch = nearby.match(new RegExp(`${year}[-年/.](\\d{1,2})[-月/.](\\d{1,2})`))
    notices.push({
      title: title.slice(0, 200),
      url: new URL(match[2], 'https://www.ruankao.org.cn/').toString(),
      date: dateMatch ? `${year}-${dateMatch[1].padStart(2, '0')}-${dateMatch[2].padStart(2, '0')}` : `${year}`
    })
  }
  return [...new Map(notices.map(item => [item.url, item])).values()]
    .sort((a, b) => b.date.localeCompare(a.date))
}

function parseAnnouncements(html) {
  const announcements = []
  const itemPattern = /<li\b[^>]*>([\s\S]*?)<\/li>/gi
  let itemMatch
  while ((itemMatch = itemPattern.exec(html))) {
    const item = itemMatch[1]
    const dateMatch = item.match(/(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})/)
    const anchorMatch = item.match(/<a\b([^>]*href=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/a>/i)
    if (!dateMatch || !anchorMatch || !/\/article\/content\//.test(anchorMatch[2])) continue

    const titleMatch = anchorMatch[1].match(/title=["']([^"']+)["']/i)
    const title = decodeHtml(titleMatch ? titleMatch[1] : anchorMatch[3])
    if (!title) continue
    announcements.push({
      title: title.slice(0, 200),
      url: new URL(anchorMatch[2], 'https://www.ruankao.org.cn/').toString(),
      date: `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`
    })
  }
  return [...new Map(announcements.map(item => [item.url, item])).values()]
    .sort((a, b) => b.date.localeCompare(a.date))
}

function messageData(notice) {
  // 模板字段需依次配置为：thing1=通知标题、date2=发布日期、thing3=温馨提示。
  return {
    thing1: { value: notice.title.slice(0, 20) },
    date2: { value: notice.date.length === 10 ? notice.date : new Date().toISOString().slice(0, 10) },
    thing3: { value: '软考成绩查询通知已发布，请及时查询' }
  }
}

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
      console.warn(`${label} 失败，准备重试`, {
        attempt,
        error: errorText(error)
      })
      await sleep(300 * attempt)
    }
  }
  throw lastError
}

function isAuthorizationInvalidError(error) {
  const code = errorCode(error)
  if (code === 43101) return true
  const text = errorText(error).toLowerCase()
  return /user refuse|not subscribe|not accept|subscribe.*expired|没有订阅|未订阅|拒绝/.test(text)
}

function emptyDelivery() {
  return { queued: 0, sent: 0, failed: 0, authFailed: 0, updateFailed: 0 }
}

function mergeDelivery(base, extra) {
  return {
    sent: Number((base && base.sent) || 0) + Number((extra && extra.sent) || 0),
    failed: Number((base && base.failed) || 0) + Number((extra && extra.failed) || 0),
    authFailed: Number((base && base.authFailed) || 0) + Number((extra && extra.authFailed) || 0),
    updateFailed: Number((base && base.updateFailed) || 0) + Number((extra && extra.updateFailed) || 0)
  }
}

function timeoutCutoffDate() {
  return new Date(Date.now() - DELIVERY_TASK_TIMEOUT_MS)
}

function isDeliveryTaskTimedOut(task) {
  if (!task || task.status !== 'sending' || !task.updatedAt) return false
  const updatedAt = new Date(task.updatedAt).getTime()
  return !Number.isNaN(updatedAt) && updatedAt < Date.now() - DELIVERY_TASK_TIMEOUT_MS
}

async function acquireDeliveryTask(notice, triggerType) {
  const taskId = deliveryTaskId(notice)
  try {
    await retryDb(() => db.collection(DELIVERY_TASK_COLLECTION).add({
      data: {
        _id: taskId,
        noticeUrl: notice.url,
        noticeTitle: notice.title,
        noticeDate: notice.date,
        triggerType,
        delivery: emptyDelivery(),
        status: 'sending',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    }), '创建通知发送任务')
    return { acquired: true, taskId, status: 'sending', delivery: emptyDelivery() }
  } catch (error) {
    const existing = await retryDb(() => db.collection(DELIVERY_TASK_COLLECTION).doc(taskId).get(), '读取通知发送任务').catch(() => null)
    if (!existing || !existing.data) throw error
    if (existing.data.status === 'sending') {
      if (!isDeliveryTaskTimedOut(existing.data)) {
        return { acquired: false, taskId, status: existing.data.status, delivery: existing.data.delivery || emptyDelivery(), error: errorText(error) }
      }
      const timeoutResult = await retryDb(() => db.collection(DELIVERY_TASK_COLLECTION).where({
        _id: taskId,
        status: 'sending',
        updatedAt: _.lt(timeoutCutoffDate())
      }).update({
        data: {
          status: 'timeout',
          error: 'delivery_task_timeout',
          timedOutAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      }), '标记超时通知发送任务')
      if (!timeoutResult || !timeoutResult.stats || timeoutResult.stats.updated <= 0) {
        return { acquired: false, taskId, status: 'sending', delivery: existing.data.delivery || emptyDelivery(), error: 'delivery_task_timeout_lock_failed' }
      }
    }
    const lockResult = await retryDb(() => db.collection(DELIVERY_TASK_COLLECTION).where({
      _id: taskId,
      status: _.neq('sending')
    }).update({
      data: {
        triggerType,
        status: 'sending',
        error: '',
        updatedAt: db.serverDate()
      }
    }), '锁定通知发送任务')
    const locked = lockResult && lockResult.stats && lockResult.stats.updated > 0
    return {
      acquired: locked,
      taskId,
      status: locked ? 'sending' : (existing.data.status || 'unknown'),
      delivery: existing.data.delivery || emptyDelivery(),
      error: locked ? '' : 'delivery_task_already_sending'
    }
  }
}

async function finishDeliveryTask(taskId, status, delivery, error) {
  const data = {
    status,
    delivery: delivery || null,
    error: error ? errorText(error) : '',
    updatedAt: db.serverDate(),
    finishedAt: db.serverDate()
  }
  await retryDb(() => db.collection(DELIVERY_TASK_COLLECTION).doc(taskId).update({
    data
  }), '更新通知发送任务').catch(async updateError => {
    console.error('更新通知发送任务失败', updateError)
    const existing = await retryDb(() => db.collection(DELIVERY_TASK_COLLECTION).doc(taskId).get(), '读取兜底通知发送任务')
      .catch(readError => {
        console.error('读取兜底通知发送任务失败', readError)
        return null
      })
    const { _id, ...existingData } = (existing && existing.data) || {}
    const mergedData = {
      ...existingData,
      ...data
    }
    await retryDb(() => db.collection(DELIVERY_TASK_COLLECTION).doc(taskId).set({
      data: mergedData
    }), '兜底写入通知发送任务').catch(setError => {
      console.error('兜底写入通知发送任务失败', setError)
    })
  })
}

async function updateDeliveryTaskProgress(taskId, delivery) {
  await retryDb(() => db.collection(DELIVERY_TASK_COLLECTION).doc(taskId).update({
    data: {
      delivery: delivery || emptyDelivery(),
      updatedAt: db.serverDate()
    }
  }), '更新通知发送任务进度').catch(updateError => {
    console.error('更新通知发送任务进度失败', updateError)
  })
}

async function recordDeliveryAttempt(taskId, attemptId, notice, triggerType, status, delivery, results, error) {
  await retryDb(() => db.collection(DELIVERY_ATTEMPT_COLLECTION).add({
    data: {
      _id: attemptId,
      taskId,
      noticeUrl: notice.url,
      noticeTitle: notice.title,
      noticeDate: notice.date,
      triggerType,
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
  }), '写入通知发送明细').catch(recordError => {
    console.error('写入通知发送明细失败', recordError)
  })
}

async function updateScoreNoticeState(data) {
  try {
    await retryDb(() => db.collection('system_state').doc('score_notice').set({ data }), '写入成绩通知状态')
  } catch (error) {
    console.error('写入成绩通知状态失败', error)
  }
}

async function updateScoreNoticeError(data) {
  try {
    await retryDb(() => db.collection('system_state').doc('score_notice').update({ data }), '更新成绩通知错误状态')
  } catch (error) {
    try {
      await retryDb(() => db.collection('system_state').doc('score_notice').set({ data }), '兜底写入成绩通知错误状态')
    } catch (setError) {
      console.error('写入成绩通知错误状态失败', setError)
    }
  }
}

async function enqueueSubscribers(notice, taskId, triggerType, extraCondition = {}) {
  const delivery = emptyDelivery()
  let lastId = ''
  while (true) {
    const condition = {
      active: true,
      status: 'subscribed',
      ...extraCondition,
      ...(lastId ? { _id: _.gt(lastId) } : {})
    }
    const { data } = await retryDb(() => db.collection('subscriptions')
      .where(condition)
      .orderBy('_id', 'asc')
      .limit(READ_PAGE_SIZE)
      .get(), '读取待入队订阅用户')
      .catch(error => {
        console.error('读取待入队订阅用户失败，停止继续查询', error)
        return { data: [] }
      })
    if (!data.length) break

    for (const subscriber of data) {
      lastId = subscriber._id
      try {
        await retryDb(() => db.collection(DELIVERY_QUEUE_COLLECTION).add({
          data: {
            _id: `${taskId}_${subscriber._id}`,
            taskId,
            noticeUrl: notice.url,
            noticeTitle: notice.title,
            noticeDate: notice.date,
            triggerType,
            subscriberId: subscriber._id,
            openid: subscriber._openid,
            templateId: subscriber.templateId,
            status: 'pending',
            attempts: 0,
            createdAt: db.serverDate(),
            updatedAt: db.serverDate()
          }
        }), '创建通知发送队列')
        delivery.queued += 1
      } catch (error) {
        delivery.updateFailed += 1
        console.error('创建通知发送队列失败，继续处理下一个用户', {
          subscriberId: subscriber._id,
          error: errorText(error)
        })
      }
    }
    await updateDeliveryTaskProgress(taskId, delivery)
    if (data.length < READ_PAGE_SIZE) break
  }
  return delivery
}

async function sendToSubscriber(subscriber, notice) {
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: subscriber._openid,
      templateId: subscriber.templateId,
      page: 'pages/index/index',
      miniprogramState: 'formal',
      lang: 'zh_CN',
      data: messageData(notice)
    })
    return { status: 'success', subscriber }
  } catch (error) {
    const isAuthInvalid = isAuthorizationInvalidError(error)
    return {
      status: isAuthInvalid ? 'authorization_invalid' : 'temporary_or_unknown',
      subscriber,
      errorText: errorText(error),
      errCode: errorCode(error)
    }
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

async function updateSubscriptionAfterSend(notice, result) {
  const subscriberId = result && result.subscriber && result.subscriber._id
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

async function notifySubscribers(notice, taskId, attemptId, triggerType, progressBaseDelivery = emptyDelivery(), extraCondition = {}) {
  const delivery = emptyDelivery()
  let attemptIndex = 0
  let lastId = ''
  const attemptResults = []
  while (true) {
    const condition = {
      active: true,
      status: 'subscribed',
      ...extraCondition,
      ...(lastId ? { _id: _.gt(lastId) } : {})
    }
    const query = db.collection('subscriptions').where(condition)
    const { data } = await retryDb(() => query.orderBy('_id', 'asc').limit(READ_PAGE_SIZE).get(), '读取待发送订阅用户')
    if (!data.length) break
    for (const subscriber of data) {
      lastId = subscriber._id
      attemptIndex += 1
      const result = await sendToSubscriber(subscriber, notice)
      addResultToDelivery(delivery, result)

      const updated = await updateSubscriptionAfterSend(notice, result)
      if (!updated) {
        delivery.updateFailed += 1
      }

      attemptResults.push(result)
      if (attemptIndex % PROGRESS_UPDATE_INTERVAL === 0) {
        await updateDeliveryTaskProgress(taskId, mergeDelivery(progressBaseDelivery, delivery))
      }
    }
    if (data.length < READ_PAGE_SIZE) break
  }

  if (attemptResults.length) {
    await recordDeliveryAttempt(taskId, attemptId, notice, triggerType, 'finished', delivery, attemptResults)
  }
  return delivery
}

async function hasSendableSubscribers() {
  const { data } = await retryDb(() => db.collection('subscriptions').where({
    active: true,
    status: 'subscribed'
  }).limit(1).get(), '读取可发送订阅用户')
  return data.length > 0
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  const isAdminCheck = event && event.action === 'adminCheck'
  const isAutomatic = !OPENID
  const startedAt = Date.now()
  if (isAdminCheck && OPENID !== ADMIN_OPENID) {
    return { ok: false, message: '无权限访问' }
  }
  // 有 OPENID 表示由小程序手动调用；定时触发器没有用户 OPENID。
  if (OPENID && !isAdminCheck) {
    const subscriber = await retryDb(() => db.collection('subscriptions').doc(OPENID).get(), '读取手动查询订阅用户').catch(() => null)
    if (!subscriber || !subscriber.data) {
      appendCheckLogLater(false, OPENID, {
        success: false,
        found: false,
        latestNotice: null,
        latestAnnouncement: null,
        delivery: null,
        durationMs: Date.now() - startedAt,
        error: '请先订阅提醒'
      })
      return { ok: false, message: '请先订阅提醒' }
    }

    const lastManualCheckAt = subscriber.data.lastManualCheckAt
    if (lastManualCheckAt && Date.now() - new Date(lastManualCheckAt).getTime() < 60000) {
      appendCheckLogLater(false, OPENID, {
        success: false,
        found: false,
        latestNotice: null,
        latestAnnouncement: null,
        delivery: null,
        durationMs: Date.now() - startedAt,
        error: '查询太频繁，请一分钟后再试'
      })
      return { ok: false, message: '查询太频繁，请一分钟后再试' }
    }
    try {
      await retryDb(() => db.collection('subscriptions').doc(OPENID).update({
        data: { lastManualCheckAt: db.serverDate() }
      }), '更新手动查询时间')
    } catch (error) {
      appendCheckLogLater(false, OPENID, {
        success: false,
        found: false,
        latestNotice: null,
        latestAnnouncement: null,
        delivery: null,
        durationMs: Date.now() - startedAt,
        error: String(error.message || error).slice(0, 500)
      })
      throw error
    }
  }

  const year = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric' }).format(new Date()))
  try {
    const pages = await Promise.allSettled(SOURCE_URLS.map(fetchHtml))
    if (!pages.some(result => result.status === 'fulfilled')) {
      throw new Error(`软考网页面均访问失败：${pages.map(result => result.reason && result.reason.message).join('；')}`)
    }
    const notices = pages.flatMap(result => result.status === 'fulfilled' ? parseNotices(result.value, year) : [])
    const latest = notices.sort((a, b) => b.date.localeCompare(a.date))[0] || null
    const announcements = pages.flatMap(result => result.status === 'fulfilled' ? parseAnnouncements(result.value) : [])
    const latestAnnouncement = announcements.sort((a, b) => b.date.localeCompare(a.date))[0] || null
    if (isAdminCheck && !latest) {
      return { ok: false, message: '暂无成绩公告可检查' }
    }
    const previous = await retryDb(() => db.collection('system_state').doc('score_notice').get(), '读取成绩通知状态').catch(() => null)
    let delivery = null

    const hasSubscribers = latest ? await hasSendableSubscribers() : false
    if (isAdminCheck && !hasSubscribers) {
      return { ok: false, message: '暂无可发送用户' }
    }

    if (latest && hasSubscribers) {
      const triggerType = isAdminCheck ? 'admin_check' : (isAutomatic ? 'automatic' : 'manual')
      const deliveryTask = await acquireDeliveryTask(latest, triggerType)
      if (deliveryTask.acquired) {
        const attemptId = deliveryAttemptId(deliveryTask.taskId)
        try {
          delivery = await enqueueSubscribers(latest, deliveryTask.taskId, triggerType)
          delivery.taskId = deliveryTask.taskId
          await updateDeliveryTaskProgress(deliveryTask.taskId, mergeDelivery(deliveryTask.delivery, delivery))
        } catch (notifyError) {
          await recordDeliveryAttempt(deliveryTask.taskId, `${attemptId}_failed`, latest, triggerType, 'failed', delivery || emptyDelivery(), [], notifyError)
          await finishDeliveryTask(deliveryTask.taskId, 'failed', deliveryTask.delivery || emptyDelivery(), notifyError)
        }
      } else {
        delivery = {
          sent: 0,
          failed: 0,
          authFailed: 0,
          updateFailed: 0,
          skipped: true,
          reason: 'notice_delivery_task_sending',
          taskId: deliveryTask.taskId,
          status: deliveryTask.status || 'unknown'
        }
      }
    }

    await updateScoreNoticeState({
      lastCheckedAt: db.serverDate(),
      latestNotice: latest,
      latestAnnouncement,
      lastError: '',
      lastDelivery: delivery || (previous && previous.data && previous.data.lastDelivery) || null
    })
    appendCheckLogLater(isAutomatic, OPENID, {
      success: true,
      found: Boolean(latest),
      latestNotice: latest,
      latestAnnouncement,
      delivery,
      durationMs: Date.now() - startedAt,
      error: ''
    })
    return { ok: true, found: Boolean(latest), latest, latestAnnouncement, delivery }
  } catch (error) {
    const errorState = { lastCheckedAt: db.serverDate(), lastError: String(error.message || error).slice(0, 500) }
    // 更新失败时保留上一条通知，避免网络恢复后将同一通知误判为新通知并重复发送。
    await updateScoreNoticeError(errorState)
    appendCheckLogLater(isAutomatic, OPENID, {
      success: false,
      found: false,
      latestNotice: null,
      latestAnnouncement: null,
      delivery: null,
      durationMs: Date.now() - startedAt,
      error: String(error.message || error).slice(0, 500)
    })
    return {
      ok: false,
      found: false,
      latest: null,
      latestAnnouncement: null,
      delivery: null,
      message: String(error.message || error).slice(0, 500)
    }
  }
}
