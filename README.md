# 软考成绩提醒微信小程序

微信小程序原生前端 + 微信云开发后端。用户授权一次性订阅消息后，云函数每 30 分钟检查中国计算机技术职业资格网；用户也可点击“立即检查”。发现当年新的成绩查询通知时，给所有有效订阅发送服务通知。

## 目录

- `miniprogram/`：原生 WXML、WXSS、JavaScript 前端
- `cloudfunctions/subscribe`：保存用户的一次订阅授权
- `cloudfunctions/getStatus`：读取用户订阅状态和最近检查结果
- `cloudfunctions/checkNotification`：定时抓取、去重并发送消息

## 部署

1. 在微信开发者工具导入本目录，将 `project.config.json` 中的 `appid` 换成你的小程序 AppID。
2. 开通云开发环境；如不使用工具当前环境，在 `miniprogram/config.js` 填写云环境 ID。
3. 在微信公众平台选择一个一次性订阅消息模板。建议字段为：
   - `thing1`：通知标题
   - `date2`：发布日期
   - `thing3`：温馨提示
4. 把模板 ID 写入 `miniprogram/config.js`。若平台分配的字段名不同，同步修改 `cloudfunctions/checkNotification/index.js` 的 `messageData`。
5. 在云开发数据库新建 `subscriptions`、`system_state` 两个集合。权限都设为“仅云函数可读写”；小程序只通过云函数访问。
6. 在开发者工具中分别右键三个正式云函数目录，选择“上传并部署：云端安装依赖”。
7. 打开云开发控制台确认 `checkNotification` 的定时触发器已创建。其 cron 为 `0 */30 * * * * *`，即每 30 分钟执行一次。
8. 首次上线前，在云开发控制台手动运行一次 `checkNotification`，检查日志和 `system_state/score_notice`。

## 测试建议

- 订阅按钮必须由用户点击触发，真机调试比模拟器更可靠。
- 开发阶段可暂时把触发器改为每 5 分钟，但正式环境请恢复 30 分钟。
- 可在云函数控制台临时把 `SOURCE_URLS` 指向测试 HTML 服务，或用已有通知样本验证发送；不要通过反复改线上状态向真实用户发送测试消息。
- `miniprogramState` 当前为 `formal`。体验版测试时可改为 `trial`，开发版改为 `developer`。

## 行为说明

- 只匹配标题同时含当前年份、成绩以及“查询/公布/发布”的文章。
- 取发布日期最新的一条，并以文章 URL 去重。
- 页面中的“最新公告”独立取软考网公告列表中发布日期最新的一条，不受成绩通知关键词限制。点击公告会复制原文链接，用户可在系统浏览器中粘贴打开，无需配置业务域名。
- 微信一次性订阅消息成功发送或发送失败后都会关闭本次消息授权，避免无效授权反复重试；订阅登记本身仍永久保留。
- 订阅中的用户不能重复订阅；取消订阅后可以重新授权并恢复订阅。
- 订阅文档使用 `status` 字段区分 `subscribed`（订阅中）和 `cancelled`（已取消）。取消时保留数据库记录并停止推送；已取消用户会重新看到订阅按钮，授权后可恢复订阅。
- 手动检查仅允许已订阅用户调用，并设有 1 分钟冷却时间。
- 云函数外网访问若受云环境安全规则限制，需要在云开发控制台允许访问 `www.ruankao.org.cn`。

参考：[微信小程序开发文档](https://developers.weixin.qq.com/miniprogram/dev/framework/)
