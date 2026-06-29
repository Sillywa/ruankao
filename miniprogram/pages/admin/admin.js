Page({
  data: {
    stats: null,
    recentTasks: [],
    recentAttempts: [],
    errorMessage: '',
    loading: false,
    refreshing: false,
    checking: false,
    initialized: false
  },

  onLoad() { this.loadStats() },
  onPullDownRefresh() {
    this.loadStats().finally(() => wx.stopPullDownRefresh())
  },

  openFieldHelp() {
    wx.navigateTo({
      url: '/pages/adminHelp/adminHelp',
      fail(error) {
        console.error('打开字段说明失败', error)
        wx.showToast({ title: '打开字段说明失败', icon: 'none' })
      }
    })
  },

  refreshStats() {
    if (this.data.refreshing) return
    wx.showLoading({ title: '正在刷新', mask: true })
    return this.loadStats({ showPageLoading: false })
      .finally(() => wx.hideLoading())
  },

  async checkNotificationNow() {
    if (this.data.checking) return
    this.setData({ checking: true })
    wx.showLoading({ title: '正在检查', mask: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'checkNotification',
        data: { action: 'adminCheck' }
      })
      if (!result || !result.ok) throw new Error((result && result.message) || '检查失败')
      await this.loadStats({ showPageLoading: false })
      wx.hideLoading()
      const delivery = result.delivery || {}
      const queued = Number(delivery.queued || 0)
      wx.showToast({
        title: queued > 0 ? `已入队${queued}人` : '检查完成',
        icon: 'none',
        duration: 2500
      })
    } catch (error) {
      console.error('立即检查失败', error)
      wx.hideLoading()
      wx.showToast({ title: error.message || '检查失败', icon: 'none' })
    } finally {
      this.setData({ checking: false })
    }
  },

  async loadStats(options = {}) {
    const showPageLoading = options.showPageLoading !== false
    if (showPageLoading) {
      if (this.data.loading) return
      this.setData({ loading: true, errorMessage: '' })
    } else {
      if (this.data.refreshing) return
      this.setData({ refreshing: true, errorMessage: '' })
    }
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
      if (showPageLoading) {
        this.setData({ loading: false })
      } else {
        this.setData({ refreshing: false })
      }
    }
  },

  
})
