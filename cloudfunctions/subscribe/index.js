const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID || !event.templateId) return { ok: false, message: '参数不完整' }

  const id = OPENID
  const existing = await db.collection('subscriptions').doc(id).get().catch(() => null)
  if (existing && existing.data) {
    return { ok: false, message: '你已经订阅过，不能重复订阅' }
  }
  const now = db.serverDate()
  await db.collection('subscriptions').doc(id).set({
    data: {
      _openid: OPENID,
      templateId: event.templateId,
      active: true,
      subscribedAt: now,
      updatedAt: now,
      lastError: ''
    }
  })
  return { ok: true }
}
