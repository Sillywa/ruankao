Page({
  data: {
    records: [],
    loading: false,
    initialized: false
  },

  onLoad() { this.loadRecords() },
  onPullDownRefresh() {
    this.loadRecords().finally(() => wx.stopPullDownRefresh())
  },

  async loadRecords() {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const { result } = await wx.cloud.callFunction({ name: 'getCheckRecords' })
      if (!result || !result.ok) throw new Error((result && result.message) || '读取失败')
      this.setData({
        records: result.records,
        initialized: true
      })
    } catch (error) {
      console.error('读取查询记录失败', error)
      wx.showToast({ title: error.message || '读取记录失败', icon: 'none' })
      this.setData({ initialized: true })
    } finally {
      this.setData({ loading: false })
    }
  }
})
