const config = require('./config')

App({
  onLaunch() {
    if (!wx.cloud) {
      wx.showModal({ title: '版本过低', content: '请升级微信后再使用本小程序', showCancel: false })
      return
    }
    wx.cloud.init({
      env: config.cloudEnvId || undefined,
      traceUser: true
    })
  }
})
