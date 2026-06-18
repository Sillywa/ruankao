const config = require('../../config')

Page({
  data: {
    subscribed: false,
    submitting: false,
    testing: false,
    notificationActive: false,
    lastCheckedAt: '',
    latestNotice: null,
    latestAnnouncement: null
  },

  onLoad() { this.loadStatus() },
  onPullDownRefresh() { this.loadStatus().finally(() => wx.stopPullDownRefresh()) },

  async loadStatus() {
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
    }
  },

  formatAnnouncement(announcement) {
    if (!announcement) return null
    const dateText = announcement.date || ''
    return { ...announcement, dateText }
  },

  async sendTestNotification() {
    if (this.data.testing) return
    // 必须在用户点击事件的同步调用链中立即调用，否则微信会报 can only be invoked by user TAP gesture。
    const subscribeRequest = wx.requestSubscribeMessage({ tmplIds: [config.templateId] })
    this.setData({ testing: true })
    try {
      const settings = await subscribeRequest
      if (settings[config.templateId] !== 'accept') {
        wx.showToast({ title: '未获得测试授权', icon: 'none' })
        return
      }
      const { result } = await wx.cloud.callFunction({ name: 'testNotification' })
      if (!result || !result.ok) throw new Error((result && result.message) || '发送失败')
      wx.showToast({ title: '测试通知已发送', icon: 'success' })
    } catch (error) {
      console.error('测试通知发送失败', error)
      const message = error.errMsg || error.message || ''
      if (message.includes('FUNCTION_NOT_FOUND') || message.includes('-501000')) {
        wx.showModal({
          title: '测试云函数未部署',
          content: '请在微信开发者工具中右键 cloudfunctions/testNotification，选择“上传并部署：所有文件”，并确认上传到小程序当前使用的云环境。',
          showCancel: false
        })
      } else {
        wx.showToast({ title: message || '发送失败', icon: 'none' })
      }
    } finally {
      this.setData({ testing: false })
    }
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

  async checkNow() {
    this.setData({ submitting: true })
    wx.showLoading({ title: '正在检查', mask: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'checkNotification',
        data: { manual: true }
      })
      if (!result || !result.ok) throw new Error((result && result.message) || '检查失败')
      await this.loadStatus()
      wx.showToast({
        title: result.found ? '发现成绩通知' : '暂无最新通知',
        icon: result.found ? 'success' : 'none'
      })
    } catch (error) {
      console.error('立即检查失败', error)
      wx.showToast({ title: error.message || '检查失败，请稍后重试', icon: 'none' })
    } finally {
      wx.hideLoading()
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
      const settings = await wx.requestSubscribeMessage({ tmplIds: [config.templateId] })
      if (settings[config.templateId] !== 'accept') {
        wx.showToast({ title: '未获得订阅授权', icon: 'none' })
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
  }
})
