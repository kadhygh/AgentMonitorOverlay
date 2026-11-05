# Android 版 AMO Studio：首版的边界和做法

> 状态：做完（首版 0.1.0 2026-10-31 做完；11-01 按 `plans/done/android-mobile-redesign.md` 重做界面和数据层，出 0.2.0；11-02 工程从 `studio/android` 移到 `studio/mobile`，改成 Kotlin Multiplatform，见 `plans/ios.md`）。下面的路径有的还是 `studio/android` 时的写法；构建环境和用法看 `studio/mobile/README.md`。验证记录、交付清单（APK 大小、校验值、测试日志）和开发前的本机环境检查 2026-11-06 删掉了，原文见 git 历史（提交 f46907f2 之前的版本）。还没验的见末节。

## 结论（10-31 开发前的调查）

可以开发独立的 Android 远程客户端。账号、设备配对、远程任务和会话协议已有实现；手机端补充界面、协议客户端、凭据保护和恢复同步。模型、命令及项目文件始终由远端电脑的 Studio Host 执行和管理。

现有链路通过团队服务器转发。Wi-Fi 和 Tailscale 都按访问同一团队服务器设计；手机与电脑之间的直接连接不属于现有协议。

## 用户确认的首版边界

- 只做 Studio 的远程使用，手机不运行本地模型和本机会话。
- 保留登录、设备配对、创建 task、task 下创建 session、session 对话及查看。
- 操作行为以现有桌面客户端为准。创建任务同时创建并启动首个会话，之后可继续新建会话；不新增“只创建空任务”接口。
- 不做批注、书签、Focus 浮窗或弹出提醒，优先跑通基础功能。
- 不引入便签、中转聊天、平台安装管理、画布、Git Review、终端和本地模型配置页面。
- 严格沿用当前 AMO Studio 美术风格，提供浅色和深色主题设置。
- 审批、回答模型提问和中断作为会话操作保留在会话页内，不依赖 Focus。

## 首版做成的范围

- Android 9 / API 28 起，target API 36。
- 登录团队账号、选择同账号电脑申请配对、显示已授权任务、创建任务并立即启动首个会话、同任务下新会话、流式对话、审批、回答提问和中断。
- HTML、Markdown、图片和文本查看；HTML 支持内联交互，文件链接重新交 Host 授权。外部脚本、样式、图片等子资源不加载。
- 加密保存登录令牌；按服务器和账号隔离历史缓存与草稿；前台恢复同步、断线重连，未确认命令不自动重发。
- 手机不运行模型；无 Focus、批注、书签、画布、终端和 Git Review。附件上传、完整桌面 Markdown 扩展、后台实时通知留到后续。
- 没有为它修改 Host / Relay 的协议。

## 服务与代码现状（手机端接的是什么）

| 能力 | 已有实现 / 依据 |
|---|---|
| 登录 | POST /api/login；packages/account/src/account.ts；返回账号与 key |
| 设备识别 | account + device；Android 需要自己的持久化设备 ID，不复制电脑 device.json |
| 同账号在线设备 | GET /api/devices/online；支持选择自己的其他设备发起配对 |
| 配对与撤销 | /api/devices/pair、pairs、unpair；电脑确认配对，授权检查仍由电脑执行 |
| 设备长连接 | /api/devices/ws；packages/relay/src/devices-protocol.ts |
| 允许的项目和模型 | rt.catalog；手机只展示电脑允许的选项，不配置模型凭据 |
| 创建任务与首个会话 | rt.create；packages/host/src/features/remote/create.ts |
| 已授权任务与历史 | rt.list、rt.task、rt.items |
| 会话操作 | rt.start、rt.send、rt.approve、rt.answer、rt.interrupt |
| 实时更新 | rt.push；会话、消息、流式文本和授权状态 |
| 文件查看 | rt.file；已有 HTML、Markdown、图片、文本读取与范围检查 |
| 断线恢复 | link.ts、copies.ts；退避重连、历史补齐、授权与审批状态重新核对 |

packages/host/src/http/server.ts 将 Host API 绑定 127.0.0.1。Android 接入设备协议，不连接电脑 Host 的本地管理 API。

桌面 B 端远程功能的一部分运行在本地 Node Host：持久化副本、同步、文件缓存和命令状态管理。因此直接把 packages/ui 放进 WebView 并不能获得可用的远程客户端，这是手机端单独写一套的原因。

## Wi-Fi 与 Tailscale

推荐链路：Android → 团队服务器 ← 远端电脑 Host。两端都主动连接服务器。

- Wi-Fi：手机可达团队服务器 172.16.8.85:47120 即可；同一个 Wi-Fi 名称并不保证跨网段可达，还需排除访客隔离等限制。
- Tailscale：优先让团队服务器和手机加入可互访的 tailnet，手机使用服务器的 Tailscale 地址或 MagicDNS 名称。电脑只需能连接同一服务器，电脑是否需要 Tailscale 取决于其所在网络。
- 如果服务器不装 Tailscale，可由已配置并批准路由的 subnet router 提供服务器所在网段的访问。
- 仅让手机和执行电脑加入 Tailscale，并不会自动让现有团队服务器可达；Tailscale 也不会取代 AMO 登录、配对和授权。
- 首版填写服务器地址、登录后列设备，不依赖局域网广播发现。
- 建议在 Tailscale 和 Wi-Fi 场景使用稳定的服务器地址；不要把切换 URL 默认为同一服务器。现有部分状态按 server + account 区分，地址别名迁移需要单独处理。

依据：[Tailscale 连接设备](https://tailscale.com/docs/how-to/connect-to-devices)、[MagicDNS](https://tailscale.com/docs/features/magicdns)、[子网路由](https://tailscale.com/docs/features/subnet-routers)。

## 实现上的取舍

Kotlin + Compose，按现有设备协议实现远程控制端（网络库首版是 OkHttp，11-02 改 KMP 时换成 Ktor，Android 上用 OkHttp 引擎）。Kotlin 类型和 TypeScript 协议应通过固定消息样例做兼容测试，避免两边字段逐渐不一致。

Compose 使用 AMO 自定义视觉组件和颜色，不采用默认 Material 外观或系统动态配色。文件查看可局部使用受隔离的 WebView；不向任务产生的 HTML 暴露凭据或原生桥接。

相比完整移植桌面 UI，这条路线更贴合已缩减的功能范围；代价是会话渲染、同步逻辑及主题变量需要在 Android 端适配，并持续核对桌面行为。若以后要求大量复用复杂桌面对话组件，再评估抽取纯 Web UI 模块。

登录复用团队服务器的账号和 API。用户明确要求 Android 内可登录，按移动端入口实施；无需另装 Android 平台应用。桌面端仍沿用平台登录，Windows DPAPI 文件代码不能原样搬到 Android。Android 使用 Keystore 中的密钥加密持久化令牌，不存明文密码。

当前服务器使用 HTTP/WS，Android 网络配置必须显式处理该场景；普通 Wi-Fi 链路不会因 AMO 配对而自动加密。正式连接宜使用 HTTPS/WSS 或覆盖到服务器的 Tailscale 加密链路，不能关闭证书校验。Android 新版本的局域网权限需要按 targetSdk 适配。

手机退到后台或被系统回收时，电脑上的任务继续执行；回到应用后重新连接并同步。首版不承诺后台实时通知，不做 Focus，也不把常驻后台作为基础链路的前置条件。发出后未收到应答的命令标为“结果未确认”，不能盲目重发。

构建只为本次进程指定 JDK 17 / SDK，不改系统默认 Java，不影响已有 Unity 等项目（用户默认 Gradle 缓存曾加载 native-platform.dll 失败，换成单独的可写 GRADLE_USER_HOME 后正常，原因没查清，不因此重装工具链）。

Android 官方依据：[构建 JDK](https://developer.android.com/build/jdks)、[Keystore](https://developer.android.com/privacy-and-security/keystore)、[网络安全配置](https://developer.android.com/privacy-and-security/security-config)、[局域网权限](https://developer.android.com/privacy-and-security/local-network-permission)、[后台限制](https://developer.android.com/develop/background-work/background-tasks/bg-work-restrictions)。

## 视觉依据与主题

美术事实源为 packages/ui/src/styles/base.css、packages/ui/src/chat/chat.css、packages/ui/src/lib/theme.ts。主题默认浅色，与桌面一致；设置提供浅色、深色，也可沿用跟随系统选项，选择持久保存。

| 样式 | 浅色 | 深色 |
|---|---|---|
| 页面背景 --bg | #efede8 | #111316 |
| 面板 --panel | #fbfaf7 | #181b1f |
| 正文 --text | #22201c | #e6e8eb |
| 强调 --primary | #23436f | #7fb2ff |
| 边线 --border | #d9d3c7 | #2b3036 |
| 用户气泡 --chat-bubble | #ebe3d1 | #2c2c2e |
| 输入区 --chat-input-bg | #fbfaf7 | #232324 |

标题沿用 Noto Serif SC、界面 Noto Sans SC、代码 JetBrains Mono 的字体方向；字体随应用打包，不只依赖系统默认字体。普通控件圆角按 2/3/4 px 设计变量映射，对话气泡和输入区单独跟随 chat.css，不把所有组件统一成大圆角。

布局适配手机安全区、键盘、触控和字体缩放；颜色与组件特征保持一致，点击区域适当扩大。验收覆盖任务列表、任务会话列表、对话、审批/提问、查看页和设置的浅深两套截图。

## 还没验的

- 真实 Android 手机上 Wi-Fi / Tailscale 切换的实网表现，Android 9–15 的各系统版本（首版只在 API 36 模拟器上验过；用户 10-31 在自己手机上装过 0.1.2，见 `plans/done/android-mobile-redesign.md`）。
- 真机联调要用户提供 Android 设备；Tailscale 实测要先确认团队服务器的接入地址和访问规则。
