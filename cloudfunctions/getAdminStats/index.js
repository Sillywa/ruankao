const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const ADMIN_OPENID = 'ouQIY0UogBHEkYzGs9A9BqP7JAL4'
const PAGE_SIZE = 100
const RECENT_LIMIT = 20

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
    sent: toNumber(delivery.sent),
    failed: toNumber(delivery.failed),
    authFailed: toNumber(delivery.authFailed),
    updateFailed: toNumber(delivery.updateFailed),
    createdAt: formatDate(task.createdAt),
    finishedAt: formatDate(task.finishedAt || task.updatedAt)
  }
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  if (OPENID !== ADMIN_OPENID) {
    return { ok: false, message: '无权限访问' }
  }

  const countResult = await db.collection('notice_delivery_tasks').count()
  const total = countResult.total || 0
  const stats = {
    totalTasks: total,
    finishedTasks: 0,
    failedTasks: 0,
    sendingTasks: 0,
    totalSent: 0,
    totalFailed: 0,
    totalAuthFailed: 0,
    totalUpdateFailed: 0
  }

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
    const delivery = deliveryOf(task)
    stats.totalSent += toNumber(delivery.sent)
    stats.totalFailed += toNumber(delivery.failed)
    stats.totalAuthFailed += toNumber(delivery.authFailed)
    stats.totalUpdateFailed += toNumber(delivery.updateFailed)
  }

  return {
    ok: true,
    stats,
    recentTasks: tasks.slice(0, RECENT_LIMIT).map(normalizeTask)
  }
}
