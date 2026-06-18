const https = require('https')
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const SOURCE_URLS = [
  'https://www.ruankao.org.cn/index.html',
  'https://www.ruankao.org.cn/index/work.html'
]

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

async function notifySubscribers(notice) {
  await migrateLegacySubscriptions()
  let sent = 0
  let failed = 0
  let lastId = ''
  while (true) {
    const condition = lastId
      ? { active: true, status: 'subscribed', _id: _.gt(lastId) }
      : { active: true, status: 'subscribed' }
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
        await db.collection('subscriptions').doc(subscriber._id).update({
          data: { active: false, notifiedAt: db.serverDate(), noticeUrl: notice.url, lastError: '' }
        })
        sent += 1
      } catch (error) {
        await db.collection('subscriptions').doc(subscriber._id).update({
          data: { active: false, failedAt: db.serverDate(), lastError: String(error.errMsg || error.message || error).slice(0, 500) }
        })
        failed += 1
      }
    }
    lastId = data[data.length - 1]._id
    if (data.length < 100) break
  }
  return { sent, failed }
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  // 有 OPENID 表示由小程序手动调用；定时触发器没有用户 OPENID。
  if (OPENID) {
    const subscriber = await db.collection('subscriptions').doc(OPENID).get().catch(() => null)
    if (!subscriber || !subscriber.data) return { ok: false, message: '请先订阅提醒' }

    const lastManualCheckAt = subscriber.data.lastManualCheckAt
    if (lastManualCheckAt && Date.now() - new Date(lastManualCheckAt).getTime() < 60000) {
      return { ok: false, message: '检查太频繁，请一分钟后再试' }
    }
    await db.collection('subscriptions').doc(OPENID).update({
      data: { lastManualCheckAt: db.serverDate() }
    })
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

    if (latest && latest.url !== previousUrl) delivery = await notifySubscribers(latest)

    await db.collection('system_state').doc('score_notice').set({
      data: {
        lastCheckedAt: db.serverDate(),
        latestNotice: latest,
        latestAnnouncement,
        lastError: '',
        lastDelivery: delivery || (previous && previous.data && previous.data.lastDelivery) || null
      }
    })
    return { ok: true, found: Boolean(latest), latest, latestAnnouncement, delivery }
  } catch (error) {
    const errorState = { lastCheckedAt: db.serverDate(), lastError: String(error.message || error).slice(0, 500) }
    // 更新失败时保留上一条通知，避免网络恢复后将同一通知误判为新通知并重复发送。
    await db.collection('system_state').doc('score_notice').update({ data: errorState })
      .catch(() => db.collection('system_state').doc('score_notice').set({ data: errorState }))
    throw error
  }
}
