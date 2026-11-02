# AMO Studio iOS 改动说明

每次 `npm run release -- ios` 把「下一版」改成这一版的标题，传到 TestFlight。共用的代码（`mobile/shared`）跟 Android 版一样，Android 的改动说明在 `mobile/CHANGELOG.md`。

## 下一版

- 第一个 iOS 版，只在 TestFlight 内部测试里装：跟 Android 版同一套界面和功能（登录、连电脑、看任务和会话、对话、审批、提问、停止、看文件）。
- 跟 Android 版不一样的地方：设置里没有「检查更新」，更新由 TestFlight 推送；登录凭据用钥匙串里的密钥加密，只在这台手机上能解开。
