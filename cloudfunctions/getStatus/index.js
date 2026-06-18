const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date).reduce((result, item) => ({ ...result, [item.type]: item.value }), {})
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  const [subscription, state] = await Promise.all([
    db.collection('subscriptions').doc(OPENID).get().catch(() => null),
    db.collection('system_state').doc('score_notice').get().catch(() => null)
  ])
  const status = state && state.data
  return {
    ok: true,
    // 文档存在即表示已经订阅过；消息是否已消费不影响“一人只能订阅一次”。
    subscribed: Boolean(subscription && subscription.data),
    notificationActive: Boolean(subscription && subscription.data && subscription.data.active),
    lastCheckedAt: formatDate(status && status.lastCheckedAt),
    latestNotice: status && status.latestNotice ? status.latestNotice : null,
    latestAnnouncement: status && status.latestAnnouncement ? status.latestAnnouncement : null
  }
}
