const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function shanghaiDate() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).reduce((result, item) => ({ ...result, [item.type]: item.value }), {})
  return `${parts.year}-${parts.month}-${parts.day}`
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  if (!OPENID) return { ok: false, message: '无法获取用户身份' }

  const result = await db.collection('subscriptions').doc(OPENID).get().catch(() => null)
  const subscriber = result && result.data
  if (!subscriber) return { ok: false, message: '请先订阅提醒' }
  if (subscriber.status === 'cancelled') return { ok: false, message: '请先重新订阅提醒' }

  try {
    await cloud.openapi.subscribeMessage.send({
      touser: OPENID,
      templateId: subscriber.templateId,
      page: 'pages/index/index',
      miniprogramState: 'formal',
      lang: 'zh_CN',
      data: {
        thing1: { value: '软考成绩提醒测试通知' },
        date2: { value: shanghaiDate() },
        thing3: { value: '订阅消息发送功能测试成功' }
      }
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, message: String(error.errMsg || error.message || error).slice(0, 500) }
  }
}
