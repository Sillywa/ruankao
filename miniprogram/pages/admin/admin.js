Page({
  data: {
    stats: null,
    recentTasks: [],
    recentAttempts: [],
    errorMessage: '',
    loading: false,
    retrying: false,
    initialized: false
  },

  onLoad() { this.loadStats() },
  onPullDownRefresh() {
    this.loadStats().finally(() => wx.stopPullDownRefresh())
  },

  async loadStats() {
    if (this.data.loading) return
    this.setData({ loading: true, errorMessage: '' })
    try {
      const { result } = await wx.cloud.callFunction({ name: 'getAdminStats' })
      if (!result || !result.ok) throw new Error((result && result.message) || '读取失败')
      this.setData({
        stats: result.stats,
        recentTasks: result.recentTasks || [],
        recentAttempts: result.recentAttempts || [],
        initialized: true
      })
    } catch (error) {
      console.error('读取管理后台数据失败', error)
      wx.showToast({ title: error.message || '读取失败', icon: 'none' })
      this.setData({ initialized: true, stats: null, recentTasks: [], recentAttempts: [], errorMessage: error.message || '读取失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async retryFailedNotifications() {
    if (this.data.retrying) return
    const confirmed = await new Promise(resolve => {
      wx.showModal({
        title: '确认重试发送？',
        content: '将立即给当前成绩公告下临时发送失败且仍可通知的用户重发提醒。授权失效用户不会重发。',
        confirmText: '立即重试',
        success: result => resolve(result.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirmed) return

    this.setData({ retrying: true })
    wx.showLoading({ title: '正在重试', mask: true })
    try {
      const { result } = await wx.cloud.callFunction({ name: 'retryFailedNotifications' })
      if (!result || !result.ok) throw new Error((result && result.message) || '重试失败')
      await this.loadStats()
      wx.hideLoading()
      const delivery = result.delivery || {}
      wx.showToast({
        title: result.skipped ? '已有重试任务' : `成功${delivery.sent || 0} 失败${delivery.failed || 0}`,
        icon: 'none',
        duration: 2500
      })
    } catch (error) {
      console.error('重试发送失败', error)
      wx.hideLoading()
      wx.showToast({ title: error.message || '重试失败', icon: 'none' })
    } finally {
      this.setData({ retrying: false })
    }
  }
})
