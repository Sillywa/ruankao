const config = require('../../config')
const SCORE_QUERY_URL = 'https://bm.ruankao.org.cn/index.php/query/score'

Page({
  data: {
    pageLoading: true,
    subscribed: false,
    submitting: false,
    cancelling: false,
    notificationActive: false,
    lastCheckedAt: '',
    latestNotice: null,
    latestAnnouncement: null
  },

  onLoad() { this.loadStatus(true) },
  onPullDownRefresh() { this.loadStatus(true).finally(() => wx.stopPullDownRefresh()) },

  async loadStatus(showSkeleton = false) {
    if (showSkeleton) this.setData({ pageLoading: true })
    try {
      const { result } = await wx.cloud.callFunction({ name: 'getStatus' })
      if (result && result.ok) {
        this.setData({
          subscribed: result.subscribed,
          notificationActive: result.notificationActive,
          lastCheckedAt: result.lastCheckedAt || '',
          latestNotice: result.latestNotice || null,
          latestAnnouncement: this.formatAnnouncement(result.latestAnnouncement)
        })
      }
    } catch (error) {
      console.error('读取状态失败', error)
    } finally {
      if (showSkeleton) this.setData({ pageLoading: false })
    }
  },

  async cancelSubscription() {
    if (this.data.cancelling) return
    const confirmed = await new Promise(resolve => {
      wx.showModal({
        title: '确认取消订阅？',
        content: '取消后将停止自动成绩提醒，但会保留你的订阅记录。之后可以重新订阅。',
        confirmText: '确认取消',
        confirmColor: '#e05b45',
        success: result => resolve(result.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirmed) return

    this.setData({ cancelling: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'subscribe',
        data: { action: 'cancel' }
      })
      if (!result || !result.ok) throw new Error((result && result.message) || '取消失败')
      this.setData({ subscribed: false, notificationActive: false })
      wx.showToast({ title: '已取消订阅', icon: 'success' })
    } catch (error) {
      console.error('取消订阅失败', error)
      wx.showToast({ title: error.message || '取消失败', icon: 'none' })
    } finally {
      this.setData({ cancelling: false })
    }
  },

  formatAnnouncement(announcement) {
    if (!announcement) return null
    const dateText = announcement.date || ''
    return { ...announcement, dateText }
  },

  handlePrimaryAction() {
    if (this.data.subscribed) return this.checkNow()
    return this.subscribe()
  },

  openLatestNotice() {
    const notice = this.data.latestAnnouncement
    if (!notice || !notice.url) return
    wx.setClipboardData({
      data: notice.url,
      success() {
        wx.showModal({
          title: '公告链接已复制',
          content: '微信小程序无法直接打开系统浏览器，请前往浏览器粘贴链接查看公告原文。',
          showCancel: false,
          confirmText: '知道了'
        })
      },
      fail(error) {
        console.error('复制公告链接失败', error)
        wx.showToast({ title: '复制失败，请稍后重试', icon: 'none' })
      }
    })
  },

  openCheckRecords() {
    wx.navigateTo({ url: '/pages/records/records' })
  },

  openScoreQuery() {
    wx.setClipboardData({
      data: SCORE_QUERY_URL,
      success() {
        wx.showModal({
          title: '复制成功',
          content: '软考官网成绩查询链接已复制，请前往浏览器粘贴打开查询成绩。',
          showCancel: false,
          confirmText: '知道了'
        })
      },
      fail(error) {
        console.error('复制成绩查询链接失败', error)
        wx.showToast({ title: '复制失败，请稍后重试', icon: 'none' })
      }
    })
  },

  async checkNow() {
    this.setData({ submitting: true })
    wx.showLoading({ title: '正在查询', mask: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'checkNotification',
        data: { manual: true }
      })
      if (!result || !result.ok) throw new Error((result && result.message) || '查询失败')
      await this.loadStatus()
      wx.hideLoading()
      wx.showToast({
        title: result.found ? '发现成绩通知' : '暂无最新通知',
        icon: result.found ? 'success' : 'none',
        duration: 2500
      })
    } catch (error) {
      console.error('立即查询失败', error)
      wx.hideLoading()
      const message = error.message || '查询失败，请稍后重试'
      wx.showToast({
        title: message,
        icon: 'none',
        duration: message.includes('频繁') ? 3000 : 2500
      })
    } finally {
      this.setData({ submitting: false })
    }
  },

  async subscribe() {
    if (!config.templateId || config.templateId.startsWith('请替换')) {
      wx.showModal({
        title: '尚未配置模板',
        content: '请先在 miniprogram/config.js 中填写订阅消息模板 ID。',
        showCancel: false
      })
      return
    }

    this.setData({ submitting: true })
    try {
      let settings
      try {
        settings = await wx.requestSubscribeMessage({ tmplIds: [config.templateId] })
      } catch (error) {
        console.error('调用订阅授权失败', error)
        await this.guideSubscriptionSetting('error')
        return
      }
      const authStatus = settings[config.templateId]
      if (authStatus !== 'accept') {
        await this.guideSubscriptionSetting(authStatus)
        return
      }
      const { result } = await wx.cloud.callFunction({
        name: 'subscribe',
        data: { templateId: config.templateId }
      })
      if (!result || !result.ok) throw new Error((result && result.message) || '订阅保存失败')
      this.setData({ subscribed: true, notificationActive: true })
      wx.showToast({ title: '订阅成功', icon: 'success' })
    } catch (error) {
      console.error('订阅失败', error)
      wx.showToast({ title: error.errMsg || error.message || '订阅失败', icon: 'none' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  guideSubscriptionSetting(authStatus) {
    let content = '你已拒绝接收该订阅消息。可前往设置重新开启，然后再次点击订阅。'
    if (authStatus === 'ban') {
      content = '微信订阅消息总开关已关闭，请前往设置开启“接收订阅消息”，然后再次点击订阅。'
    } else if (authStatus === 'error') {
      content = '无法调起订阅授权，请前往设置开启“接收订阅消息”，返回后再次点击订阅。'
    }
    return new Promise(resolve => {
      wx.showModal({
        title: '未获得通知授权',
        content,
        confirmText: '去设置',
        cancelText: '暂不开启',
        success: modalResult => {
          if (!modalResult.confirm) {
            resolve()
            return
          }
          // 必须由用户点击弹窗确认后直接打开设置页。
          wx.openSetting({
            success: () => {
              wx.showToast({ title: '请再次点击订阅', icon: 'none' })
              resolve()
            },
            fail: error => {
              console.error('打开订阅设置失败', error)
              wx.showToast({ title: '无法打开设置', icon: 'none' })
              resolve()
            }
          })
        },
        fail: resolve
      })
    })
  }
})
