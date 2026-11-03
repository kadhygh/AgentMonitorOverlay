# iOS 版 AMO Studio：方案与进度

目标：AMO Studio 手机端的 iOS 版，用 TestFlight 内部测试装到我们自己的设备上，**不上架 App Store**。功能范围跟 Android 版一样（`plans/android-studio.md`、`plans/android-mobile-redesign.md`、`mobile/README.md`）：登录，通过中转的 devices 协议和 Host 的 `rt.*` 命令连上电脑，查看和操作任务与会话（对话、审批、提问、停止、文件）。没有通知，也不在后台常驻。以后要一直更新，所以打包上传要有一套**从头到尾不用 AI 介入**的脚本流程（见「发布流程」）。

## 用户定的（2026-11-02）

| 事 | 决定 |
|---|---|
| 分发 | TestFlight 内部测试，不走 Ad Hoc（打包机本来就走这条路） |
| 代码路线 | **Kotlin Multiplatform + Compose Multiplatform**：协议层、数据层和界面跟 Android 共用，功能只改一处。动 Android 工程结构的部分，开工前先跟用户说清楚怎么拆 |
| 目录 | `studio/android` 改名为 `studio/mobile`（第 1 步已做） |
| App 记录 | **已建好**（用户经日常维护会话转来）：App 名称 `AMOStudio`，Bundle ID **`com.gorilla.amo`**，Team ID `D39JR23NC7`，Apple ID（App 的编号）`6829620999`，描述文件 `AMOStudio_AppStore`。iOS 用这个 Bundle ID；Android 的 applicationId 仍是 `dev.amo.studio`，不改 |
| 测试人员 | 先不管：先把包打好、传上 TestFlight，之后用户让 wunaiyu 邀请测试的人 |
| 发布 | 接进 `npm run release`，新工具 id `ios`；Windows 通过 `ssh mac` 驱动打包机；不上 Jenkins。细节见「发布流程」 |
| 上传凭据 | App Store Connect API Key（.p8），**只放在 Mac 上**（`~/.appstoreconnect/private_keys/`），Key ID 和 Issuer ID 放在 Mac 上的配置文件里；不进仓库，也不通过环境变量从 Windows 传。Key 由用户或 wunaiyu 在 App Store Connect 里生成（App Manager 权限） |
| 打包机 | 装软件这类事用户自己能做主；到那一步时我先问一声 |

## 约束

- 打包机（`ssh mac`）上的命令都用 `nice` 低优先级跑，避开 Unity 出包的时间。不改、不删、不新建证书；描述文件只用 `AMOStudio_AppStore`，不碰游戏的。
- 上传构建、往打包机装东西之前，先问用户。在 App Store Connect 或开发者网站里不建、不改东西。
- 第一次自动跑通之前，先在打包机上手动验证签名和导出。

## 打包机现状（2026-11-02 只读检查）

- macOS 27.0.1，arm64，Xcode 27.2（27B52），iOS SDK 27.2 和模拟器 SDK 27.2 都有；数据盘还剩 3.1 TiB；git 2.54。
- 签名身份：`Apple Distribution: Wu Naiyu (D39JR23NC7)`、`Apple Development: Wu Naiyu (333GJH539J)`。Xcode 里登录了 1 个账号。
- **`AMOStudio_AppStore` 已装好**（2026-11-02，用户通过 RustDesk 在 Xcode 里下载）：App ID `D39JR23NC7.com.gorilla.amo`；App Store 类型（没有登记设备，`get-task-allow` false，`beta-reports-active` true，可以走 TestFlight）；里面的证书是 `Apple Distribution: Wu Naiyu (D39JR23NC7)`，打包机上有它的私钥；2027-06-10 到期。远程桌面用 RustDesk 直连 `172.16.8.85`（端口 21118），没有开 macOS 自带的屏幕共享。
- 原来没有 JDK；11-02 装了 Temurin 21.0.13 在 `~/amo-ios-build/jdk`（用户级）。没有 xcodegen 和 tuist（工程是手写的 pbxproj）。
- 11-02 装了 iOS 27.2 模拟器运行时（`xcodebuild -downloadPlatform iOS`，用户同意），有 iPhone 18 Pro 等设备。
- **钥匙串**：搜索列表是 `jenkins-build.keychain-db` + `login.keychain-db`。分发证书和私钥在 **jenkins-build** 里（不在 login 里），这个钥匙串平时锁着，Jenkins（`homebrew.mxcl.jenkins-lts`，LaunchAgent，跑在桌面会话里）打包时自己解锁；私钥**导不出来**（用户 11-02 试过）。Jenkins 用 `~/.jenkins/bin/xcodebuild` 包一层：先用 `~/.jenkins/secrets/build-keychain-password`（600）解锁 jenkins-build，**只解锁、从不锁回去**。iOS 打包照这个办法（11-03 定），见「发布流程 · 钥匙串」。
- 48 GB 内存、15 核。
- 检查时 Unity Hub 和 accelerator 开着，但没有在出包（load 约 1.0）。

## 验证记录

**第 0 步 · 只编不签（2026-11-02，✓）**：在打包机的 `~/amo-ios-spike/Hello/` 下手写了一个最小的 SwiftUI 工程（`project.pbxproj` 用 objectVersion 77 和文件夹同步组）。`nice -n 15 xcodebuild archive … CODE_SIGNING_ALLOWED=NO` 结果是 `** ARCHIVE SUCCEEDED **`，耗时 3.3 秒，产出 arm64 的 `Hello.app`，没有签名。只证明 Xcode 和 iOS SDK 的工具链能用。

**第 1 步 · 改名 + KMP 结构（2026-11-02，✓）**：`studio/android` 改名为 `studio/mobile`，新加 `shared` 模块（`org.jetbrains.kotlin.multiplatform` 2.4.10 + `com.android.kotlin.multiplatform.library` 9.3.1 + Compose Multiplatform 1.11.1，material3 1.9.0；在 Android 上用的仍是 androidx compose 1.11.x / material3 1.4.0）。除 `MainActivity` 外的 11 个文件和 3 个字体都挪到 `shared/src/androidMain`，`app` 只剩外壳并依赖 `:shared`。代码只改了三处：`BuildConfig` 改成从安装包读取版本号（`StudioRepository.versionCode/versionName`）；字体改用 `dev.amo.studio.shared.R`；`isolatedHtml`、`localFileTarget` 从 internal 改成 public，因为 `app` 里的 `FilePolicyTest` 跨模块用到它们。验证：`:app:assembleDebug`、`:app:assembleDebugAndroidTest`、`:app:lintDebug` 都通过；APK 解压后 74.8 MB（0.2.0 是 74.9 MB）；模拟器 FakeNga_UI_API_36 + `node scripts/android-fixture.mjs`，`test.ps1` 共 `OK (6 tests)`。第一次跑失败过一次，是模拟器刚启动完，分开跑和重跑都通过。设置页截图里的版本号「0.2.0」和中文字体都正常。`scripts/android-publish.mjs` 改指 `mobile/`，它的单测 3 条通过。没提交。

**第 2a 步 · 数据层进 commonMain（2026-11-02，✓）**：`Models`、`HistoryCache`、`StudioRepository` 挪进 `shared/src/commonMain`。org.json 换成 `Json.kt`：同名的 `JSONObject` / `JSONArray`，照 Android 自带 org.json 的规则（JSON null 的 optString 是 "null"，字符串能转数字和布尔值，put null 就是删掉这个键，2.0 输出成 2，键保持插入顺序，相等按对象本身比较），解析和输出交给 kotlinx.serialization，这样一百多处调用只要删掉 import。OkHttp 换成 Ktor 3.5.2（3.6 带的 okhttp 5.5 要求 compileSdk 37）；java.io/MessageDigest 换成 okio；java.time 换成 kotlinx-datetime。手机相关的东西放在 `Platform` 接口后面（`Platform.kt`），Android 的实现是 `AndroidPlatform.kt`：Keystore 加密原样搬过去，HTTP 用 OkHttp 引擎（ping 15 秒、连接超时 10 秒、读超时 30 秒，跟原来一样），自更新是 `AndroidUpdater`。`StudioRepository(context)` 的写法照旧能用。踩到的坑：服务器地址是 http:// 时，Ktor 的 WebSocket 地址要换成 ws://，不然发出去的是普通 GET，服务器回 404，连接就一直悄悄重试（日志查出来的）。验证：新加 `shared/src/commonTest/JsonTest.kt` 10 条（`:shared:testAndroidHostTest`）；assembleDebug、androidTest、lint 都过；模拟器 + 夹具 `test.ps1` 共 `OK (6 tests)`，对话页截图正常。没验证的：被别的设备挤掉（4001）和登录失效（401）这两条路，没有测试覆盖，靠的是读代码。

**第 2b–2c 步 · 界面和文件查看进 commonMain（2026-11-02，✓）**：两步并成一次做，因为 `StudioUi`、`ChatUi` 都要用 `FileViewer`。`AmoTheme`、`AmoControls`、`Icons`、`Markdown`、`ChatUi`、`StudioUi`、`FileUi` 和三个字体都挪进 `shared/src/commonMain`，`androidMain` 只剩 `AndroidPlatform.kt`、`AppUpdate.kt` 和新的 `FileViews.android.kt`。改的地方：字体从 `res/font` 换成 Compose 资源（`compose.resources`，`Res` 在 `dev.amo.studio.res`）；`BackHandler` 换成 CMP 的 `ui-backhandler`（1.11 里标了过时、建议 NavigationEventHandler，先用着，能用）；对话草稿原来直接开 SharedPreferences「chat-drafts」，现在走 `Platform.drafts`，`Prefs` 加了 long 值和 `edit(now = true)`（发送前同步写盘，和原来的 commit() 一样）；草稿键的 SHA-256 换成 okio，结果和原来一样，已有草稿不丢；`"%.1f"` 换成 `megabytes()`；Markdown 的解析缓存从 WeakHashMap 换成挂在 JSONObject 上的 `memo`；`Uri.decode` 换成 `percentDecode()`（照 Android 的规则：`+` 不变，坏的转义变 U+FFFD）。HTML 预览和图片解码用 `expect/actual`：`HtmlView`、`decodeImage`，Android 那份就是原来的 WebView 和 BitmapFactory 代码原样搬过去。设置页的「更新」只在能自更新的平台显示，iOS 显示成「版本」和当前版本号（TestFlight 管更新）。验证：新加 `commonTest/SharedUiTest.kt` 4 条，加上 JsonTest 共 14 条通过；assembleDebug、androidTest、lint（0 错误，12 条都是版本提示）都过；模拟器 + 夹具 `test.ps1` 一次 `OK (6 tests)`；截图看过对话页、设置页、HTML 和 Markdown 查看，字体和以前一样。

**第 2d 步 · iOS 目标和 iosApp（2026-11-02，写完、模拟器里能启动；没提交前的验证见下）**：
- `shared` 加了 `iosArm64`、`iosSimulatorArm64`，静态框架 `Shared`；Windows 上这两个目标自动跳过（`gradle.properties` 的 `kotlin.native.ignoreDisabledTargets=true`）。iosMain：`IosPlatform.kt`（版本号读 Info.plist；文件放 Application Support；设置用 NSUserDefaults，草稿用 suite `chat-drafts`；Ktor Darwin 引擎，WebSocket 每 15 秒 ping；**账号密钥加密**：钥匙串里一把 EC 私钥（`dev.amo.studio.token`，`AfterFirstUnlockThisDeviceOnly`），ECIES + AES-GCM 加解密，设置里只存密文，跟 Android 的 Keystore 一个意思；没有自更新）、`FileViews.ios.kt`（WKWebView：非持久的数据存储，只放行页面本身和它的 #锚点，别的链接一律取消、交给 `localFileTarget`；没有 viewport 的报告补一个；图片用 Skia 解码，超大的缩小，规则跟 Android 一样）、`MainViewController.kt`（回到前台 refresh，进后台 persist）。
- 共用代码里又清掉三处 JVM 专有的：`"%.1f".format` → `oneDecimal()`（四舍五入跟 Java 一样是 half-up），`Math.toRadians/cos/sin` → `kotlin.math`；`JSONObject.NULL` 在 Objective-C 头文件里叫 `NULL` 会撞 C 的宏，加了 `@ObjCName("jsonNull")`。
- `mobile/iosApp/`：手写的 `iosApp.xcodeproj`（objectVersion 77、文件夹同步组、共享 scheme `iosApp`），`iosApp/iOSApp.swift`（SwiftUI 只是外壳）、`Assets.xcassets`（1024 图标由 `make-icon.py` 按 `design/icon/tools/studio.svg` 画）、`Info.plist`（只放 ATS `NSAllowsLocalNetworking`、本地网络说明、`ITSAppUsesNonExemptEncryption=NO`、高刷）、`Config.xcconfig`（Bundle ID、Team、手动签名）、`Version.xcconfig`（`MARKETING_VERSION = 0.0.0`，第一次发布用 `--minor` 得到 0.1.0）。构建阶段「Compile Kotlin」跑 `:shared:embedAndSignAppleFrameworkForXcode`，JAVA_HOME 从打包机的 `~/.amo-ios/config` 读。只支持 iPhone、iOS 16 起。
- Kotlin/Native 的 release 链接 2 GB 堆不够（GC 抖死），Mac 上的 Gradle 都在命令行带 `-Dorg.gradle.jvmargs=-Xmx6g`，不改 `gradle.properties`（Windows 不受影响），也不碰打包机的 `~/.gradle`（Unity 的 Gradle 在用）。
- 验证：打包机上 `:shared:linkDebugFrameworkIosSimulatorArm64`、`linkReleaseFrameworkIosArm64` 通过；`xcodebuild` 模拟器 Debug 构建 `BUILD SUCCEEDED`，装进 iPhone 18 Pro 模拟器启动，登录页截图（`studio/screenshots/ios/login.png`）字体、安全区都对。Windows 上 Android assembleDebug、androidTest、lint、`:shared` 共用测试 14 条都过（最后一次在 11-02 晚）。**没验证**：登录之后的页面（模拟器连不到这台电脑上的测试夹具，要么在 Mac 上跑夹具，要么等 TestFlight 装到真机上用自己的账号看）；WKWebView 的拦截、钥匙串加解密、Darwin 的 WebSocket ping 都没在运行时试过；改了共用代码之后没有再跑模拟器 `test.ps1`。

**第 3 步 · 签名（2026-11-02 卡住，11-03 ✓）**：`build-on-mac.sh --no-upload` 在打包机上跑到第 4 步：Kotlin、Swift 都编过、链接过，xcodebuild 选对了身份 `Apple Distribution: Wu Naiyu (D39JR23NC7)` 和描述文件 `AMOStudio_AppStore`，停在 codesign：SSH 下报 `errSecInternalComponent`；改到桌面会话里跑（LaunchAgent）后，弹窗要 jenkins-build 钥匙串的密码。用户不想动 jenkins-build，想要 iOS 自己的钥匙串，但私钥导不出 p12。11-02 晚的三条路见「发布流程 · 钥匙串」。
11-03：wunaiyu 在 SSH 下试过：直接签仍是 `errSecInternalComponent`，先用 Jenkins 的密码文件解锁 jenkins-build 再签就成功（Team D39JR23NC7），不用改私钥的访问权限。用户定走「只解锁 jenkins-build」。`build-on-mac.sh` 第 2、5 步改成解锁 jenkins-build（直接读 Jenkins 的密码文件，不复制），然后在打包机上用**普通 SSH**（不经 LaunchAgent）跑 `build-on-mac.sh … 0.1.0 1 --no-upload`：8 步全过，退出码 0，产出 `~/amo-ios-build/runs/0.1.0-1/export/AMOStudio.ipa`（38 373 531 字节）。核对 ipa：`codesign --verify --deep --strict` 通过；Identifier `com.gorilla.amo`、TeamIdentifier `D39JR23NC7`；内嵌的描述文件是 `AMOStudio_AppStore`；entitlements 是 application-identifier `D39JR23NC7.com.gorilla.amo`、get-task-allow false、beta-reports-active true；版本 0.1.0、构建号 1。第 6 步 validate 因为还没有 API Key 跳过了。LaunchAgent 那一套随之删掉（`submit-build.sh`、`agent/`、`--install-agent`），`ios-release.mjs` 改成直接 ssh 跑 `nice -n 10 bash build-on-mac.sh`。

## 工程结构（KMP）

```
studio/mobile/
  settings.gradle.kts           ← :app、:shared
  shared/                       ← KMP 模块：android + iosArm64 + iosSimulatorArm64
    src/commonMain/             ← 协议、模型、StudioRepository、HistoryCache、全部 Compose 界面、Markdown、主题、字体（composeResources）
    src/androidMain/            ← Keystore、SharedPreferences、WebView、文件选取、AppUpdate
    src/iosMain/                ← Keychain、NSUserDefaults、WKWebView、文件选取；MainViewController()
    src/commonTest/             ← 不依赖平台的逻辑测试（从 androidTest 里挑出来）
  app/                          ← Android 外壳（applicationId dev.amo.studio，APK 路径不变）
  iosApp/                       ← iOS 外壳
    iosApp.xcodeproj            ← 一个 target（产物 AMOStudio.app），Bundle ID com.gorilla.amo；链接静态框架 Shared；共享 scheme iosApp
    iosApp/                     ← iOSApp.swift（SwiftUI 外壳）、Assets.xcassets（AppIcon）
    Info.plist、Config.xcconfig ← 合进生成的 Info.plist 的几项；Bundle ID、Team、手动签名
    Version.xcconfig            ← MARKETING_VERSION（release.mjs 改它）
    CHANGELOG.md                ← iOS 的改动说明，「## 下一版」
    build-on-mac.sh             ← 在打包机上跑的那一段（见「发布流程」）
    make-icon.py                ← 画 AppIcon
```

### 第 2 步怎么拆（开工前跟用户确认）

只动 `shared` 里的源码，不再动模块结构；Android 的外壳、包名、版本号、APK 都不变。分四段，每段都跑一遍 Android 的编译、lint 和 `test.ps1`，每段一个提交：

| 段 | 内容 | 平台相关的换成什么 |
|---|---|---|
| 2a 数据层 | `Models`、`HistoryCache`、`StudioRepository` 进 commonMain | `org.json` → kotlinx.serialization-json；OkHttp → Ktor（Android 用 OkHttp 引擎，iOS 用 Darwin 引擎）；`File`/`MessageDigest` → okio；`Base64`/`UUID`/`SystemClock` → Kotlin 标准库；Keystore、SharedPreferences、数据目录 → 一个 `Platform` 接口，Android 和 iOS 各实现一份 |
| 2b 界面 | `AmoTheme`、`AmoControls`、`Icons`、`Markdown`、`ChatUi`、`StudioUi` 进 commonMain | 字体换成 Compose 资源；`BackHandler` 换成 CMP 自带的；`Context` 只留在 Android 那份实现里 |
| 2c 文件 | `FileUi` 拆开：查看规则和图片解码进 commonMain | HTML 预览和文件选取用 `expect/actual`：Android 用 WebView，iOS 用 WKWebView |
| 2d iOS | 加 `iosArm64`、`iosSimulatorArm64` 目标，写 iosMain，`MainViewController()` | 只能在 Mac 上编（要先装 JDK） |

`AppUpdate`（Android 自更新）和 `MainActivity` 一直留在 Android 那边。iOS 靠 TestFlight 更新。

## iOS 端要注意的

- **明文 HTTP/WS**：现在的服务器地址是 `http://172.16.8.85:47120`（Android 靠 `usesCleartextTraffic="true"` 放行）。iOS 要在 Info.plist 里配 ATS 例外：`NSAllowsLocalNetworking`，不够的话加 `NSExceptionDomains`，要用真机试过才知道（**未验证**）。不能关证书校验。
- **本地网络权限**：iOS 14 起，访问局域网地址要写 `NSLocalNetworkUsageDescription`，第一次连接时系统会弹窗。走 Tailscale（100.x）时会不会弹，**未验证**。
- **Tailscale**：iOS 设备要在外网用，照现在 szk、al20 的办法，在这台电脑上给它加一条转发（先问用户）。
- **后台**：iOS 进入后台不久就会挂起 App，WebSocket 会断。跟 Android 一样不做后台常驻，回到前台时重连并补拉历史。
- **出口合规**：Info.plist 写 `ITSAppUsesNonExemptEncryption = NO`（只用系统自带的加密），这样每次上传不用回答出口合规问题。
- **图标**：TestFlight 上传要求有 1024×1024 的 AppIcon，用 Android 的 `ic_amo` 转一张。
- **构建 90 天过期**：TestFlight 的构建 90 天后不能再装，到期前要重新发一次。

## 发布流程（`npm run release -- ios`）

要求：一条命令从头跑到尾，不用 AI 介入；只从提交过的 master 打包；每一步失败都停下，写清卡在哪一步，输出存日志。以后「自动打包」值守的 `auto --if-due` 也能带上它。

### Windows 这边（`scripts/release.mjs` + 新的 `scripts/ios-release.mjs`）

1. `release.mjs` 的 TARGETS 加 `ios`（没放进 `amo-tools.mjs`：那里是平台工具，别的脚本会遍历它）：
   - 版本号：`mobile/iosApp/Version.xcconfig` 里的 `MARKETING_VERSION`；改动说明：`mobile/iosApp/CHANGELOG.md`；
   - 算作它的改动：`studio/mobile/shared`、`studio/mobile/iosApp`、`studio/mobile/*.gradle.kts`、`studio/mobile/gradle`；
   - tag：`ios-v<版本>`。
2. 跟其他工具一样：检查（在 master 上、要打包的部分没有未提交的改动——发 ios 时 `studio/mobile` 也算，「下一版」有内容）→ 测试 → 版本号 +1，「下一版」改成 `## <版本>（日期）` → 提交进 master → **打包上传**（下面）→ tag → 问题页标已发布。测试这一步叫「移动端测试」：`mobile/build.ps1 -Tasks :shared:testAndroidHostTest,:app:assembleDebug`；只发 ios 时不跑 npm 的类型检查和单测。iOS 编译放在打包机上，那一步就是检查。没有 tag 之前 `due` 不会列它，所以第一次要手动 `npm run release -- ios --minor`（问过用户）。打包机正忙时这次算「没发出去」，不写失败记录，下次 `release ios` 补发（版本号不再加）。
3. 打包上传（`ios-release.mjs`）：
   - **构建号**（CFBundleVersion）自动生成：这次提交在 master 上的提交数（`git rev-list --count <提交>`），只增不减，也能反查是哪个提交。不用手填。
   - **把代码送到打包机**：`git archive <提交> studio/mobile` 通过 ssh 直接解到 `~/amo-ios-build/src/<短提交号>/`。用的是提交里的内容，不是磁盘上的，也不依赖打包机能访问 GitHub。
   - 通过 ssh 直接跑 `nice -n 10 bash build-on-mac.sh <源码目录> <版本> <构建号>`，输出实时打印，退出码照传（11 = 打包机正忙，10+N = 停在第 N 步）。11-03 起不经 LaunchAgent：解锁过的 jenkins-build 在 SSH 下就能签。
   - 打包机上的日志拷回本机 `studio/release/ios/<版本>-<构建号>/`（`release/` 已被 gitignore 忽略），失败时打印「iOS 打包停在第 N 步「…」」和日志的最后 40 行。

### 打包机这边（`mobile/iosApp/build-on-mac.sh`，跟着仓库走）

每一步一份日志，放在 `~/amo-ios-build/logs/<版本>-<构建号>/NN-<步骤>.log`；任何一步非 0 退出就停下，用不同的退出码表示停在哪一步。

| 步 | 做什么 | 失败时 |
|---|---|---|
| 1 忙不忙 | 有 Unity 在跑 `-batchmode`，或者有别的 `xcodebuild` 在跑，就不开始 | 「打包机正忙」，退出；`auto` 下次再试 |
| 2 配置 | 读 `~/.amo-ios/config`（`ASC_KEY_ID`、`ASC_ISSUER_ID`、`JAVA_HOME`），检查 `.p8` 文件、描述文件、签名身份都在 | 写清缺哪一样 |
| 3 KMP | `./gradlew :shared:linkReleaseFrameworkIosArm64`（`--no-daemon`、最多 2 个 worker、`-Xmx6g`）；archive 里的构建阶段再跑一次时是 up-to-date | Gradle 日志 |
| 4 archive | `xcodebuild archive … CODE_SIGNING_ALLOWED=NO`（先不签），`MARKETING_VERSION`、`CURRENT_PROJECT_VERSION` 由参数传入，DerivedData 放在这次的目录里 | xcodebuild 日志 |
| 5 签名、打 ipa | 自己做 Xcode 导出做的事：拷出 `.app`，放进描述文件，按描述文件写 entitlements（application-identifier、team-identifier、get-task-allow=false、beta-reports-active=true），`codesign --keychain <钥匙串> --sign <SHA1>`，`codesign --verify --strict`，zip 成 `Payload/` 的 `.ipa`。不用 `-exportArchive`：当初是为不在搜索列表里的 iOS 自己的钥匙串写的；改用 jenkins-build（在搜索列表里）以后，自己签也照样能用，就没换 | codesign 日志 |
| 6 校验 | `xcrun altool --validate-app -f <ipa> -t ios --apiKey … --apiIssuer …` | 苹果返回的错误 |
| 7 上传 | `xcrun altool --upload-app`（同样的参数）；altool 在 Xcode 27 里不能用时改用 `iTMSTransporter`，手动验证时确定用哪个 | 同上 |
| 8 清理 | 源码和 DerivedData 只留最近 3 次，日志留 20 次 | 不算失败 |

Mac 上的配置文件 `~/.amo-ios/config`（权限 600，不进仓库）只放 Key ID、Issuer ID 和 JDK 路径。`.p8` 放在 altool 默认会去找的 `~/.appstoreconnect/private_keys/AuthKey_<KeyID>.p8`。altool 的命令行只带 Key ID 和 Issuer ID，不带 key 的内容。

### 钥匙串（11-03 定：只解锁 jenkins-build）

分发证书 `Apple Distribution: Wu Naiyu (D39JR23NC7)` 和私钥在 Jenkins 的 `~/Library/Keychains/jenkins-build.keychain-db` 里，私钥导不出来。`build-on-mac.sh` 照 Jenkins 自己的 `~/.jenkins/bin/xcodebuild` 的做法：读 `~/.jenkins/secrets/build-keychain-password` 解锁它（第 2 步，第 5 步签名前再解锁一次），再用 `codesign --keychain` 指定它签。

- **不改的**：钥匙串的内容、搜索列表、自动上锁设置、私钥的访问权限（partition list）都不动；密码不复制到别处。
- **只解锁、不锁回去**：Jenkins 也从不锁回去，所以两边不会在对方签名时把钥匙串锁上。第 1 步遇到 Unity 出包或别的 `xcodebuild` 在跑就不开始。
- **会断的情况**：有人改了 jenkins-build 的密码，或者换了密码文件的位置，iOS 打包会停在第 2 步「解不开 …」，不影响 Jenkins。证书到期（2027-06-10）或被吊销时，iOS 和游戏一起受影响。

11-02 试过、后来放弃的：在桌面会话里经 LaunchAgent `com.amo.ios-build` 跑（会弹窗要 jenkins-build 的密码），以及 iOS 自己的钥匙串 `setup-keychain.sh`（私钥导不出来，走不通）。这两套代码 11-03 已删。打包机上 LaunchAgent 的残留（`~/Library/LaunchAgents/com.amo.ios-build.plist`、`~/amo-ios-build/agent`、`queue`、`jobs`）**还没卸**：自动审批拦下了删除，等用户点头。卸的命令：`launchctl bootout gui/$(id -u)/com.amo.ios-build`，再删上面这几样。

### 第一次跑通之前（手动验证）

1. 打包机装 JDK（用户级）。**先问**。
2. 把 `AMOStudio_AppStore` 装到打包机上（用户或 wunaiyu 来做，或者同意我在 Xcode 里点 Download Manual Profiles）。
3. 先用一个最小的 iosApp（只显示 shared 里的一屏，Bundle ID `com.gorilla.amo`），手动跑第 3–5 步：确认签名、导出 ipa，再用 `codesign -dv` 和 `security cms -D` 核对 ipa 里的描述文件和团队。同时试出钥匙串用哪种方式。
4. 用户或 wunaiyu 生成 API Key，放到打包机上；手动跑第 6 步 validate（不上传）。
5. **问过用户后**，跑完整的 `npm run release -- ios`，第一次上传。TestFlight 里出现构建、处理完成就算通过。

## 步骤

| 步 | 内容 | 状态 |
|---|---|---|
| 0 | 打包机上空的 SwiftUI 工程只编不签，确认工具链 | ✓ 2026-11-02 |
| 1 | `android/` 改名 `mobile/`，改成 KMP 结构（先只有 androidMain），Android 测试不变 | ✓ 2026-11-02 |
| 2a | 数据层进 commonMain | ✓ 2026-11-02 |
| 2b–2c | 界面、文件查看进 commonMain（用户 11-02 确认了拆法） | ✓ 2026-11-02 |
| 2d | 加 iOS 目标、iosMain、iosApp；在 iOS 模拟器上跑通并截图。JDK 11-02 已装：Temurin 21.0.13，在打包机的 `~/amo-ios-build/jdk`，SHA-256 核对过 | ◐ 11-02 模拟器里能启动、登录页正常；登录后的页面没看 |
| 3 | 手动验证签名和导出（见上面 1–4） | ◐ 11-03 签名、导出 ipa 在 SSH 下跑通并核对过；validate 等 API Key（Mac 上的 config 两个 ID 还空着，`~/.appstoreconnect/private_keys/` 是空的） |
| 4 | `ios` 接进 `npm run release`：`ios-release.mjs`、`build-on-mac.sh`、TARGETS、CHANGELOG；脚本自己的单测 6 条 | ◐ 写完、单测过、`due` 和 dry-run 试过；11-03 去掉 LaunchAgent，直接 ssh 跑；`npm run release -- ios` 整条还没跑过（要等 API Key，而且会上传） |
| 5 | 问过用户后第一次上传；用户的设备通过 TestFlight 装上，Wi-Fi 下跑一次完整的对话、审批和文件查看 | ○ |
| 6 | 外网（Tailscale）实测；`auto --if-due` 带上 ios | ○ |

## Mac 能不能打 Android 包

能。改成 KMP 之后还是同一个 Gradle 工程，Mac 上装了 JDK 和 Android SDK 就能打 APK；iOS 部分只能在 Mac 上编。现在 Windows 上打 Android 很顺，所以不急着在 Mac 上装 Android SDK。

## 待定

- altool 还是 iTMSTransporter（手动验证时定）。
- Android 要不要也接进 `npm run release`（现在走 `relay-mac.mjs android-publish`）。不在这次的范围里。
