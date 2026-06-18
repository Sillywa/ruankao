const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, message: '无法获取用户身份' }

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
