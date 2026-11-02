# Android 版 AMO Studio：首版实现与验收

更新日期：2026-10-31。已完成独立 Android 工程、APK 构建、模拟器登录配对及远程任务流程。以下新增实现记录为当前状态；后面的调查记录保留环境与协议依据，其中“未验证”描述的是开发前状态。

## 首版实现

- 工程：`studio/android`，Kotlin + Compose + OkHttp；Android 9 / API 28 起，target API 36。
- 登录团队账号、选择同账号电脑申请配对、显示已授权任务、创建任务并立即启动首个会话、同任务下新会话、流式对话、审批、回答提问和中断。
- HTML、Markdown、图片和文本查看；HTML 支持内联交互，文件链接重新交 Host 授权。外部脚本、样式、图片等子资源不加载。
- Keystore 加密登录令牌；按服务器和账号隔离历史缓存与草稿；前台恢复同步、断线重连，未确认命令不自动重发。
- AMO 的浅色、深色、跟随系统；沿用桌面颜色、图标、字体、小圆角，适配系统安全区、软键盘及旋转。
- 手机不运行模型；无 Focus、批注、书签、画布、终端和 Git Review。附件上传、完整桌面 Markdown 扩展、后台实时通知留到后续。
- 没有修改生产 Host / Relay 的协议或部署；测试使用独立 Host 数据目录和专属模拟器。

## 当前验证记录

- 已通过：APK 和 instrumentation APK 构建；Android Lint（0 errors）。
- 已通过：本地隔离 Relay 的 RepositoryIntegrationTest 与 ReliabilityIntegrationTest；覆盖创建任务/首会话、继续对话、新会话、缓存恢复、审批、提问、重新连接、撤回授权、文件读取和分块校验。
- 已通过：团队服务器上的真实 Dxx-DS 模型，Android RepositoryIntegrationTest；首轮、追加消息、第二会话三条明确字面量响应及缓存恢复。本轮总计 5 次真实模型调用（包括启动检查和一次歧义提示重测），未调用其他真实模型。
- 已通过：Node 端远程兼容性测试，本地及团队 Relay 均覆盖配对、消息、审批、提问、撤回/重授权及 7 个文件的内容校验。
- 已通过：团队服务器模拟器完整 mock 验收，协议/可靠性 5 项测试（7.31 秒）及 UI 1 项测试（18.892 秒）；UI 包含登录配对设备、新建任务、连续对话、HTML 内容及内联按钮、嵌套 HTML → Markdown、新会话、浅深主题、横竖屏草稿保留及软键盘。
- 已通过：360 dp 窄屏、1.3 倍系统字体下同一套 UI 验收（19.319 秒）。已人工查看标准/窄屏、键盘、横屏、深色和查看器截图，未见关键操作遮挡。截图来源为 mock；`real-dxx-chat.png` 是真实模型响应。
- 未验证：真实 Android 手机、实际 Tailscale 网络切换、Android 9–15 的各系统版本。模拟器为 API 36；可填写 Tailscale IP / MagicDNS 地址，但不据此宣称实网已验。

复现命令与使用方式见 `studio/android/README.md`。原始测试输出在 `studio/android/out/`，截图在 `studio/screenshots/android/`。APK 使用调试签名，供本次内部验收。

## 交付

- APK：`studio/android/out/AMO-Studio-Android-0.1.0-debug.apk`
- 文件大小：59,461,545 bytes。
- SHA-256：`8C8EE36968A198B45B3C4ABCE10B611DB0E8BB2A9F556963E54A8A8EF5F6C73C`
- 测试日志：`team-core.txt`、`team-ui.txt`、`team-ui-narrow.txt`、`team-real-dxx.txt`（均在 `studio/android/out/`）。
- 本轮遇到的连接清理并发、旋转截屏时序及已配对设备的测试识别问题已修正并重测通过。真实模型曾因提示歧义未输出断言标记，改为明确字面量后通过；未把该次等待中断算作模型通过。
- 未提交或推送；未改生产服务、未重启用户 Studio。测试服务与专属模拟器在验收结束后关闭；服务器上的独立测试账号保留，不影响正常账号。

---

## 开发前调查记录（2026-10-31）

## 结论

可以开发独立的 Android 远程客户端。账号、设备配对、远程任务和会话协议已有实现；手机端补充界面、协议客户端、凭据保护和恢复同步。模型、命令及项目文件始终由远端电脑的 Studio Host 执行和管理。

本机构建基础基本齐备：JDK 17 可运行，Gradle 9.5.0 在隔离的可写缓存目录中启动成功，Android API 36 和 Build Tools 36.0.0 已安装。完整 Android 构建链仍需用首个工程实际编译验证。

现有链路通过团队服务器转发。Wi-Fi 和 Tailscale 都按访问同一团队服务器设计；手机与电脑之间的直接连接不属于现有协议。

## 用户确认的首版边界

- 只做 Studio 的远程使用，手机不运行本地模型和本机会话。
- 保留登录、设备配对、创建 task、task 下创建 session、session 对话及查看。
- 操作行为以现有桌面客户端为准。创建任务同时创建并启动首个会话，之后可继续新建会话；不新增“只创建空任务”接口。
- 不做批注、书签、Focus 浮窗或弹出提醒，优先跑通基础功能。
- 不引入便签、中转聊天、平台安装管理、画布、Git Review、终端和本地模型配置页面。
- 严格沿用当前 AMO Studio 美术风格，提供浅色和深色主题设置。
- 审批、回答模型提问和中断作为会话操作保留在会话页内，不依赖 Focus。

## 已检查的本机环境

| 项目 | 结果 | 验证程度 |
|---|---|---|
| 当前命令行 Java | JAVA_HOME 指向 D:\DEVELOP\OpenJDK8U\ | 已读环境变量；不能直接作为新工程默认 JDK |
| 可用 JDK | C:\DEVELOP\UnityEditor\6000.3.11f1\Editor\Data\PlaybackEngines\AndroidPlayer\OpenJDK，17.0.9 | java -version 成功 |
| Gradle | 9.5.0 | 指定 JDK 17、隔离 GRADLE_USER_HOME 后 --version 成功，退出码 0 |
| Android SDK | C:\Users\Kangaroo\AppData\Local\Android\Sdk | 目录已检查；ANDROID_HOME、ANDROID_SDK_ROOT 未设置 |
| SDK Platforms | android-28、29、30、31、36 | 目录已检查 |
| Build Tools | 29.0.1、29.0.2、29.0.3、30.0.2、30.0.3、33.0.0、36.0.0 | 目录已检查 |
| Android Gradle Plugin | 缓存 9.3.1 | 缓存目录存在；未验证完整依赖和构建兼容性 |
| Kotlin Gradle Plugin | 缓存 2.4.10 | 缓存目录存在 |
| Compose UI / OkHttp | ui-android 1.11.4 / okhttp-android 5.3.0 | 缓存目录存在 |
| ADB | platform-tools 37.0.1 | adb devices -l 成功，当前没有已连接设备 |
| 模拟器 | FakeNga_API_35、FakeNga_API_36、FakeNga_DEV_API_36、FakeNga_UI_API_36、Pixel_3a_API_30_x86 | emulator -list-avds 成功；未启动、未检查镜像完整性 |
| Android Studio IDE | 注册表记录 2021.2，路径 C:\DEVELOP\Android\AndroidStudio | 目录仍在，但 bin/studio.exe 不存在；不能算可启动的 IDE |
| Tailscale | C:\Program Files\Tailscale\tailscale.exe | 已安装；当前执行身份读取服务状态被拒绝，未确认 tailnet 连通性 |

首次使用用户默认 Gradle 缓存时 native-platform.dll 加载失败；换为临时可写 GRADLE_USER_HOME 后成功。尚不能确定默认缓存失败的唯一原因，不应因此重装工具链。后续使用工程专用 JDK/SDK 配置，不改系统默认 Java，不影响已有 Unity 等项目。

## 服务与代码现状

实测 GET http://172.16.8.85:47120/api/health 成功：app=amo-relay，version=0.7.0，devices=1。仅验证当前电脑到服务器的健康接口，没有登录真实账号或执行真实远程任务。

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

packages/host/src/http/server.ts 将 Host API 绑定 127.0.0.1。Android 应接入设备协议，不连接电脑 Host 的本地管理 API。

桌面 B 端远程功能的一部分运行在本地 Node Host：持久化副本、同步、文件缓存和命令状态管理。因此直接把 packages/ui 放进 WebView 并不能获得可用的远程客户端。

## Wi-Fi 与 Tailscale

推荐链路：Android → 团队服务器 ← 远端电脑 Host。两端都主动连接服务器。

- Wi-Fi：手机可达团队服务器 172.16.8.85:47120 即可；同一个 Wi-Fi 名称并不保证跨网段可达，还需排除访客隔离等限制。
- Tailscale：优先让团队服务器和手机加入可互访的 tailnet，手机使用服务器的 Tailscale 地址或 MagicDNS 名称。电脑只需能连接同一服务器，电脑是否需要 Tailscale 取决于其所在网络。
- 如果服务器不装 Tailscale，可由已配置并批准路由的 subnet router 提供服务器所在网段的访问。
- 仅让手机和执行电脑加入 Tailscale，并不会自动让现有团队服务器可达；Tailscale 也不会取代 AMO 登录、配对和授权。
- 首版填写服务器地址、登录后列设备，不依赖局域网广播发现。
- 建议在 Tailscale 和 Wi-Fi 场景使用稳定的服务器地址；不要把切换 URL 默认为同一服务器。现有部分状态按 server + account 区分，地址别名迁移需要单独处理。

依据：[Tailscale 连接设备](https://tailscale.com/docs/how-to/connect-to-devices)、[MagicDNS](https://tailscale.com/docs/features/magicdns)、[子网路由](https://tailscale.com/docs/features/subnet-routers)。这是架构可行性判断，当前未完成手机到服务器的 Tailscale 实测。

## Android 实现建议

建议新增 studio/android 独立 Gradle 工程，采用 Kotlin + Compose + OkHttp，按现有设备协议实现远程控制端。Kotlin 类型和 TypeScript 协议应通过固定消息样例做兼容测试，避免两边字段逐渐不一致。

Compose 使用 AMO 自定义视觉组件和颜色，不采用默认 Material 外观或系统动态配色。文件查看可局部使用受隔离的 WebView；不向任务产生的 HTML 暴露凭据或原生桥接。

相比完整移植桌面 UI，这条路线更贴合已缩减的功能范围；代价是会话渲染、同步逻辑及主题变量需要在 Android 端适配，并持续核对桌面行为。若以后要求大量复用复杂桌面对话组件，再评估抽取纯 Web UI 模块。

登录复用团队服务器的账号和 API。用户明确要求 Android 内可登录，按移动端入口实施；无需另装 Android 平台应用。桌面端仍沿用平台登录，Windows DPAPI 文件代码不能原样搬到 Android。Android 使用 Keystore 中的密钥加密持久化令牌，不存明文密码。

当前服务器使用 HTTP/WS，Android 网络配置必须显式处理该场景；普通 Wi-Fi 链路不会因 AMO 配对而自动加密。正式连接宜使用 HTTPS/WSS 或覆盖到服务器的 Tailscale 加密链路，不能关闭证书校验。Android 新版本的局域网权限需要按 targetSdk 适配。

手机退到后台或被系统回收时，电脑上的任务继续执行；回到应用后重新连接并同步。首版不承诺后台实时通知，不做 Focus，也不把常驻后台作为基础链路的前置条件。发出后未收到应答的命令标为“结果未确认”，不能盲目重发。

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

标题沿用 Noto Serif SC、界面 Noto Sans SC、代码 JetBrains Mono 的字体方向；Android 的字体资产需核对适用格式和许可后打包，不能只依赖系统默认字体。普通控件圆角按 2/3/4 px 设计变量映射，对话气泡和输入区单独跟随 chat.css，不把所有组件统一成大圆角。

布局适配手机安全区、键盘、触控和字体缩放；颜色与组件特征保持一致，点击区域适当扩大。验收需覆盖任务列表、任务会话列表、对话、审批/提问、查看页和设置的浅深两套截图。

## 建议实施顺序及验收

1. 工程与主题：锁定构建版本，产出可安装 APK；实现登录、设备列表、配对和浅深主题。
2. 基础闭环：选择远端设备与允许的项目/模型 → 创建任务及首个会话 → 流式对话 → 同任务新会话；保持桌面操作语义。
3. 会话控制及查看：审批、回答提问、中断、历史恢复，HTML/Markdown/图片/文本查看。工具调用结果的展示作为对话内容保留。
4. 可靠性：断网重连、Wi-Fi/Tailscale 切换、授权撤回、退出再进、前后台切换、未确认命令防重复。
5. 验收：隔离的 Relay + mock Host 联调；API 36 模拟器截图；手机真机与远端电脑分别走 Wi-Fi、Tailscale。

当前无需更改现有创建任务语义。联调发现协议缺口时再做最小兼容扩展，不提前改动主机授权边界。

## 验证范围与剩余事项

- 已实测：JDK 17 运行、隔离目录 Gradle 启动、ADB 设备枚举、AVD 枚举、团队服务器健康接口。
- 仅静态核对：已有协议、授权与同步实现、SDK/依赖缓存目录、浅深主题变量。
- 未验证：APK 编译安装、模拟器启动、真实登录配对、手机 Wi-Fi/Tailscale、真机会话恢复与文件查看。
- 后续开发负责：创建 Android 工程并执行上述验收；不把缓存存在视作已构建成功。
- 真机联调时需要用户提供可连接的 Android 设备；Tailscale 实测需先确认团队服务器的接入地址和访问规则。当前不阻塞工程开发。
