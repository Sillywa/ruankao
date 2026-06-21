const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const RECORD_LIMIT = 30

function formatDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const shanghai = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const pad = number => String(number).padStart(2, '0')
  return `${shanghai.getUTCFullYear()}-${pad(shanghai.getUTCMonth() + 1)}-${pad(shanghai.getUTCDate())} ${pad(shanghai.getUTCHours())}:${pad(shanghai.getUTCMinutes())}:${pad(shanghai.getUTCSeconds())}`
}

exports.main = async () => {
  try {
    const { data } = await db.collection('check_logs')
      .orderBy('checkedAt', 'desc')
      .limit(RECORD_LIMIT)
      .get()
    return {
      ok: true,
      records: data.map(item => ({
        _id: item._id,
        success: item.success,
        found: item.found,
        checkedAt: formatDate(item.checkedAt),
        durationMs: item.durationMs || 0,
        noticeTitle: item.latestNotice ? item.latestNotice.title : '',
        delivery: item.delivery || null,
        error: item.error || ''
      }))
    }
  } catch (error) {
    return { ok: false, message: String(error.message || error).slice(0, 500) }
  }
}
