const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const ADMIN_OPENID = 'ouQIY0UogBHEkYzGs9A9BqP7JAL4'
const RESET_BATCH_SIZE = 20
const DELETE_TASK_BATCH_SIZE = 20
const DB_RETRY_LIMIT = 5

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
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

async function resetActiveSubscriptions() {
  let updated = 0
  let scanned = 0
  let lastId = ''

  while (true) {
    const condition = {
      status: 'subscribed',
      active: _.neq(true),
      ...(lastId ? { _id: _.gt(lastId) } : {})
    }
    const { data } = await retryDb(() => db.collection('subscriptions')
      .where(condition)
      .orderBy('_id', 'asc')
      .limit(RESET_BATCH_SIZE)
      .get(), '读取待重置订阅用户')

    if (!data.length) break
    scanned += data.length
    lastId = data[data.length - 1]._id

    const result = await retryDb(() => db.collection('subscriptions').where({
      _id: _.in(data.map(item => item._id))
    }).update({
      data: {
        active: true,
        resetActiveAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    }), '批量重置订阅用户 active')

    updated += result && result.stats ? Number(result.stats.updated || 0) : 0
    if (data.length < RESET_BATCH_SIZE) break
  }

  return { updated, scanned }
}

async function deleteCollectionItems(collectionName, label) {
  let removed = 0
  let scanned = 0

  while (true) {
    const { data } = await retryDb(() => db.collection(collectionName)
      .orderBy('_id', 'asc')
      .limit(DELETE_TASK_BATCH_SIZE)
      .get(), `读取待删除${label}`)

    if (!data.length) break
    scanned += data.length

    for (const item of data) {
      const result = await retryDb(() => db.collection(collectionName).doc(item._id).remove(), `删除${label}`)
      removed += result && result.stats ? Number(result.stats.removed || 0) : 1
    }

    if (data.length < DELETE_TASK_BATCH_SIZE) break
  }

  return { removed, scanned }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, message: '无法获取用户身份' }

  if (event.action === 'resetActive') {
    if (OPENID !== ADMIN_OPENID) return { ok: false, message: '无权限访问' }
    const result = await resetActiveSubscriptions()
    const deletedTasks = await deleteCollectionItems('notice_delivery_tasks', '发送任务')
    const deletedQueue = await deleteCollectionItems('notice_delivery_queue', '发送队列')
    return {
      ok: true,
      updated: result.updated,
      scanned: result.scanned,
      deletedTasks: deletedTasks.removed,
      deletedQueue: deletedQueue.removed,
      scannedTasks: deletedTasks.scanned
    }
  }

  const id = OPENID
  const existing = await db.collection('subscriptions').doc(id).get().catch(() => null)
  if (event.action === 'cancel') {
    if (!existing || !existing.data) return { ok: false, message: '尚未订阅提醒' }
    if (existing.data.status === 'cancelled') return { ok: true }
    await db.collection('subscriptions').doc(id).update({
      data: {
        status: 'cancelled',
        active: false,
        cancelledAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
    return { ok: true }
  }

  if (!event.templateId) return { ok: false, message: '参数不完整' }
  if (existing && existing.data && existing.data.status !== 'cancelled') {
    return { ok: false, message: '你已经订阅过，不能重复订阅' }
  }
  const now = db.serverDate()
  await db.collection('subscriptions').doc(id).set({
    data: {
      _openid: OPENID,
      templateId: event.templateId,
      status: 'subscribed',
      active: true,
      subscribedAt: now,
      cancelledAt: null,
      updatedAt: now,
      lastError: ''
    }
  })
  return { ok: true }
}
