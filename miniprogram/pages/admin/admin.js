Page({
  data: {
    stats: null,
    recentTasks: [],
    recentAttempts: [],
    attemptOffset: 0,
    attemptHasMore: false,
    attemptsLoading: false,
    errorMessage: '',
    loading: false,
    refreshing: false,
    checking: false,
    resetting: false,
    initialized: false
  },

  onLoad() { this.loadStats() },
  onPullDownRefresh() {
    this.loadStats().finally(() => wx.stopPullDownRefresh())
  },
  onReachBottom() {
    this.loadMoreAttempts()
  },

  collapseAttempts(attempts) {
    return (attempts || []).map(item => ({ ...item, expanded: false }))
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

  async resetSubscriptionsNow() {
    if (this.data.resetting) return
    const confirmed = await new Promise(resolve => {
      wx.showModal({
        title: '确认重置订阅？',
        content: '将把所有用户重置为未订阅状态，并清空发送任务和发送队列。用户需要重新授权订阅提醒。',
        confirmText: '确认重置',
        confirmColor: '#d65a4a',
        success: result => resolve(result.confirm),
        fail: () => resolve(false)
      })
    })
    if (!confirmed) return

    this.setData({ resetting: true })
    wx.showLoading({ title: '正在重置', mask: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'subscribe',
        data: { action: 'resetActive' }
      })
      if (!result || !result.ok) throw new Error((result && result.message) || '重置失败')
      await this.loadStats({ showPageLoading: false })
      wx.hideLoading()
      wx.showToast({
        title: `已重置${Number(result.updated || 0)}人`,
        icon: 'none',
        duration: 2500
      })
    } catch (error) {
      console.error('一键重置失败', error)
      wx.hideLoading()
      wx.showToast({ title: error.message || '重置失败', icon: 'none' })
    } finally {
      this.setData({ resetting: false })
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
        recentAttempts: this.collapseAttempts(result.recentAttempts),
        attemptOffset: Number(result.nextAttemptOffset || (result.recentAttempts || []).length),
        attemptHasMore: Boolean(result.hasMoreAttempts),
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

  async loadMoreAttempts() {
    if (!this.data.initialized || this.data.errorMessage || this.data.attemptsLoading || !this.data.attemptHasMore) return
    this.setData({ attemptsLoading: true })
    try {
      const { result } = await wx.cloud.callFunction({
        name: 'getAdminStats',
        data: {
          action: 'listAttempts',
          offset: this.data.attemptOffset,
          limit: 20
        }
      })
      if (!result || !result.ok) throw new Error((result && result.message) || '加载失败')
      const nextAttempts = this.collapseAttempts(result.attempts)
      this.setData({
        recentAttempts: this.data.recentAttempts.concat(nextAttempts),
        attemptOffset: Number(result.nextOffset || (this.data.attemptOffset + nextAttempts.length)),
        attemptHasMore: Boolean(result.hasMore)
      })
    } catch (error) {
      console.error('加载发送流水失败', error)
      wx.showToast({ title: error.message || '加载失败', icon: 'none' })
    } finally {
      this.setData({ attemptsLoading: false })
    }
  },

  toggleAttemptResults(event) {
    const id = event.currentTarget.dataset.id
    const attempts = this.data.recentAttempts.map(item => (
      item._id === id ? { ...item, expanded: !item.expanded } : item
    ))
    this.setData({ recentAttempts: attempts })
  },

  
})
