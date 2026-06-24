Page({
  data: {
    stats: null,
    recentTasks: [],
    errorMessage: '',
    loading: false,
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
        initialized: true
      })
    } catch (error) {
      console.error('读取管理后台数据失败', error)
      wx.showToast({ title: error.message || '读取失败', icon: 'none' })
      this.setData({ initialized: true, stats: null, recentTasks: [], errorMessage: error.message || '读取失败' })
    } finally {
      this.setData({ loading: false })
    }
  }
})
