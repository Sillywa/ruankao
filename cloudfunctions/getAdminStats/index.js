const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const ADMIN_OPENID = 'ouQIY0UogBHEkYzGs9A9BqP7JAL4'
const PAGE_SIZE = 100
const RECENT_LIMIT = 20
const RECENT_ATTEMPT_LIMIT = 20
const DELIVERY_TASK_TIMEOUT_MS = 15 * 60 * 1000

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const shanghai = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const pad = number => String(number).padStart(2, '0')
  return `${shanghai.getUTCFullYear()}-${pad(shanghai.getUTCMonth() + 1)}-${pad(shanghai.getUTCDate())} ${pad(shanghai.getUTCHours())}:${pad(shanghai.getUTCMinutes())}`
}

function deliveryOf(task) {
  return task && task.delivery ? task.delivery : {}
}

function toNumber(value) {
  return Number(value || 0)
}

function normalizeTask(task) {
  const delivery = deliveryOf(task)
  return {
    _id: task._id,
    noticeTitle: task.noticeTitle || '',
    noticeUrl: task.noticeUrl || '',
    noticeDate: task.noticeDate || '',
    triggerType: task.triggerType || '',
    status: task.status || '',
    queued: toNumber(delivery.queued),
    sent: toNumber(delivery.sent),
    failed: toNumber(delivery.failed),
    authFailed: toNumber(delivery.authFailed),
    updateFailed: toNumber(delivery.updateFailed),
    createdAt: formatDate(task.createdAt),
    finishedAt: formatDate(task.finishedAt || task.updatedAt)
  }
}

function maskOpenid(openid) {
  if (!openid) return ''
  if (openid.length <= 12) return openid
  return `${openid.slice(0, 6)}...${openid.slice(-6)}`
}

function normalizeAttempt(attempt) {
  const delivery = deliveryOf(attempt)
  return {
    _id: attempt._id,
    taskId: attempt.taskId || '',
    noticeTitle: attempt.noticeTitle || '',
    noticeUrl: attempt.noticeUrl || '',
    noticeDate: attempt.noticeDate || '',
    triggerType: attempt.triggerType || '',
    status: attempt.status || '',
    total: toNumber(attempt.total),
    sent: toNumber(delivery.sent),
    failed: toNumber(delivery.failed),
    authFailed: toNumber(delivery.authFailed),
    updateFailed: toNumber(delivery.updateFailed),
    error: attempt.error || '',
    createdAt: formatDate(attempt.createdAt),
    results: (attempt.results || []).map(result => ({
      openid: maskOpenid(result.openid),
      subscriberId: result.subscriberId || '',
      status: result.status || '',
      errCode: result.errCode || null,
      errorText: result.errorText || ''
    }))
  }
}

function resultUserKey(result) {
  return result.subscriberId || result.openid || ''
}

async function markStaleSendingTasks() {
  await db.collection('notice_delivery_tasks').where({
    status: 'sending',
    updatedAt: _.lt(new Date(Date.now() - DELIVERY_TASK_TIMEOUT_MS))
  }).update({
    data: {
      status: 'timeout',
      error: 'delivery_task_timeout',
      timedOutAt: db.serverDate(),
      updatedAt: db.serverDate()
    }
  }).catch(error => {
    console.error('标记超时发送任务失败', error)
  })
}

async function listAttempts(offset = 0, limit = RECENT_ATTEMPT_LIMIT) {
  const safeOffset = Math.max(0, Number(offset || 0))
  const safeLimit = Math.min(50, Math.max(1, Number(limit || RECENT_ATTEMPT_LIMIT)))
  const [countResult, page] = await Promise.all([
    db.collection('notice_delivery_attempts').count().catch(() => ({ total: 0 })),
    db.collection('notice_delivery_attempts')
      .orderBy('createdAt', 'desc')
      .skip(safeOffset)
      .limit(safeLimit)
      .get()
  ])
  const total = countResult.total || 0
  const attempts = (page.data || []).map(normalizeAttempt)
  return {
    attempts,
    hasMore: safeOffset + attempts.length < total,
    nextOffset: safeOffset + attempts.length,
    total
  }
}

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext()
  if (OPENID !== ADMIN_OPENID) {
    return { ok: false, message: '无权限访问' }
  }

  if (event.action === 'listAttempts') {
    const page = await listAttempts(event.offset, event.limit)
    return { ok: true, ...page }
  }

  await markStaleSendingTasks()

  const countResult = await db.collection('notice_delivery_tasks').count()
  const total = countResult.total || 0
  const subscriberCountResult = await db.collection('subscriptions')
    .where({ status: 'subscribed' })
    .count()
    .catch(() => ({ total: 0 }))
  const activeSubscriberCountResult = await db.collection('subscriptions')
    .where({ status: 'subscribed', active: true })
    .count()
    .catch(() => ({ total: 0 }))
  const stats = {
    totalSubscribers: subscriberCountResult.total || 0,
    activeSubscribers: activeSubscriberCountResult.total || 0,
    totalTasks: total,
    finishedTasks: 0,
    failedTasks: 0,
    sendingTasks: 0,
    timeoutTasks: 0,
    totalAttempts: 0,
    queueTotal: 0,
    queuePending: 0,
    queueProcessing: 0,
    queueDone: 0,
    totalSent: 0,
    totalFailed: 0,
    totalAuthFailed: 0,
    totalUpdateFailed: 0
  }

  const queueCountResult = await db.collection('notice_delivery_queue').count().catch(() => ({ total: 0 }))
  stats.queueTotal = queueCountResult.total || 0
  stats.queuePending = stats.queueTotal
  stats.queueProcessing = 0
  stats.queueDone = 0

  const batches = []
  for (let offset = 0; offset < total; offset += PAGE_SIZE) {
    batches.push(
      db.collection('notice_delivery_tasks')
        .orderBy('createdAt', 'desc')
        .skip(offset)
        .limit(PAGE_SIZE)
        .get()
    )
  }

  const pages = await Promise.all(batches)
  const tasks = pages.flatMap(page => page.data || [])
  for (const task of tasks) {
    if (task.status === 'finished') stats.finishedTasks += 1
    if (task.status === 'failed') stats.failedTasks += 1
    if (task.status === 'sending') stats.sendingTasks += 1
    if (task.status === 'timeout') stats.timeoutTasks += 1
  }

  const attemptCountResult = await db.collection('notice_delivery_attempts').count().catch(() => ({ total: 0 }))
  const attemptTotal = attemptCountResult.total || 0
  stats.totalAttempts = attemptTotal
  const attemptBatches = []
  for (let offset = 0; offset < attemptTotal; offset += PAGE_SIZE) {
    attemptBatches.push(
      db.collection('notice_delivery_attempts')
        .orderBy('createdAt', 'desc')
        .skip(offset)
        .limit(PAGE_SIZE)
        .get()
    )
  }

  const attemptPages = attemptBatches.length ? await Promise.all(attemptBatches) : []
  const attempts = attemptPages.flatMap(page => page.data || [])
  for (const attempt of attempts) {
    const delivery = deliveryOf(attempt)
    stats.totalUpdateFailed += toNumber(delivery.updateFailed)
  }

  const latestResultByUser = new Map()
  for (const attempt of attempts) {
    for (const result of attempt.results || []) {
      const key = resultUserKey(result)
      if (!key || latestResultByUser.has(key)) continue
      latestResultByUser.set(key, result.status || '')
    }
  }
  for (const status of latestResultByUser.values()) {
    if (status === 'success') stats.totalSent += 1
    if (status && status !== 'success') stats.totalFailed += 1
    if (status === 'authorization_invalid') stats.totalAuthFailed += 1
  }

  return {
    ok: true,
    stats,
    recentTasks: tasks.slice(0, RECENT_LIMIT).map(normalizeTask),
    recentAttempts: attempts.slice(0, RECENT_ATTEMPT_LIMIT).map(normalizeAttempt),
    hasMoreAttempts: RECENT_ATTEMPT_LIMIT < attemptTotal,
    nextAttemptOffset: Math.min(RECENT_ATTEMPT_LIMIT, attemptTotal)
  }
}
