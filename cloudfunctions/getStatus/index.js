const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  // 不使用 Intl，避免部分微信/iOS 环境把午夜后的时间格式化为 24:xx。
  const shanghai = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const pad = number => String(number).padStart(2, '0')
  return `${shanghai.getUTCFullYear()}-${pad(shanghai.getUTCMonth() + 1)}-${pad(shanghai.getUTCDate())} ${pad(shanghai.getUTCHours())}:${pad(shanghai.getUTCMinutes())}`
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  const [subscription, state] = await Promise.all([
    db.collection('subscriptions').doc(OPENID).get().catch(() => null),
    db.collection('system_state').doc('score_notice').get().catch(() => null)
  ])
  const status = state && state.data
  const subscriptionStatus = subscription && subscription.data
    ? (subscription.data.status || 'subscribed')
    : ''
  return {
    ok: true,
    // 文档存在即表示已经订阅过；消息是否已消费不影响“一人只能订阅一次”。
    subscribed: subscriptionStatus === 'subscribed',
    subscriptionStatus,
    notificationActive: Boolean(subscription && subscription.data && subscription.data.active),
    lastCheckedAt: formatDate(status && status.lastCheckedAt),
    latestNotice: status && status.latestNotice ? status.latestNotice : null,
    latestAnnouncement: status && status.latestAnnouncement ? status.latestAnnouncement : null
  }
}
