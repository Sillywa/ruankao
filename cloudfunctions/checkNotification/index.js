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
const DELIVERY_TASK_TIMEOUT_MS = 15 * 60 * 1000

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

function isAuthorizationInvalidError(error) {
  const code = errorCode(error)
  if (code === 43101) return true
  const text = errorText(error).toLowerCase()
  return /user refuse|not subscribe|not accept|subscribe.*expired|没有订阅|未订阅|拒绝/.test(text)
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

function timeoutCutoffDate() {
  return new Date(Date.now() - DELIVERY_TASK_TIMEOUT_MS)
}

function isDeliveryTaskTimedOut(task) {
  if (!task || task.status !== 'sending' || !task.updatedAt) return false
  const updatedAt = new Date(task.updatedAt).getTime()
  return !Number.isNaN(updatedAt) && updatedAt < Date.now() - DELIVERY_TASK_TIMEOUT_MS
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
    const result = await db.collection('subscriptions').where({
      _id: _.in(chunk)
    }).update({ data })
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
    const expected = successResults.length
    const updated = await updateSubscriptionsByIds(successResults.map(result => result.subscriber._id), {
      active: false,
      notifiedAt: db.serverDate(),
      noticeUrl: notice.url,
      failedNoticeUrl: '',
      lastFailureType: '',
      lastError: '',
      lastErrCode: null
    })
    if (updated < expected) updateFailed += expected - updated
  } catch (error) {
    updateFailed += successResults.length
    console.error('批量更新发送成功订阅记录失败', {
      count: successResults.length,
      error: errorText(error)
    })
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
      console.error('批量更新发送失败订阅记录失败', {
        count: group.ids.length,
        error: errorText(error)
      })
    }
  }

  return updateFailed
}

async function acquireDeliveryTask(notice, triggerType) {
  const taskId = deliveryTaskId(notice)
  try {
    await db.collection(DELIVERY_TASK_COLLECTION).add({
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
    })
    return { acquired: true, taskId, status: 'sending', delivery: emptyDelivery() }
  } catch (error) {
    const existing = await db.collection(DELIVERY_TASK_COLLECTION).doc(taskId).get().catch(() => null)
    if (!existing || !existing.data) throw error
    if (existing.data.status === 'sending') {
      if (!isDeliveryTaskTimedOut(existing.data)) {
        return { acquired: false, taskId, status: existing.data.status, delivery: existing.data.delivery || emptyDelivery(), error: errorText(error) }
      }
      const timeoutResult = await db.collection(DELIVERY_TASK_COLLECTION).where({
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
      })
      if (!timeoutResult || !timeoutResult.stats || timeoutResult.stats.updated <= 0) {
        return { acquired: false, taskId, status: 'sending', delivery: existing.data.delivery || emptyDelivery(), error: 'delivery_task_timeout_lock_failed' }
      }
    }
    const lockResult = await db.collection(DELIVERY_TASK_COLLECTION).where({
      _id: taskId,
      status: _.neq('sending')
    }).update({
      data: {
        triggerType,
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
      delivery: existing.data.delivery || emptyDelivery(),
      error: locked ? '' : 'delivery_task_already_sending'
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
    console.error('更新通知发送任务失败', updateError)
  })
}

async function recordDeliveryAttempt(taskId, attemptId, notice, triggerType, status, delivery, results, error) {
  await db.collection(DELIVERY_ATTEMPT_COLLECTION).add({
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
  }).catch(recordError => {
    console.error('写入通知发送明细失败', recordError)
  })
}

async function migrateLegacySubscriptions() {
  while (true) {
    const { data } = await db.collection('subscriptions')
      .where({ status: _.exists(false) })
      .limit(100)
      .get()
    if (!data.length) break
    await Promise.all(data.map(item => db.collection('subscriptions').doc(item._id).update({
      data: { status: 'subscribed' }
    })))
    if (data.length < 100) break
  }
}

async function notifySubscribers(notice, taskId, attemptId, triggerType, extraCondition = {}) {
  await migrateLegacySubscriptions()
  let sent = 0
  let failed = 0
  let authFailed = 0
  let updateFailed = 0
  const sendResults = []
  let lastId = ''
  while (true) {
    const condition = {
      active: true,
      status: 'subscribed',
      ...extraCondition,
      ...(lastId ? { _id: _.gt(lastId) } : {})
    }
    const query = db.collection('subscriptions').where(condition)
    const { data } = await query.orderBy('_id', 'asc').limit(100).get()
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
        sent += 1
        sendResults.push({ status: 'success', subscriber })
      } catch (error) {
        failed += 1
        const isAuthInvalid = isAuthorizationInvalidError(error)
        if (isAuthInvalid) authFailed += 1
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
  const delivery = { sent, failed, authFailed, updateFailed }
  try {
    delivery.updateFailed += await flushSendResults(notice, sendResults)
    await recordDeliveryAttempt(taskId, attemptId, notice, triggerType, 'finished', delivery, sendResults)
    return delivery
  } catch (error) {
    await recordDeliveryAttempt(taskId, attemptId, notice, triggerType, 'failed', delivery, sendResults, error)
    throw error
  }
}

async function hasSendableSubscribers() {
  const { data } = await db.collection('subscriptions').where({
    active: true,
    status: 'subscribed'
  }).limit(1).get()
  return data.length > 0
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  const isAutomatic = !OPENID
  const startedAt = Date.now()
  // 有 OPENID 表示由小程序手动调用；定时触发器没有用户 OPENID。
  if (OPENID) {
    const subscriber = await db.collection('subscriptions').doc(OPENID).get().catch(() => null)
    if (!subscriber || !subscriber.data) {
      await appendManualCheckLog(OPENID, {
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
      await appendManualCheckLog(OPENID, {
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
      await db.collection('subscriptions').doc(OPENID).update({
        data: { lastManualCheckAt: db.serverDate() }
      })
    } catch (error) {
      await appendManualCheckLog(OPENID, {
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
    const previous = await db.collection('system_state').doc('score_notice').get().catch(() => null)
    const previousUrl = previous && previous.data && previous.data.latestNotice && previous.data.latestNotice.url
    let delivery = null

    if (latest && (latest.url !== previousUrl || await hasSendableSubscribers())) {
      const triggerType = isAutomatic ? 'automatic' : 'manual'
      const deliveryTask = await acquireDeliveryTask(latest, triggerType)
      if (deliveryTask.acquired) {
        const attemptId = deliveryAttemptId(deliveryTask.taskId)
        try {
          delivery = await notifySubscribers(latest, deliveryTask.taskId, attemptId, triggerType)
          await finishDeliveryTask(deliveryTask.taskId, 'finished', mergeDelivery(deliveryTask.delivery, delivery))
        } catch (notifyError) {
          await finishDeliveryTask(deliveryTask.taskId, 'failed', deliveryTask.delivery || emptyDelivery(), notifyError)
          throw notifyError
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

    await db.collection('system_state').doc('score_notice').set({
      data: {
        lastCheckedAt: db.serverDate(),
        latestNotice: latest,
        latestAnnouncement,
        lastError: '',
        lastDelivery: delivery || (previous && previous.data && previous.data.lastDelivery) || null
      }
    })
    if (isAutomatic) {
      await appendAutomaticCheckLog({
        success: true,
        found: Boolean(latest),
        latestNotice: latest,
        latestAnnouncement,
        delivery,
        durationMs: Date.now() - startedAt,
        error: ''
      })
    } else {
      await appendManualCheckLog(OPENID, {
        success: true,
        found: Boolean(latest),
        latestNotice: latest,
        latestAnnouncement,
        delivery,
        durationMs: Date.now() - startedAt,
        error: ''
      })
    }
    return { ok: true, found: Boolean(latest), latest, latestAnnouncement, delivery }
  } catch (error) {
    const errorState = { lastCheckedAt: db.serverDate(), lastError: String(error.message || error).slice(0, 500) }
    // 更新失败时保留上一条通知，避免网络恢复后将同一通知误判为新通知并重复发送。
    await db.collection('system_state').doc('score_notice').update({ data: errorState })
      .catch(() => db.collection('system_state').doc('score_notice').set({ data: errorState }))
    if (isAutomatic) {
      await appendAutomaticCheckLog({
        success: false,
        found: false,
        latestNotice: null,
        latestAnnouncement: null,
        delivery: null,
        durationMs: Date.now() - startedAt,
        error: String(error.message || error).slice(0, 500)
      })
    } else {
      await appendManualCheckLog(OPENID, {
        success: false,
        found: false,
        latestNotice: null,
        latestAnnouncement: null,
        delivery: null,
        durationMs: Date.now() - startedAt,
        error: String(error.message || error).slice(0, 500)
      })
    }
    throw error
  }
}
