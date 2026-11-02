# 交接：AMO 的当前状态

新会话先读这份。长期有效的规则（工具和包的对应、架构约束、怎么干活）在仓库根目录的 `AGENTS.md`，这里只写现在的状态和最近的改动。做完一段，在「最近的改动」最上面加一条（做了什么、怎么验证的、还剩什么）。

更早的记录（10-13 到 10-25，原来这份文件的大部分）原样挪到了 `docs/history/handoff-2026-10.md`；做完的阶段计划在 `plans/done/`，/loop 自动迭代时期的文档（STATUS、NEEDS_YOU、ROADMAP、LOOP_RULES、LOOP_LOG）在 `docs/archive/`。查某个功能当初为什么这么做，先在这几处搜。

## 当前状态

### 在哪、怎么跑

| 项目 | 内容 |
|---|---|
| 开发目录 | `G:\PROJECT\AgentMonitorOverlay\studio`（桌面快捷方式「AMO Source」指这里的 `start-studio.cmd`） |
| 分支 | `master` 是主线；旧版 AMO 在标签 `amo-legacy-final` |
| worktree | `G:\PROJECT\AgentMonitorOverlay-review`（分支 `studio/stage3-topics`，已经都合进 master，没有未合并的提交） |
| 开发版 | `npm start`（先 build 再开窗口），数据在 `studio\.data`。Host 常驻在 47900 端口；改了 Host 代码要先 `npm run host:stop` 再 `npm start` |
| 帮用户重启开发版 | **先问用户，而且只在没有会话运行时做**。`npm run build` → `npm run host:stop` → 结束 `electron.exe packages/app` 主进程（命令行不含 `--type=`）→ 备份 `.data\studio.db*` 到 `.data\backup-before-<名字>-<日期>` → 在 PowerShell 里先删掉匹配 `^(CLAUDE|ANTHROPIC_|AMO_STUDIO_|NO_COLOR$|FORCE_COLOR$|COLOR$|TERM$)` 的环境变量（Claude Code 工具 shell 带的，Studio 会传给维护终端）→ `Start-Process node_modules\electron\dist\electron.exe packages/app`（工作目录 `studio`）→ 用 `.data/host-token` 在 node 脚本里查 `GET /api/state` 核对任务和会话数（不打印令牌）。只改界面时让用户按 Ctrl+R 即可 |
| 验证 | `npm run verify`（typecheck + vitest + build）；`npm run e2e`（Playwright project：`studio`、`notes`、`reviewer`、`relay`）。都用 BelowNormal 优先级、`--maxWorkers=6` |
| Portable | **不要每次都打包**，只在用户确认的发布节点打 |
| AMO 中转 | 服务在 Mac mini `http://172.16.8.85:47120/`（SSH 别名 `mac`）。发布：`npm run relay:release` 后 `npm run relay:mac -- deploy`，见 `packages/relay/README.md` |

### 规则补充（`AGENTS.md` 之外的细节）

- 不改 `~/.codex/config.toml`、`~/.claude/` 设置、用户已有的凭据条目（Studio 只写用户在 设置 → 模型 加渠道时的 `channel-<id>` / `channel-<id>-access`）。
- 测试只在 `%TEMP%\amo-studio-sandbox\` 和临时目录；端口只用 47900–47999；测试窗口不抢焦点、不开终端/浏览器、不碰剪贴板。
- 不 reset --hard、不删分支。密钥不打印、不写日志/文件/命令行。
- **真实模型额度**（`budget.json`，用 `spikes/lib.mjs` 的 `countTurn(note, provider)` 先计数再调用）：DeepSeek 45/1000、GLM 28/5000、GPT 订阅 6/50、Claude 订阅 0/50。平时测试用 mock。
- 工具坑：heredoc 里的 Python 会吃掉 `\n`、`\v` 等转义 → 有转义的改动用 Edit/Write 或 scratchpad 里的 `.py` 文件；Windows 文件名不分大小写（`Transcript.tsx` 和 `transcript.ts` 会撞）；跑完 e2e 用 `git checkout -- studio/screenshots/` 丢掉无意的截图变化；清理 `%TEMP%\amo-studio-test-*`、`amo-studio-e2e-*`。

### 还开着的事

| 事项 | 状态 |
|---|---|
| Android Studio | 工程 11-02 起在 `mobile/`（原 `android/`，为 iOS 改成 KMP：`shared` + `app`，见 `plans/ios.md`），调试 APK 位于 `mobile/out/`；团队服务器真实 Dxx-DS、远程可靠性、标准及 360 dp / 1.3 倍字体 UI 验收通过。范围、证据及未验项见 `plans/android-studio.md`；真实手机和 Tailscale 实网待验 |
| iOS Studio | `plans/ios.md`：KMP 跟 Android 共用，TestFlight 内部测试。App 记录已建（`com.gorilla.amo`，描述文件 `AMOStudio_AppStore`，还没装到打包机）。第 0、1 步 11-02 做完，没提交；发布流程（`npm run release -- ios`，ssh 驱动打包机）方案已写，第 2 步等用户确认怎么拆 |
| AMO 平台 | 方案 `plans/amo-lan-platform.md`，界面原型 https://claude.ai/artifact/Uu4fL3bXZg1NZHXDSKBPc9 。整理已做完；第一版（第 1、2 步）10-28 晚合进 master，见下面那条。下一步：部署到 Mac 并第一次真实发布（先问用户），然后第 3 步 |
| 远程会话（在我另一台设备上接着用本机会话） | 第 1–4 步和收尾 10-29 做完（`plans/remote-session.md`）；10-29 晚改成弹窗、加「安全」、B 能带图片和文件给 A（`plans/remote-page-and-new-task.md` 第 7、8 节，Studio 0.9.10）。等用户用两台真电脑验收；会话级授权、模型细到型号、HTML 的 CSS / JS、正文路径去用户名、远程权限上限，用户 10-29 定先不做 |
| 会话里直接用中转（回复自动回到会话） | 10-30 第一版做完（`plans/relay-in-sessions.md`，用户定的 5 条在里面），同天加了「不用确认直接发」的设置和远程默认关闭。`634b77c` 提交，中转服务 10-30 已部署，Studio 0.9.12 在测试通道（publish 时删了 0.9.9）；试过后 `npm run relay:mac -- promote studio 0.9.12`。终端里的会话、普通聊天、超时提醒以后再说 |
| 便签进 Portable 包 | 到发布时再做 |
| 位置批注的截图 | 用户 10-28 决定先不做，用一段时间再定 |
| Studio 托盘 | 用户 10-29 定：× 只关窗口，托盘右键「完全退出」连 Host 一起关（有会话在跑先确认）；平台的 Studio 卡片显示后台状态、给「重启 Studio」（没有会话在跑才能点）。画布调整合并后做，见 `plans/remote-session.md`「前置」 |
| 提示词模板 / 删扩展包 | 10-31 合进 master，未发布（见「最近的改动」10-31 那条）。以后可能做类似 DSH 的插件架构，到时另起方案 |

### 已知问题

- `packages/host/src/runtime/codex/server-manager.test.ts` 的「停止并释放端口 / 崩溃后同端口重启」在完整并行跑时偶发失败（端口释放慢），单独跑通过。记录在 `plans/maintenance.md`，不是功能问题。
- 端到端里 Claude 的 mock 配置没法向 Claude Code 要型号列表（会超时），所以测试模式给 mock 配了内置列表（`packages/host/src/bin.ts`）。
- Studio 里 agent 的命令 PATH 去掉了 WindowsApps，用不到应用商店版的 `pwsh`、`python3`、`winget`（本机 `python`、`node`、`git` 不受影响）。

## 最近的改动（新的在上面）

**2026-11-02 · 移动端改成 KMP：`android/` → `mobile/`（iOS 第 1 步）**（用户：按建议改名，发版值守已停）：
- `studio/android` 改名为 `studio/mobile`；新加 KMP 模块 `shared`（Kotlin 2.4.10、`com.android.kotlin.multiplatform.library` 9.3.1、Compose Multiplatform 1.11.1），除 `MainActivity` 外的代码和字体都挪进 `shared/src/androidMain`，`app` 只剩外壳。代码改了三处：版本号从安装包读（不用 BuildConfig）、字体用 `dev.amo.studio.shared.R`、`FilePolicyTest` 用到的两个函数改成 public。`scripts/android-publish.mjs`、`relay-mac.mjs` 的注释、`mobile/README.md` 跟着改了路径；`plans/android-*.md` 和下面的旧记录里的 `android/` 没改。
- 验证：assembleDebug、assembleDebugAndroidTest、lintDebug 都过；模拟器 FakeNga_UI_API_36 + 夹具，`test.ps1` 共 `OK (6 tests)`；设置页截图正常；`android-publish.test.mjs` 3 条过。
- 还要：把代码挪进 commonMain（第 2 步）；提交（只提交这次的改动）。

**2026-11-02 · iOS 版：方案和第 0 步**（用户：iOS 版走 TestFlight 内部测试，不上架）：
- 用户定了：代码走 KMP + Compose Multiplatform，跟 Android 共用协议层、数据层和界面；`dev.amo.studio` 的 App ID、App Store 描述文件和 App 记录由 Wu Naiyu 那边在网页上手动建；先只给用户自己的 1–2 台设备。方案、要那边做的清单、平台依赖替换表和步骤都在 `plans/ios.md`。
- 第 0 步：在打包机的 `~/amo-ios-spike/Hello/` 下用 `nice` 只编不签 archive 了一个空的 SwiftUI 工程，成功（3.3 秒，arm64，没有签名）。没碰证书、描述文件和账号。
- 查到的：打包机没有 JDK（KMP 要装，先问用户）；SSH 会话里登录钥匙串是锁着的，以后通过 SSH 签名要先解锁，或者在图形会话里签。
- 还要：跟「开发android版apk」任务对好时间，再把 Android 改成 KMP 结构（目录要不要改名为 `mobile/` 还没定）；等 Wu Naiyu 那边建好 App 记录；上传凭据由用户给。签名、导出、上传都还没验证。

**2026-11-01 · 停止的兜底；session_send**（用户：project_mining 的会话移 Claude 记忆目录后卡死，停止和停后台命令都没反应，只能重启电脑；另一个会话要求能往自己开的会话里续发）：
- 停止：`ClaudeRuntime.interrupt` 不再一直等 CLI；`stopGraceMs`（15 秒）内这一轮没结束就 `close` 它的进程并在会话里写一条提示，再过 15 秒进程还没退出就直接按停下处理（`finish` 只做一次，`closing` 清掉，下一条消息开新进程）。`stopBackground` 15 秒没回应就标成已停止并提示可能还在跑。
- `session_send`（`sessions.sendPeer`，免审批）：范围同 session_archive；会话在一轮里（含等审批、等回答）时排进 kv `sessions.peer-queue`，`session.upserted` 停下后一起送进去（在 report 之后），Host 重启后接着送。guide 和 session_start 的说明提到它。没做那个会话提的另外三条：「允许自动续发」开关、按轮次的用时和 token 统计（session_stats）、单独放宽子会话权限。
- 验证：`peer.test.ts` 新加 2 条（范围、排队合并）；Claude 集成测试新加 1 条（mock 的 interrupt 永不返回 → 1.5 秒后关进程、会话回到空闲、有提示、能接着对话）；amo-mcp 工具数 51；typecheck 过。「进程关了也不退出」那一支没有测试。

**2026-11-01 · 打包不再开模型；值守项能挂在另一项下面**（用户：「打包真的有必要跑个agent么」「打包值守挂在维护值守下面…停了父值守子的也应该停下」；方案和规则记在 `plans/release.md` 第 9 条）：
- `scripts/release.mjs`：`auto --if-due [--wait 30] [--max 120]`，没事不输出；该发 = 最后一次改动后 30 分钟没新改动，或最早的改动等了 2 小时，或问题页点了「发布打包」（以前是「最早的改动等 30 分钟」，0.9.24 因此在 #5 修好 5 分钟后就发，#6 没赶上）；发完把「已修好」的问题标已发布（AI 写的提交号在包里且碰了发出去的工具；没写提交号的也标），也清掉「发布打包」；失败了记下那个 master（git 文件夹里的 `amo-release-failed.json`），不自己重试。`due --wait` 用同一条规则。
- Host：值守项 `parentId`（一层；父关子跟着关；父关着子开不了；删父项子项留下），`duty_save` 认 `parentId`；值守会话检查没给名字时用值守项的名字；`issues.pending` 去掉「该打测试包了」，改报「上一次打测试包没成功（…停在「单测」：…）」，会话名「打包没成功」。界面：设置 → 值守和顶栏值守窗口里子项缩进、标「挂在「…」下」，编辑表单有「挂在」。
- 打包目录 `G:\PROJECT\AgentMonitorOverlay-release`（master 的 detached worktree，已 `release sync` 装好依赖）。模板原文 `docs/prompt-templates/issues-duty.md`、`start-maintenance.md` 和 AGENTS.md 的车道说明改了。
- 验证：duty / issues / mcp / ui duty 单测 33 条过（新加父子关系一条、问题检查改了一段）；typecheck 过；e2e `studio/duty.spec.ts` 2 条过，截图 `screenshots/studio/settings-duty-child.png`、`duty-dialog-child.png`；`markReleased` 的挑选规则拿真实问题页只读试过（#1–#6 都按提交号对上）。`auto --if-due` 真正发一次还没跑过。
- 还要（用户重启 Studio 之后）：把两份模板存进 Studio（`prompt_template_save`）；日常值守的检查改成只有 `issues.pending`；新建「自动打包」挂在它下面：`node G:/PROJECT/AgentMonitorOverlay-release/studio/scripts/release.mjs auto --if-due`，每 60 秒，超时 3600 秒。

**2026-11-01 · 远程：离开很久再连上，一次补齐不再闪**（用户：上午派了一堆任务，下午回来看板没马上刷新、对话「疯狂闪」）：
- 原因：控制端（`copies.ts`，代码里叫 B）重连后逐个任务 `syncTask`，每个会话补的每一条都发一个 `item.appended`，界面每条都复制排序一次。不需要「离线时间点」：B 本来就知道每个会话补到哪条 seq。
- 改法：`syncPeer` 先并行（3 个一组）把所有任务和会话拿齐（看板立刻对），再逐任务补记录；一个会话要补的超过 20 条或不止一页时安静写库，结束发一次 `items.reloaded`（`protocol/api.ts`），`useSessionItems` 收到就整段重读。补同步超过 1 秒时 `RemoteState.syncing` 带进度，顶栏「远程 · 同步 n/总数」加进度条，任务页横幅写正在补哪个。被控端不用改，旧版互通。
- 验证：`remote-tasks.test.ts` 新用例（离开期间写 450 条：没有逐条 appended、只有一次 reloaded、`task.upserted` 在它前面、进度清掉、3 条的照旧逐条来）、`ui/src/remote/remote.test.ts` 新一组；typecheck 过。全量 vitest 里 Codex `server-manager.test.ts` 失败，干净的 master 上一样，与此无关。没截图进度条（要两台电脑实际离线一段）。

**2026-11-01 · 便签的「待办」窗口，第一版**（方案和用户定的几条在 `plans/todo.md`，示意页 `plans/todo.html`）：
- 中转服务：`src/todo.ts`、`src/todo-protocol.ts`，`/api/todo`、`/api/todo/ops`；每台设备一张表加共通表，同账号设备都能看能改；按字段后到的赢，删掉的不复活，删除标记留 30 天；管理页改名跟着走。
- 便签程序：`src/todo.ts`（副本和离线队列，`todo-cache.json` 在便签家目录，按账号分开；窗口开着 10 秒同步一次，不开 2 分钟）；待办是第二个窗口（`#todo`，位置存 `todo-window.json`），托盘右键「显示待办」打开，没有快捷键；设置标题行显示版本号，加「待办」一节（使用待办默认开、账号、已完成保留 7/30/90/一直）。新依赖 `@amo-studio/account`（`amo-tools.mjs` 的 notes 包列表也加了）。界面在 `ui/src/todo/`。
- 平台：托盘「AMO 便签」下加「显示待办」（读便签 settings.json 的 useTodo）和「便签设置…」（`--amo-todo` / `--amo-settings`）。
- 验证：vitest `relay/src/todo.test.ts`、`notes/src/todo.test.ts`（真中转服务、断网重连、重启后队列还在、401、已完成保留）、`platform/src/tray.test.ts` 通过；e2e `e2e/notes/notes-todo.spec.ts` 2 条通过，整组 notes e2e 通过；截图 `screenshots/notes/T1`–`T11`。全量 vitest 另有 3 个失败与此无关（Codex server-manager 端口用例、git.test 偶发、未入库的 `scripts/android-fixture.test.mjs` 不是 vitest 格式）；平台 e2e「log in → install」卡在「服务器在线」，撤掉这次改动也一样，是原来就有的。顺手修了 notes e2e 里过时的默认快捷键断言（Ctrl Alt Space → Ctrl Shift F12）；notes e2e 现在给 `AMO_HOME` 一个临时目录，不碰真实登录。
- 提交 388e6d4；中转服务 0.7.7 11-01 10:39 已部署（值守目录 `release relay-service`，部署前备份 `backup-20261101-103930.db`；`/api/todo` 不带登录回 401）。没做：便签和平台没发版；改动推送（设备通道上的 `todo-changed`）还是靠定时同步；安卓版里显示待办以后再说。

**2026-11-01 · 安卓版 0.2.0：手机上重做一版**（问题和改法 `plans/android-mobile-redesign.md`；`studio/android/` 仍未入库，属于「开发android版apk」任务）：
- 保留连接、命令、传文件、凭据加密、自更新；重写数据层（`HistoryCache.kt` 按会话分文件、后台写；`rt.items` 从缓存最后一条往后拉；任务同步只在连上 / 回到应用时并行跑；推来的任务和会话变化直接应用）和全部界面（工作台、会话树、对话页的操作折叠、自写 Markdown、底部面板新建、设置里的电脑和配对）。
- 验证：模拟器 FakeNga_UI_API_36 + 夹具 `node scripts/android-fixture.mjs --seed-long`（新加：340 条的模拟长会话、`POST /stream` 模拟流式回复），`android/test.ps1` 6 个测试全过；截图在 `screenshots/android/redesign/`（浅色、深色、横屏、键盘、360 dp + 1.3 倍字体、流式）。流式 4000 字（每 30 ms 一段）时帧时间中位 13 ms、90% 18 ms，模拟器软件渲染下 21% 掉帧。
- 已发到团队服务器（versionCode 4，`node scripts/relay-mac.mjs android-publish --apk android/out/AMO-Studio-Android-0.2.0-debug.apk`）。没做：真机走 Tailscale 的手感没测。

**2026-10-31 · 发布流程整理和维护节奏**（方案和进度 `plans/release.md`，都已合进 master）：
- `npm run release`（`scripts/release.mjs`）：`status`、`due`、`<工具…>` / `auto`、`relay-service`、`promote`，以及值守目录用的 `sync`、`land`。只从提交过的 master 打包；跑 typecheck + 单测；升版本；把「下一版」改成版本标题；提交进 master；打包、发布；打 tag `<工具>-v<版本>`。
- 中转服务的版本记在 `RELAY_VERSION` 和 `packages/relay/CHANGELOG.md`。`packages/relay/package.json` 要保持 0.0.0：改了会让 npm ci 去 registry 找，报 404（ef3abe6）。
- 值守目录 `G:\PROJECT\AgentMonitorOverlay-duty` 已建好，是 master 的 detached worktree。值守在这里修问题、打包，不碰主工作区。
- 问题页：
  - 新状态「建议单开讨论」；
  - 新页签「要你看」；
  - 中转服务 0.7.1 已部署（10-31 10:54，部署前备份了 `backup-20261031-105409.db`）。
  - 中转服务 0.7.2：恢复管理页「服务器状态」，下载页的「报问题」收进折叠的「维护工具」；`release relay-service` 发之前查主工作区有没有没提交的中转改动（规则写进 `plans/release.md` 和 AGENTS.md）。
- 值守：
  - 顶栏「值守 N 项开着」，点开是值守窗口；
  - 任务卡片、任务头、会话列表上有标记；
  - 选了任务的会话项可以跑在别的项目文件夹里；
  - 「先检查」可以几样一起查（`kind: all`）；
  - duty_save 认 model、permission、effort，不写时用调用者自己的。
- 远程任务的模板窗口会列出那台电脑上的模板（`rt.templates`）。
- 三份模板的原文在 `docs/prompt-templates/`：开始维护、问题页值守、维护迭代。AGENTS.md 的车道例外改成两条：值守目录、维护迭代。
- 验证：
  - duty、issues、remote、sessions、mcp 的单测；
  - e2e：`studio/duty.spec.ts`、`studio/remote-tasks.spec.ts`、`studio/prompt-templates.spec.ts`、`relay/issues-page.spec.ts`；
  - 截图看过：`screenshots/studio/duty-dialog.png`、`duty-marks.png`、`remote-b-templates.png`、`screenshots/relay/I4-discuss.png`。
- **Studio 0.9.18 已发测试通道**：在值守目录用 `npm run release -- studio` 发的，release 提交是 d60c7f1，tag 是 `studio-v0.9.18`。typecheck 通过；单测 1041 条通过、4 条跳过；publish 时删掉了 0.9.15。
- 还剩：
  - 用户更新 Studio 后，把三份模板存进 Studio；
  - 开第一天的「MM-DD 维护」任务，试一遍「开始维护」；
  - Studio 0.9.17 和 0.9.18 试过后再 promote。

**2026-10-31 · 中转管理页的「服务器状态」**：用户担心中转占用 Mac mini 资源，要能在页面上看，并要求带曲线。实测负载很低：整机负载约 1（15 核）；内存 48 GB，空闲 88%；中转进程 CPU 0%、内存 89 MB；`data/` 2.6 MB，`platform/` 367 MB。机器上占资源最多的是 Jenkins（1.3 GB）。新增 `packages/relay/src/monitor.ts`，每 5 分钟记一个点（整机 CPU、内存，中转进程 CPU、内存，在线人数和设备数），最近 24 小时存在数据目录的 `monitor.json` 里。`/api/admin/monitor` 需要管理密码；文件夹大小、磁盘、占内存最多的程序（按 app 归并）在打开页面时现算，并做了缓存。`/admin` 加了一张卡片：6 个数字、4 张曲线（只有一个纵轴、末端直接标数值、悬停看具体数值、中转停过的地方曲线断开）、可展开的表格和程序列表，页面开着时每分钟刷新一次。`monitor.test.ts` 有 3 条测试，relay 全部 52 条测试通过，tsc 通过；用假数据截了浅色、深色两张图检查过（`screenshots/relay/admin-monitor-*.png`）。10-31 09:48 已部署到团队服务器（用户确认后；部署前自动备份了 `backup-20261031-094821.db`），`/api/admin/monitor` 不带密码时返回 401，`/admin` 页面里有新卡片，错误日志是空的。用真实管理密码打开页面看 macOS 上的数（vm_stat、ps）**还没验证**。24 小时曲线从部署那时开始攒。**后续**：10-31 10:54 从值守目录发的 0.7.1 是按 master 打的，没带这批（当时没提交），把服务器上的卡片冲掉了；用户同意后提交为 48e9bdfe，随中转服务 0.7.2 重新部署（`monitor.json` 在数据目录里，之前攒的点没丢）。以后 `release relay-service` 看到主工作区有没提交的中转改动会停下（0337b5b）。

**2026-10-31 · AMO 文件快传首轮调查（尚未实现）**：调查平台安装发布、共用账号、Relay 附件/权限、托盘及 AMO 浅深主题；建议独立工具经团队服务器暂存并按人投递。现有附件为 20 MiB 整包缓存和同步落盘，不适合直接扩成大文件工具；需新增续传、收件权限/回执、配额与过期清理。只读实测团队服务可达、磁盘 Available 为 3398408732 个 1024 字节块、网口为 1000baseT；实际吞吐未验证。范围及待定默认值见 `plans/lan-file-transfer.md`，阅读版 `plans/lan-file-transfer.html` 已检查浅深及窄屏排版。未改产品代码、未部署、未重启、未提交；等待用户确定首版范围。

**2026-10-31 · Android Studio 首版实现**：新增独立 Kotlin/Compose 工程 `android/` 和隔离联调脚本 `scripts/android-{fixture,fixture.test,provision}.mjs`。手机通过现有 Relay devices / Host rt.* 协议完成登录、配对、任务与会话、对话/审批/提问/中断和文件查看；创建任务同时启动首会话。沿用 AMO 色值、字体、图标和浅深主题。Keystore 保护凭据，历史缓存与草稿按账号隔离，断线不自动重发命令。构建与 Lint 通过（0 errors、22 warnings、1 hint）；本地可靠性及团队服务器 5 项协议/可靠性测试通过，团队服务器真实 Dxx-DS 三轮完整回复及缓存恢复通过（本轮共 5 次真实调用含准备/重测）。标准 UI、360 dp / 1.3 倍字体 UI、横竖屏草稿、软键盘及 HTML 内联交互验收通过，截图已检查；真机、Tailscale 实网、旧版 Android 尚未验证。调试 APK 在 `android/out/AMO-Studio-Android-0.1.0-debug.apk`。未改生产 Host / Relay、未部署、未重启用户 Studio、未提交。详见 `plans/android-studio.md`、阅读版 `plans/android-studio.html` 与 `android/README.md`。

**2026-10-31 · Android Studio 首版调查（尚未实现）**：范围见 `plans/android-studio.md`，阅读版 `plans/android-studio.html`。用户定：仅远程登录配对、任务、会话、对话与查看，操作以桌面客户端为准；不做批注、书签、Focus，严格沿用 Studio 美术并支持浅深主题。现有远程协议可作为基础，链路仍经团队服务器，Tailscale 需确保服务器可达。实测 JDK 17、隔离缓存下 Gradle 9.5.0 启动、ADB/AVD 枚举、团队服务器健康接口；未编译 APK、未做手机或 Tailscale 联调。下一步是独立 Android 工程和基础闭环，未修改应用代码、未重启或部署服务。

**2026-10-31 · 问题页上线（阶段 1）**：`studio/issues` 快进合回 master（e483ca7），`relay:release` + `relay:mac -- deploy` 部署（中转重启，部署前备份 `backup-20261031-003043.db`）。`http://172.16.8.85:47120/issues` 能打开，下载页有「报问题」。做了什么见 `plans/issues.md`「进度」。

**2026-10-31 · 值守（阶段 2）合回 master**（5847650）：Host 的 `features/duty/`，设置里一页「值守」（开会话 / 跑命令 / Studio 自带，每 N 秒或每天定时，同一项同时只跑一个，开会话前看额度）。验证：duty 单测 5 条 + remote 相关单测全过，e2e `studio/duty.spec.ts` 过，截图 `screenshots/studio/settings-duty.png`。没整套跑 verify，也没发版（CHANGELOG 记在「下一版」）。

**2026-10-31 · 问题页阶段 3（改成模板）合回 master**（73e13dd）：用户定不做内置值守任务和打包脚本，改成 AMO MCP 的 `issue_*` 工具 + 提示词模板「问题页值守」（原文 `docs/prompt-templates/issues-duty.md`），值守项的会话能指定型号、思考强度、权限。验证：issues 单测 2 条（本机中转服务）、duty / amo-mcp 单测、e2e `studio/duty.spec.ts`。还没发版；装上带提示词模板的 Studio 后，要把模板原文存进 Studio（`prompt_template_save`），再建值守项。随后（ac897d3）值守的会话项可以「先检查」：检查命令或 Studio 自带检查（问题页的 `issues.pending`，代码写），有事才开模型，同样的发现不重复开；建议的值守项改成每 30 秒、先检查「问题页有事要做」（见 `plans/issues.md`「阶段 3 改了做法」）。再随后（9bd43e7）值守给 AI 用：`duty_list` / `duty_save`（每次要人批准）/ `duty_stop`，脚本输出 `AMO_DUTY_DONE` 关掉值守项，会话项可勾「做完了 AI 可以关掉」（见同一文件「值守给 AI 用」）。**Studio 0.9.17 已发测试通道**（a2f6198，从 worktree 打包，主工作区当时有别的会话没提交的 relay 改动；publish 删了 0.9.14）。worktree `G:\PROJECT\AgentMonitorOverlay-issues` 还留着。

**2026-10-31 · 提示词模板，删掉扩展包（在 worktree 分支 `studio/prompt-templates` 做完后合进 master，未发布）**

- 用户要「任务模板」：常开的同样任务，存好提示词，在 @ 菜单里和快速提交同一级的位置选，弹窗选中后粘进输入框；模板可以让 AI 通过 AMO 的 MCP 按要求加。用户定的三条都按建议（`plans/prompt-templates.md`）：全局 + 可只在某项目出现；第一版不做变量；AI 新增、修改直接生效，删除要人批准，列表标「AI 写的」。同时用户定**删掉扩展包**（模板比它好用；以后可能做类似 DSH 的插件架构）。
- 模板：protocol `prompt-templates.ts`；Host `features/prompttemplates/`（存在 kv `prompt-templates`，一个 JSON 列表；`GET/POST /api/prompt-templates`、`PATCH/DELETE /api/prompt-templates/:id`，事件 `prompt-templates.changed`）；MCP `prompt_template_list`（只读）、`prompt_template_save`（自动通过）、`prompt_template_delete`（不自动通过）；guide 的 files 一节写了用法。界面 `attach/PromptTemplateDialog.tsx`、`usePromptTemplates.ts`，@ 列表「AMO 扩展功能」最后一项「提示词模板…」（会话输入框、新建任务页；快速新任务那条单行输入框不给）。
- 删扩展包：Host `features/packs`、`packs/`、读模型 packList/packDoc、调度简报里的预设、`POST /api/tasks` 的 `template`；「一键忽略 .amo/」（`git-exclude`）；protocol `packs.ts`、`TaskTemplateChoice`、可关闭功能 `packs`（设置里存着的 `packs` 读时忽略）；界面 `ui/src/packs/`、任务页预设和文档面板、会话树「按扩展包预设」、新建任务「流程模板」；e2e packs / pack-acceptance；`examples/packs`、`scripts/smoke-stage6.mjs`；`design/pack-format.md` 挪到 `docs/archive/`。任务清单（`checklist_items`、`checklist_check`）留着，老任务的清单照样能勾。ProposalsPanel 原来借用 packs.css 的三个类，改名放进 planning.css。
- 验证：tsc（`tsc -b` + ui）过；vitest 全量 1028 过、4 个失败都在 runtime（`server-manager` 端口、`claude-runtime.integration` 子 agent 的用量 20 对 10），单独重跑仍有 2 个，和这次改动无关，主工作区另一个会话在同时跑测试，可能抢端口，没在干净的 master 上对照。e2e：prompt-templates（2 条）、features、task-head、attachments、newtask 全过。截图 `screenshots/studio/prompt-templates-dialog.png`、`stage-11/S11-B-05-at-menu.png`（菜单里多一项，光打 @ 时它在滚动区底下，打「@模板」能直接筛出来）、`stage-11/R4-features-off.png`、`stage-14/S14-E-edit-project.png`。CHANGELOG 写在 Studio「下一版」，没升版本号（主线上另一个会话也在升，合并时再定）。

**2026-10-31 · 测试通道 Studio 0.9.16；问题页 + 值守开工**

- 晚（五）～（七）三项（远程改名、远程会话归档、编号列表）提交（652abdc），Studio 0.9.16 发了测试通道（publish 删了 0.9.13）。试过后 `promote studio 0.9.16`。verify 时整套单测在低优先级下有几条超时，单独重跑只剩 `server-manager.test`（这台机器上的老问题，和改动无关）。
- 定了问题页 + 值守的方案（`plans/issues.md`）：问题只在服务器 `/issues` 页面上报和往来；Host 新功能叫「值守」（`duty`）；每个问题一个 Opus 会话，在自己的 worktree 修、验证、合回 master（AGENTS.md 里写了这个例外）；打包用脚本（凑满 3 个 / 每 30 分钟 / 点「发布打包」）。不做 /loop 试跑，直接从阶段 1 开始，在 worktree `G:\PROJECT\AgentMonitorOverlay-issues`（分支 `studio/issues`）里做。

**2026-10-30 晚（七）· 远程任务的会话在 B 上归档 / 恢复（未发布、未提交）**

- 用户：控制端任务里的会话没有「归档」。加 `rt.archive`（{sessionId, archived}）：B 的 `RemoteAwareRuntime.archive / unarchive` → `copies.archive`，A 上走 `sessions.archive / unarchive`，A 推送改动的会话在应答之前，所以 B 调用返回时副本已更新。COPY_ROUTES 放开两个路由；B 上归档整个任务仍是 dropCopy，不碰 A。界面去掉 SessionHead 归档按钮的 `!remote`。单测接在改名那条后面（remote-tasks 23 条过；同文件「A away」那条一次偶发连不上假服务器，单独重跑两次都过），e2e remote-tasks 加 B 归档、A 显示已归档、B 恢复（过），截图 `screenshots/studio/remote-b-archived.png`。

**2026-10-30 晚（六）· 回复里的编号列表显示成 1、1、1 2（未发布、未提交）**

- 用户在 s-0c69632f 的回复里看到 3 个「1.」。原因在 `ui/src/lib/markdown.tsx`（自己写的渲染器）：列表遇到空行就结束，「1.」下面空行加缩进段落、再「2.」，就断成几个 `<ol>`，而 `<ol>` 不带 start，每段都从 1 数。改：空行后接同一列表的项（或更深的项）、或缩进在某项下的段落时列表继续；段落挂到它缩进所在的那一项（已有子列表时放在 `ListItem.after`，显示在子列表下面）；有序列表记 `start`。markdown.test 加两条；mock 的 `[[markdown]]` 第 1 项下加了一段缩进的话，markdown.spec 断言它，markdown / review / context-menu e2e 20 条过，截图 `screenshots/stage-2/S2-01-markdown.png`。

**2026-10-30 晚（五）· 远程任务在 B 上改名（未发布、未提交）**

- 用户：远端不能给任务和会话改名。加了 `rt.rename`（{taskId, title} 或 {sessionId, title}）：B 的 `PATCH /api/tasks/:id` 走 `TasksFeature.patchTask`，只带 title 时转 `remote.renameCopy`；会话改名经 `RemoteAwareRuntime.rename` → `copies.renameSession`。A 改完，B 立刻把名字写进副本（A 的推送随后带同样的名字）。COPY_ROUTES 放开两个 PATCH，其他字段仍由 updateTask 拒绝。界面：任务名在那边离线或授权收回时灰着，会话名不再对远程灰。单测 remote-tasks 加一条（45 条过），e2e remote-tasks 加 B 改名、A 跟着变（过）。CHANGELOG 写在 Studio「下一版」。

**2026-10-30 晚（四）· 便签 0.9.7「关于」、平台 0.9.12「关闭」误报（测试通道）**

- 晚～晚（四）的改动一起提交（5c833ce）。便签 0.9.7、平台 0.9.12 发了测试通道（publish 删了便签 0.9.4、平台 0.9.9）。试过后 `promote notes 0.9.7`、`promote platform 0.9.12`；Studio 0.9.15 也还在测试通道。

- 便签「关于」：无边框窗口的拖动区收不到网页的 contextmenu，右键走 BrowserWindow 的 `system-context-menu`（`notes/src/main.ts` 的 createPad），菜单「关于便签」→ `amo:notes-about` → 页面问 `amo:notes-about-info`（版本读 notes 自己的 package.json；`--amo-app=notes` 时写随哪个 Studio 版本运行）→ 便签顶上一条提示，× 或 Esc 收起。e2e 用 `__notesAbout` 触发，截图 `screenshots/notes/N-about.png`。notes e2e 6 条过 5 条，挂的那条是本机自己的便签占着 Ctrl+Alt+Space（快捷键退到 Ctrl Shift F12），和改动无关。
- 平台「关闭」误报 0.9.7：`close()` 按「旧版本文件夹里有在跑的进程」判旧版本，Studio 0.9.7 的文件夹里还有它带起来的 claude.exe 或随它的便签，就误判了。改成先读 Studio 的 `/api/health` 版本，读不到才看进程，而且只看 programs.json 里 Studio 自己的 exe 名。platform.test 13 条过。
- 用户报「任务里新会话的输入栏没缓存」还没复现：输入框草稿按会话 id 存（`task/sessionDraft.ts`，localStorage 在数据目录的 electron 里，端口固定 47900），读代码没找到会丢的路径，等用户说具体步骤。

**2026-10-30 晚（三）· 测试通道 Studio 0.9.14 → 0.9.15、便签 0.9.5 → 0.9.6（未提交）**

- 下面两条（晚、晚二）的改动用户要求先发测试通道：Studio 0.9.14、便签 0.9.5 发了（publish 删了 Studio 0.9.11）。然后查用户报的两个问题，又发了 Studio 0.9.15、便签 0.9.6（删了 Studio 0.9.12、便签 0.9.3）。试过后 `npm run relay:mac -- promote studio 0.9.15`、`promote notes 0.9.6`。
- 远程点文件「找不到这个文件」：我在回复里写的 `screenshots/studio/…` 是相对 `studio\` 的，任务文件夹是仓库根。本机靠 S18（按路径结尾在 git 文件列表里找唯一一个）能打开，远程 A 端 `readRemoteFile` 没这一步。`FileRoots.findByEnd`（grants 里接 `chatFiles.findByEnd`，新公开方法），找不到时按结尾找，仍要在任务文件夹里。单测 files.test 加一条。
- 便签粘到微信只有文字：用户试的是旧版。实测 Electron 44 写进剪贴板的格式齐全（PNG、CF_DIBV5、HTML、Unicode 文字、Bitmap、DIB），但微信一次粘贴只取一样，有文字就取文字。所以加了缩略图上的「复制」（`PadImages.onCopy`）：只复制这一张，窗口不关。e2e 里页面的「复制」按钮改成 exact 匹配。微信里还没实际试过。

**2026-10-30 晚（二）· 远程图片和批注、远程信息条改版、便签复制图片、归档项目的 DSH 权限（未提交；0.9.14 起已发测试通道）**

- 用户在 B 的远程会话里：发截图看不到（A 收到了）、加不了批注（「这一项要在那台电脑上操作」）。图片：A 的条目用 A 的附件 id，B 没有这些附件。新 `remote/copy-images.ts`（`CopyImages`，B 端）：B 发出的消息记下本地附件（`sent`），A 的这条消息回来时按顺序对上；对不上的（A 那边的人发的、工具图）用 `rt.file` 从 A 取回来存成 B 的附件（A 本来就允许取任务对话里的附件），kv `remote.images` 按任务记 A id → B id（取不到记 null，显示成文件名），`putItem` 每次都按它改写；副本归档时清掉。批注：`COPY_ROUTES` 放开 `POST /api/sessions/:id/annotations` 和 `/annotations/send`（批注存在 B，发出去是普通消息文本，走 rt.send）。单测：B 发的图是 B 的附件、A 发的图取回来、B 加批注发到 A。
- 远程信息条（用户 10-30）：新 `task/RemoteBanner.tsx`，默认一行（「远程」+ 在哪 + 这个任务的模型 + 最需要人的状态），说明折叠（localStorage `amo.remoteBannerOpen`），展开的说明左边对齐标题（标记固定 36px 宽）；`.remote-banner` 加 `flex: none` 和下边距（以前被会话区顶住）。额度监控 B 拿不到（远程模型的 usage 是 null），只放了模型和状态。e2e `remote-tasks` 加了收起 / 展开和截图 `remote-b-banner`、`remote-b-banner-open`。
- 便签复制带图（用户 10-30）：新 IPC `amo:copy-rich`（notes 主进程，Electron 44 的 `clipboard.write([new ClipboardItem(...)])`）：文字、HTML（图片内联 data URI）、第一张图的 PNG 一起写；`ui/src/host/client.ts` `copyRich`；`ScratchpadApp` 复制时取这一页的图片，只有图片也能复制。e2e 记录复制的图片数（`__notesCopiedImages`）。**没在真剪贴板上试过**（测试模式只记录），用户试一下粘到微信 / Studio / Word。
- 低优先级：用户以为是文件夹权限没恢复。查了 `G:\PROJECT\AgentMonitorOverlay` 现在是 Medium（正常）；我遇到的是 Studio 10-22 定的 agent 内存优先级（`runtime/priority.ts`，agent 跑的命令都是低内存优先级），`priority.test.ts` 在 agent 里跑会失败，改成这种情况下跳过。另按用户说的加了检测：DSH 沙箱权限列表把已归档但还带着设置的项目也列出来（`FolderAccessStatus.archived`），只给「恢复原来的权限」，`folderTarget` 对 folder / revert 放行已归档项目。
- 测试：typecheck；remote、dsh、runtime、ui 单测过；`server-manager.test.ts`（真 codex app-server）在这里失败，撤掉我的改动也一样失败，是环境问题；e2e `remote-create`、`remote-tasks` 3 条过，notes 5 过 1 失败（用户自己的便签占着 Ctrl+Alt+Space，测试的便签退到 Ctrl+Shift+F12，和改动无关）。

**2026-10-30 晚 · 远程：A 改设置 B 马上看到；会话不再继承 Host 的环境变量（未提交；0.9.14 起已发测试通道）**

- 用户 10-30（第一次两台真电脑接通后）：A 上勾了远端允许的项目点保存，B 不会马上更新。查实：B 的新任务页只在选中设备 / 设备上线时 `rt.catalog` 取一次，A 改设置没有任何通知。改了：新推送 `RemotePush { type: "catalog" }`。A（`create.ts` `RemoteCreates`）记下问过 catalog 的设备（`serveCatalog`，只记本次 Host 启动后问过的），远程状态变（`service.changed()`：远端允许的项目 / 模型、安全、改名、上下线）或 Host 事件（项目、专题、任务、模型渠道、数据删除）时 300 ms 合一次，对在线的设备算 catalog，和上次给它的比（不看 lastUsed 排序），不同才推。B 的 Host 转成 Host 事件 `remote.catalog`（不进日志），`RemoteDraft` 收到就换上，选过的还在就保留（`keptPicks`）。旧版 B 忽略这个推送。另外 `grants.ts` 在 `profiles.updated` 时把授权任务再推一遍（模型名、能选的模型）。
- 同一次发现（用安装版 AMO 迭代 AMO）：Host 自己的 `ELECTRON_RUN_AS_NODE=1` 和 `AMO_STUDIO_DATA_DIR / UI_DIR / VERSION` 传进了会话，agent 跑 e2e 时 Electron 起不来（bad option: --remote-debugging-port），开开发版 Studio 会用安装版的数据目录和界面。新 `runtime/agent-env.ts`（`withoutHostEnv`），Claude（`claudeEnv`）、Codex（app-server，`cmd.env` 需要时再加回 ELECTRON_RUN_AS_NODE）、DSH 都去掉。
- 测试：typecheck；remote、runtime、newtask 单测过（新加：catalog 推送、`keptPicks`、`claudeEnv` 去掉 Host 变量），`priority.test.ts` 一条在 AMO 会话里跑会失败（会话进程本身已是低内存优先级，测试假定是 5），和改动无关；e2e `remote-create` 2 条过（新加：B 的新任务页一直开着，A 保存后它直接变成可选）。CHANGELOG「下一版」写了。还剩：提交、发版；两台都要更新才生效。

**2026-10-30 · AI 不要求就不用画布（测试通道 Studio 0.9.13）**

- 用户 10-30：人不要求时 AI 不用画布；人说了（「主控用画布展开任务」「放到画布上审阅」）就照以前一样做完整。改了：`AMO_MCP_INSTRUCTIONS` 删掉「要点多的报告放画布」，换成「人要求时用画布并做完整（见 amo_guide lead、canvas），没要求不动，读可以」；角色卡主控职责写「人让你用画布展开时照 lead 一节排好分组和依赖，没说不动」，专题会话「人让你整理画布时再整理、标颜色」；`amo_guide` canvas 一节开头写明这个前提，画布审阅改成「人让你放到画布上时」，lead 第 3 步「人让你用画布展开时排好分组、依赖、颜色」；`canvas_items_post` 的说明去掉「instead of one long reply」。
- 测试：typecheck；guide、mcp、canvasreview、codex 的单测过（`server-manager` 一条在负载下超时，单独重跑过）。

**2026-10-30 · 平台 0.9.11：切回前台不再闪「正在连接」（测试通道已发）**

- 用户 10-30：平台每次切回前台都显示「正在连接」，「更新到」跟着变灰。原因是 `refresh()` 一开始总把连接设成 `checking`，0.9.10 起 `checking` 时安装、更新灰着。改成：已有通道信息且在线时后台刷新（不进 `checking`，失败才变 offline）；`refresh({ focus: true })`（`main.ts` 的窗口 focus）距上次服务器回答不到 `FOCUS_RECHECK_MS`（60 秒）只查本机在运行的工具。「刷新」、登录、装完照常立刻问。
- 测试：平台单测加一条（后台刷新不出 checking、切回前台 1 分钟内不问服务器），67 条过。e2e「正在连接」改成：在线时刷新按钮不灰；登出再登录（没有通道信息）才出「正在连接」，截图 `P37-connecting` 更新。平台 e2e（放宽到 30 秒）这条和登录→更新→卸载那条过；「第二个工具只下载自己的文件」卡在卸载那一步，换回提交前的代码一样失败，是原有问题，待查。
- `packages/platform` 0.9.11，CHANGELOG 写了；`release/` 里已打好包。`relay:mac -- publish platform` 被自动审批拦下（生产部署），用户自己跑的：0.9.11 进了测试通道，删了 0.9.8。试过后 `npm run relay:mac -- promote platform 0.9.11`。

**2026-10-30 · 远程默认关闭；中转发送可以不用确认（`634b77c`；测试通道 Studio 0.9.12）**

- 用户 10-30：远程默认关，要手动打开；只开 Studio、没在平台登录时也是关的，而且打不开。做法：Host 的 kv `remote.enabled` 记「为哪个账号（server + name）打开的」，当前登录的不是它就是关（换账号登录又是关的）。关着时 `RemoteState.connection.state = "disabled"`、`enabled: false`，不建 `DeviceLink`，配对、授权、远程设置都保留；`requireStarted` 报「远程功能没有打开」。`PUT /api/remote/enabled`（打开要有登录，会等正在读的 account.json）。`teamLogin()` 不受开关影响：中转只是借用同一个登录。界面：远程弹窗关着时显示「远程功能没有打开」+「打开远程功能」（没登录时按钮灰着）；关在 远程设置 最下面；顶栏写「远程 · 关」；授权弹窗、新任务页的「在别的设备上」、远程任务卡跟着变。**以前用过远程的人更新后要重新打开一次**（CHANGELOG 写了）。
- 用户 10-30：中转这种要确认的发送加个设置，开了就不用确认。`StudioSettings.teamAutoSend`（kv `settings:team-auto-send`，设置 → 功能 → 中转，默认关）。开着时 `team_ask` / `team_followup` 当场发出，工具直接回「已发给 X」；发失败就是工具的报错，不再另发消息进会话。只管中转；Studio 内部的传话（`task_message`）还是每次确认。
- 测试：Host 单测 remote 两个文件的 helper 先 `setEnabled(true)`，「没登录」那条加了打开 / 关闭 / 换账号；teamrelay 加一条（不用确认直接发、远程关着中转照常用）。UI 单测 `remoteButton`、`remoteModeShown` 加了关闭的情况。e2e 远程 5 个 spec 启动后先打开（`remote.spec` 第一条走界面点「打开远程功能」，最后点「关闭远程功能」），teamrelay spec 加了设置那一步。全量 vitest 1045 过（2 条在负载下超时，单独重跑都过：平台 `stopStudio`、Claude 子 agent 审批）；e2e 远程 5 个、teamrelay、taskpage、newtask、settings 都过。新截图 `screenshots/studio/remote-disabled.png`、`remote-switch.png`、`remote-no-login.png`（改）、`screenshots/teamrelay/T4-auto-send-setting.png`。

**2026-10-30 · 会话里直接用中转，回复自动回到会话（第一版，`634b77c`；中转服务已部署，测试通道 Studio 0.9.12）**

- 用户定的（`plans/relay-in-sessions.md`）：用你本人的账号发、标「AI 代发」；团队里谁都能找，每次发之前都先问你（自动审批也问）；不做超时提醒；第一版只做「AI 找人确认」；`relay inbox` 只取这个对话发出的。
- 中转（`packages/relay`）：`Via` 加 `conv`（对话标记），会话的 `RequestState.conv` 是提问方最近一条带标记的 AI 消息的。`relay inbox --conv <标记>` 和 MCP `relay_inbox` 一次取回这个对话发出、已回到我这边的会话的新内容（`inbox.ts`，新内容由 `usage.ts` 的 `sinceLastWord` / `newRepliesText` 算，「复制新回复」也用它）；`ask` / `send` 加 `--conv`，MCP 进程自己生成标记；用法说明写了。新入口 `@amo-studio/relay/light`（只有客户端部分，Host 用；Studio 和 Reviewer 的打包加了 relay 包）。**服务代码改了，部署会重启中转几秒。**
- Studio（`host/features/teamrelay`）：AMO MCP 加 `team_members`、`team_ask`、`team_followup`、`team_done`、`team_session`、`team_sessions`；`relay_send` 改名 `task_message`。`team_ask` / `team_followup` 不直接发，记一条 `TeamSend` 等人点「发送」（kv `teamrelay.sends`，事件 `teamsend.upserted`，`/api/teamrelay/sends/:id/send|dismiss`）；不发或发失败会告诉那个会话。发出时 `via = { kind: "ai", client: "AMO Studio", conv: "studio:<设备 id>:<会话 id>" }`，账号用平台的（`remote.teamLogin()`）。Host 长轮询中转（`wait`，不改「已取回」），回到我这边、由 AI 处理、还没取的，按标记送回那个会话（`sessions.sendMessage`，正在跑就排队，同一会话几条合成一条，开头「【中转回复】」），会话没了或归档了就不取。`TeamThread` 记各会话发出的中转会话（kv `teamrelay.threads`，事件 `teamthreads.changed`）。
- 界面（`ui/src/teamrelay`）：任务页和 Focus 里的确认卡片（发给谁、标题、正文、问题和选项、带的文件，「不发」「发送」）；看板卡片和任务页写「等 X 回复（中转）· 已等多久」。
- 验证：typecheck、build 过；全量 vitest 1044 条全过（新：中转 `relay inbox` 一条、Host `teamrelay.test.ts` 两条，对着本机临时中转服务）；中转 e2e 5 条、`relays.spec`（传话改名后）、新 `teamrelay.spec`（本机中转服务、两个账号：假模型调 `team_ask` → Focus 和任务页出现 → 发送 → 对方在中转回复 → 会话收到并开新一轮），以及 focus / board / remote 相关 17 条都过。截图 `screenshots/teamrelay/T1–T3`。
- 还剩：上线（部署中转、发 Studio，先问用户）；终端里的会话、普通聊天、超时提醒、能找哪些人的名单，以后再说。

**2026-10-30 · 中转「复制新回复」（没部署）**

- 用户：会话来回几轮后，「复制给 AI」贴回原来的对话会把看过的又贴一遍。会话回到你这边、由 AI 处理时，提示条里换成「复制新回复」（主按钮：只复制你或你的 AI 上次发言之后的内容，回复对应的问题照常带上，开头说明之前的已经看过、要全文用 `relay_session_get` / `relay replies`）和「复制整个会话」（原来的内容，给新对话）。顶部的「复制给 AI」不变。`relay-ui/src/SessionView.tsx`。
- 测试模式下中转的「复制…」不再写系统剪贴板，存在进程里（`__relayCopied`），e2e 读它（`relay-app/src/main.ts`，只影响测试，不用发外壳）。
- 验证：typecheck、build、`relay:release` 过；中转 e2e 5 条全过（两轮会话那条加了：第一轮「复制新回复」不含原请求，第二轮只含第二轮的回答，不含第一轮和 AI 自己的追问；截图 `33-tight-planner-back`、`35-tight-copy-new`）。
- 上线：`relay:mac -- deploy`。服务代码和服务器上的一致（sha256 相同），只换界面内容，不会重启中转。

**2026-10-30 · AMO 娘的任务栏图标回到完整的她（测试通道 Studio 0.9.11）**

- 用户：裁掉耳机两边「还是太奇怪了」，任务栏回滚。`make-icons.mjs` 去掉 `WINDOW_ZOOM`，`app/assets/mascot` 恢复成 `cafb51a` 之前的（表情和 `ui/public/mascot` 同一份，`icon.png` 是 `amo-studio-256.png` 原图）。左上角 48 px、Focus 里 92 px 不变。

**2026-10-30 · 平台「正在连接」时的工具页（测试通道 平台 0.9.10）**

- 用户提议连接时整页不能操作；商量后定只锁要服务器的：「安装」「更新」「换成」本来就灰着，提示从「现在连不上服务器」改成「正在连接服务器…」（「更新平台」同样）；状态行写「正在读取服务器上的版本…」，不再显示上一次的结果（刚打开时已装的工具会误写「这个通道里没有它」）。「打开」「关闭」「回到」「卸载」照常能用：连接最多要等十几秒，这几样只动本机。`PlatformApp.tsx` 的 `statusLine` / `ToolRow`。
- 验证：typecheck、build 过；testkit 的假服务器加了 `delayChannels`，新 e2e `platform.spec.ts`「正在连接」（截图 `P37-connecting`）。这台机器上平台 e2e 照默认 5 秒超时会大面积失败（安装、连接都超过 5 秒，机器空着也一样）；临时把 expect 放宽到 30 秒，9 条全过，`:74` 的「完全退出 Studio」这次也过了。**待修**：平台 e2e 的超时该放宽，或查清为什么这么慢。

**2026-10-29 夜 · 测试通道发 Studio 0.9.10、Reviewer 0.9.8、中转外壳 0.9.4、平台 0.9.9（正式通道没动）**

这一版合了下面几块（各自的记录在下面）和另一个会话的 `7a41f2e`（开会话的权限）：
- 远程（`7b8ae4f`）：顶栏「远程」改成弹窗，远程设置是叠在上面的二级弹窗（Esc 先关上面那层）。远程设置 → 安全（kv `remote.security`）：同账号的设备在这台电脑上建的任务直接开跑，别的账号默认先等确认——A 上变成一条带「那边选的项目 / 专题 / 模型」的请求（`RemoteTaskRequest.preset`），Focus 写「远程任务等你确认」，「同意…」里已经填好；B 的新任务页事先说明、按钮是「发给那边确认」。B 给 A 带图片和文件：新命令 `rt.upload` 分块（512 KB）先传，A 存成自己的附件（图片模型能看，DSH 改成文件；其他文件 `att-…-原名`，在消息末尾按 A 的路径重写「引用文件：」，行号和说明保留），每个 20 MB、一次 60 MB、不传文件夹；等确认的任务把文件留在请求上（`attached`），拒绝或撤回就删。「引用文件」那段的读写挪到 `protocol/src/fileRefs.ts`。用户定远程权限上限**先不动**。
- Focus（`cafb51a`）：按用户在 `out/html/focus-design.html` 里选的——A 版的整体样子（方角、顶栏 2px 线、衬线名字、「需要你」色块、提醒时静止的外框而不是呼吸光晕），每行前面 C 版的状态字（`focus/StatusWord.tsx`），B 版的卡片（左边色条）。Focus 不再显示额度（设置 → 额度 去掉 Focus 一栏，数据里的 `focus` 字段留着不用）。桌宠是 AMO 娘时：左上角图标 48 px（原 34）、Focus 里的她 92 px（原 72），窗口图标（任务栏）单独裁紧 1.22 倍（`make-icons.mjs` 的 `WINDOW_ZOOM`，界面和 Focus 里还是完整的她）。
- 画布侧栏（合并自 `worktree-agent-a1bc783d156d046b6`，`34521ce`）：画布右上角「侧栏」开关（和任务页同样子，记住）；侧栏左边缘拖宽度 260–560（默认 320，双击复位，记住），最后的页签也记住。页签只剩 整体待办 / 沟通 / 文档 / 书签 / agent 视角，一行细线下划线样式，「沟通」待确认数是角标，窄时换短名。「详情」页签去掉：选中卡片、分组或审阅条目，在它旁边浮出详情框（`CanvasDetail.tsx`，定位用 `geometry.ts` 的 `placeBeside`：右 → 左 → 下 → 上，选压住别的卡片最少的那边，不出画布区），平移、缩放时跟着走，拖卡片时先隐藏，不是模态；×、Esc（输入中第一下先退出编辑并保存）、单击空白关。**行为变化**：在空白处拖动只平移，不再取消选中。还剩：详情框较高时会压住旁边的卡片（审阅条目最明显），框里审阅状态按钮折成两行，等用户用一阵再看。
- 窗口标题栏、中转闪烁：见下面两条。合并后补了一处：中转在测试模式下不建托盘、不闪任务栏、不挂角标（全量 e2e 时用户看到任务栏和托盘冒出一排中转图标：`flashFrame` 会让 `skipTaskbar` 的窗口也出现在任务栏）。
- 验证：typecheck、build 过；全量 vitest 1044 条里 8 条失败，单独重跑都过（`server-manager` 端口、DSH 集成测试忙时超时、`peer.test.ts`）。全量 e2e 212 条 197 过；失败的 15 条：已知的 `cli.spec.ts:35`、`turn-start.spec.ts:74`、便签热键（真便签占着 Ctrl+Alt+Space）；6 条 studio 是关测试 Studio 时超时，单独重跑 7/7 过；中转 5 条重跑过；平台在机器忙时要把 expect 放宽到 20 秒、整条时限放宽才过，放宽后 8 条里 7 条过，剩 `platform.spec.ts:74` 的「完全退出 Studio」一步：测试装的是假的 Studio 0.9.0（比 `QUIT_SINCE` 的 0.9.8 旧），平台查进程时那个假 Studio 还在跑就会照规则拒绝发 `--amo-quit`——取决于时机，是上一版（`3373957`）加的规则和测试，这一版没改平台的 `platform.ts` / `system.ts`。**待修**：这条测试改用不旧于 0.9.8 的版本，或让假 Studio 不留进程；平台 e2e 的 5 秒等待在忙的机器上不够。
- 中转界面那一处（退出登录时数量报 0）没部署：要 `relay:release` + `relay:mac -- deploy`（会重启中转几秒），不部署也能用。
- 下一件：会话里直接用中转（`plans/relay-in-sessions.md`），**开工前先和用户确认计划**。

**2026-10-29 夜 · 中转有待处理 / 未读时任务栏和托盘闪、带数量（合并自 `worktree-agent-a16fcbe3a5bf7f734`，随中转外壳 0.9.4、平台 0.9.9 发测试通道）**

用户：「有待处理的 relay 信息时和未读聊天时，relay 的任务栏图标应该闪烁，托盘也闪，托盘最好还带上信息数量。如果是收起来的托盘则切成 relay 图标来闪，也显示信息数量。」
- 数量：界面原来就算好交给外壳（`relay-ui` Home：等我处理的会话 + 交来的任务 + 聊天未读，`relayShell.setUnread`），外壳以前只拿来改 tooltip。界面只加了一处：退出登录（Home 卸载）时报 0。
- 外壳（`relay-app/src/attention.ts`）：数量**变多**且窗口没人在看（不在前台 / 隐藏 / 最小化）时任务栏 `flashFrame`，一看就停；数量在就有任务栏角标（`setOverlayIcon`，超过 99 写 99+），清零就去掉。自己的托盘：有数量时「带数字的图标」和普通图标每 500ms 交替，窗口在前台时停在带数字的那张；tooltip「AMO 中转 · N 条待处理 / 未读」。
- 平台托盘（约束第 1 条）：平台启动的中转（`--amo-tray=platform`）把 `{count, blink, pid}` 写进它自己文件夹的 `attention.json`（`AMO_RELAY_HOME` 或 `%APPDATA%\AMO Relay`），退出时删掉；平台每秒看一次（`platform/src/relay-attention.ts`，只在文件变了时读，pid 不在了就不算）。有数量时平台托盘换成中转图标 + 数字，按 `blink` 闪，tooltip「AMO 平台 · 中转有 N 条待处理 / 未读」，菜单项「打开中转（N 条待处理 / 未读）」，单击图标打开中转；清零换回平台自己的图标。中转图标在 `platform/assets/relay-16…32.png`（`make-icons.mjs` 顺带复制）。
- 画数字：`traymenu/src/badge.ts` 自己画像素（主进程没有 canvas）：红色圆 / 胶囊带深一点的边、白色像素字（5×7 和 3×5 两套，整数倍放大），叠在图标上时周围挖一圈透明；`badge-image.ts` 转成 16/20/24/32 四个尺寸的 nativeImage。
- 验证：typecheck 过；vitest 新加 badge / attention / relay-attention / 托盘菜单；relay e2e 新加一条（AI 发会话 → 计数 1、闪、`attention.json`；看着 → 不闪；回复后 0；退出文件删掉）；平台 e2e「AMO 中转 from the platform」加托盘切换 / 点击打开中转 / 清零换回 / pid 不在不算。徽标深浅底预览用临时 Electron 脚本画过。真实任务栏和托盘没在桌面上实际看过。
- 发布要升：中转外壳（relay-app）、平台；`relay-ui` 那一处要 `relay:release` + deploy。

**2026-10-29 夜 · 其余窗口也去掉 Windows 标题栏，换成 AMO 自己画的（合并自 `worktree-agent-ab6979def96d4bbaa`）**

- 用户：「书签的标题还是 Windows 的，改成 AMO 风格」。书签、画布小窗、Git Review、查看器（含查看包）、首次设置都改成 `titleBarStyle: "hidden"`，页面顶部那一行当标题栏（`.titlebar`：可拖动，按钮、输入框、带悬停提示的部分不拖），左边 AMO 标识（独立 Reviewer 里是 Reviewer 的标识 `ui/public/reviewer.svg`，`make-icons.mjs` 会生成），右上角自己画的 最小化 / 最大化(还原) / 关闭。画布小窗和首次设置不可最大化，只有 最小化 和 关闭。
- 共用：`ui/src/shell/WindowControls.tsx`（`WindowControls`、`TitleMark`、窄标题栏 `TitleBar`、`WindowPlaceholder`），主窗口 `TopBar` 也改用它；主进程 `reviewer/src/window-controls.ts` 的 `installWindowControls()` 让 `amo:window` 作用于发消息的那个窗口，`sendMaximized(win)` 把最大化状态发给各自页面；Studio 和独立 Reviewer 都装，独立 Reviewer 的 preload 加了 `windowControls`。主窗口 × 仍只隐藏到托盘（它自己的 close 处理），其他窗口 × 真关。
- 页面还没有顶栏时（正在连接 Host、读取中、项目不存在、远程文件取回中、整个窗口出错）显示一条窄标题栏，窗口照样能拖、能关。查看器的「改动」里嵌的 Git Review 不再画一套按钮。书签顶栏的两个输入框窄了一点，760 宽时一行放得下。首次设置换成 AMO 的配色（浅色纸感、深色和 Studio 深色一致），跟随系统深浅。
- 验证：typecheck、vitest（ui / reviewer / app 57 个文件 325 条）过；e2e 新 `e2e/studio/titlebars.spec.ts`（四个窗口：没有系统标题栏、顶栏可拖、按钮在右上角、× 只关自己、最小化只作用于自己），`portable.spec.ts`、`reviewer-app.spec.ts` 加了标题栏检查；书签、画布小窗、Git Review、查看器、chat-files 相关 studio spec 和 reviewer project 共 29 条全过。截图 `screenshots/studio/titlebar-*`、`screenshots/reviewer/titlebar-*`（深浅各一）。没在真窗口里手动拖过、没试过真的最大化（测试窗口不能上屏）。

**2026-10-29 晚 · 开会话（session_start）的权限：沿用开它的会话、不能更宽，Claude 的 write 改成帮我审批（只提交，没发布）**

- 起因：一个「帮我审批」的 Claude 会话用 `permission: "write"` 开了子会话，Claude 的 write 映射成 `acceptEdits`，子会话的每条只读命令（sed、rg、node -e）都去问用户。全局 auto mode 配置没坏（10-28 重置后的默认）。
- 改动（`features/sessions/service.ts` 的 `peerPermission`）：不填 permission 时，同一种 CLI 沿用父会话的权限，换了 CLI 用它的默认；不管填没填，都不能比父会话宽：同一种 CLI 按 `PERMISSION_ORDER` 比，跨 CLI 按 只读 / 可写 / 完全 三档比。填了更宽的就报错，列出能用的档；默认值更宽就降到父会话那一档。Claude 的 write 改成 `auto`，第三方端点（GLM 等）没有分类器时退回 `acceptEdits`。MCP 工具说明和 guide 里的权限描述一起改了。
- 验证：`peer.test.ts` 7 条过（新加一条覆盖 Claude、GLM、跨 CLI 和远程会话没有父会话可比的情况），sessions、mcp、guide 的测试 32 条过，host 类型检查过；没跑完整的 verify，Host 没重启（Host 重启后才生效）。
- 还剩：用户决定等工作区里那批没提交的「远程」改动做完，一起升 Studio 版本发测试通道；`packages/app/CHANGELOG.md` 顶上的「下一版」一节发布时要改成版本号和日期。

**2026-10-29 晚 · 托盘菜单统一成便签的样子、各工具都有主题、平台进度条和「关闭」修正；测试通道发平台 0.9.8、Studio 0.9.9、便签 0.9.4、中转 0.9.3、Reviewer 0.9.7（`3373957`，正式通道没动）**

- 托盘菜单：新包 `packages/traymenu`（`@amo-studio/traymenu`），照便签的托盘菜单画的无边框小窗（一页自带样式的 data: 页面，点击当作导航截下来）；平台、单独打开的 Studio 和中转都用它，不再用 Windows 自己的菜单。便签保留自己的那份（它是样板）。新包已加进 `package-portable.mjs` 三个程序的包列表。
- 主题（用户：所有工具都要有深浅色）：Studio、中转原来就有。平台（设置 → 主题，`platform.json` 的 `theme`）、便签（便签设置，`settings.json` 的 `theme`）、独立 Reviewer（Git Review 顶栏最右的按钮，`%APPDATA%\AMO Reviewer\theme.json`）新加。做法：主进程记住并设 `nativeTheme.themeSource`，页面 `applyTheme("system")` 交给 base.css 的 prefers-color-scheme，所以托盘菜单也跟着这个工具的主题；默认浅色。Studio 和中转自己的托盘菜单跟随 Windows（它们的主题存在页面的 localStorage 里，主进程不知道）。
- 平台进度条：以前读清单 / 准备 / 切换时是来回滑的色块，下载时换成真实宽度，看起来涨了又退。现在下载前空、下载中按字节、切换时满；只有卸载和换回已装版本还用滑块。
- 「关闭」：从运行中的 exe 所在的版本文件夹认出版本，比 Studio 0.9.8 / 便签 0.9.3 / 中转 0.9.2 旧的不认识 `--amo-quit`（只会把窗口叫到前面），改成提示去它自己的托盘退出（`system.ts` 的 `QUIT_SINCE`、`runningVersions`）。用户当时开着的是 Studio 0.9.7。
- 验证：vitest 1019 过；平台 e2e 8 条、Reviewer e2e 过，便签 e2e 只剩已知的 Ctrl+Alt+Space 那条（真便签占着热键）；三处深色截图 P12-settings-dark、N3-settings-dark、R3-viewer-dark；托盘菜单深浅两种用临时 Electron 脚本截图看过。打包后的程序没实际打开过。
- 坑：PowerShell 工具里跑 Electron e2e 连不上 127.0.0.1（沙箱），用 Bash 工具跑就好；机器忙时平台查进程（PowerShell `Get-Process`）要 6 秒，超过 e2e 默认 5 秒的 expect，平台 e2e 会卡在「正在连接」，临时把 expect 超时放宽能过。Playwright 默认把 prefers-color-scheme 模拟成浅色，测主题前要 `page.emulateMedia({ colorScheme: null })`。

**2026-10-29 傍晚 · 远程创建合并，测试通道发 Studio 0.9.8、平台 0.9.7、便签 0.9.3、中转外壳 0.9.2（正式通道没动，等用户试过再 promote）**

第 3 步远程创建（子 agent，快进合并 `e34a79c`…`f209b0e`）：A 的 远程 → 远程设置 加「远端允许的项目」（kv `remote.allowedProjects`，含公共文件夹开关；不勾就不能远程建）；新命令 `rt.catalog`（专题、允许的项目、允许的模型）、`rt.create`（A 检查后建任务、授权、开会话，和第 4 步的同意共用 `create.ts` 的 `startGrantedTask`）；B 的新任务页「在这台电脑上 | 在别的设备上」，设备行 → 专题 / 项目 / 模型来自那台，没有附件和 @；设备卡「在它上面新建任务」直接进远程模式；老 A 收到会提示先更新。验证（子 agent）：vitest 1017 过；remote* / newtask e2e 15 过（新 `remote-create.spec.ts` 整条流程）。之前合并后 studio 全量 e2e 186/188（剩下两条是已知的 cli.spec.ts:35、turn-start.spec.ts:74）。**两台电脑都要升到 Studio 0.9.8** 才能远程创建。

**2026-10-29 下午 · 托盘合并、环境页更新、远程单独成页、新任务页改版**

方案 `plans/remote-page-and-new-task.md`（用户已定，含第 6 节托盘）。
- 托盘（`ad9b48b`）：平台启动的工具带 `--amo-tray=platform`，不放自己的托盘；平台托盘菜单按工具分区全部列出（Studio：打开 / 重启 / 完全退出；便签：显示隐藏 / 退出，没单独装时经 Studio 的 `--amo-app=notes`；中转：打开 / 退出；平台：打开、单击图标打开便签或 Studio（`platform.json` 的 `trayClick`，默认便签）、退出平台）。做法：再启动工具 exe 带 `--amo-quit` / `--amo-toggle`，单实例转给在跑的那个；Studio 走自己的完全退出（会先问）。工具卡运行时多「关闭」。单独打开的工具照旧有托盘。
- 环境页（`9ac2cd8`）：Claude Code、Codex 显示 npm 最新版本，有新版给「更新到 x」（npm 装的 `npm install -g …@latest`，官方安装器的 `claude update`）；Codex 被 Studio 后台占着时不更新、说明先完全退出 Studio。`AMO_PLATFORM_NPM_REGISTRY` 换仓库（e2e 指向假的）。
- 管理页：改管理密码（`2b23255`）、邀请口令（`5c2842f`，页面设的优先于 `--passphrase`；线上还没设，等用户设）。都已部署。
- 远程单独成页（子 agent，合并自 `worktree-agent-a768b8ffca7afbff7`）：顶栏「远程」按钮（在线数、待处理的点），`ui/src/remote/` 整页（身份行 → 任务 → 已配对设备 → 远程设置），配对弹窗列同账号在线设备（中转新接口 `GET /api/devices/online`，配对请求可点名一台 `toDevice`；已部署 `2026.10.29-125345`），设置里的远程页删掉。
- 新任务页改版（子 agent，合并自 `worktree-agent-ae9935f3299c142f4`）：专题在项目上面、专题常用项目排前（只有一个时自动选）、每行 6 个 +「更多…」搜索框；第一句话的 @ 引用项目 / 任务（带会话）/ 文件，不再选项目，# 不再选专题；快速启动条加专题、项目两个选择按钮；编辑专题可以加减常用项目。
- 验证：合并后 typecheck 过、全量 vitest 1009 过（claude-runtime 集成测试那条照旧偶发）；平台 e2e、环境 e2e 过；studio 全量 e2e 在跑。便签 e2e 两条因本机真便签占着 Ctrl+Alt+Space 失败、中转 e2e 两条读剪贴板为空（并行测试抢剪贴板），和改动无关，待空闲时重跑。
- 在做：第 3 步远程创建（子 agent）：A 的「远端允许的项目」、`rt.catalog` / `rt.create`、新任务页「在别的设备上」。做完一起升版本发布（平台、Studio、便签、中转外壳）。

**2026-10-29 中午 · 团队服务器管理页、改登录名**：用户要把账号 `Daihongyu` 改成 `dhy`，并要一个简单的管理网页（局域网自用，不走 AMO 登录）。中转服务加 `/admin`（`relay/src/admin-page.ts`）：单独的管理密码（`npm run relay:mac -- admin-password`，存在库里 `admin` 表，哈希；每次请求带 `x-amo-admin`，错了等 0.6 秒），能看成员（在线、登录中的设备数、最近发言）、改登录名、重设密码、停用 / 启用（`members.disabled`，停用时删掉他的登录、不能再登录）。改登录名（`store.renameMember`）在一个事务里改 members / keys / 对话 / 会话 / 消息作者和 @ / 任务和流转记录 / 文件 / 批注 / 设备配对，单聊的 `direct_key` 重算，已有登录照样有效；在线的连接和设备通道断开重连成新名字。命令行也有 `amo-relay rename`、`relay:mac -- rename`（会重启服务）。已部署（备份 `data/backup-20261029-120626.db`），管理密码已设（在用户那里），`Daihongyu` → `dhy` 已经改好。验证：relay 单测 39 过（新加改名覆盖所有表 + 外键检查、停用、管理密码，接口测试含改名后 WS 断开以新名字重连）；管理页截图看过。用户本机平台的 `account.json` 里名字还是旧的，要在平台「账号」里退出再用 `dhy` 登录一次。

**2026-10-29 上午 · 正式通道第一批**：用户定全部转正式。现在两个通道一样：Studio 0.9.7、Reviewer 0.9.6、便签 0.9.2、平台 0.9.6、中转 0.9.1（`platform-status`）。下载页的平台 zip 也是 0.9.6；从下载页装的平台默认看正式通道，同事现在能直接装。

**2026-10-29 上午 · 中转用平台的账号登录（中转外壳 0.9.1 测试通道；界面 2026.10.29-110254 已部署）**

用户：平台打开的中转还在用以前的登录（本机 `%APPDATA%\AMO Relay\settings.json` 里是老的本机测试服务器 `127.0.0.1:47120`），连不上服务器；图标也是旧的。登录：约束第 7 条之前没在中转落地。外壳加 `relayShell.platformAccount()`（读 `%APPDATA%\AMO\account.json`，`@amo-studio/account` 的 `readAccount`，每次问都重读）；界面有它时用平台账号直接登录（`/api/me` 取角色和团队名），并写 `settings.json` 给本机 MCP / 命令行；每 5 秒和窗口获得焦点时再读，平台换账号就跟着换、退出就回到提示；平台装的中转没有平台登录时只显示「在 AMO 平台里登录」（`PlatformLogin`），手动解压的版本照旧用自己的登录页；用平台账号时设置里没有「退出登录」（服务器上退出会让平台的令牌也失效）。旧外壳没有这个接口，界面照旧。图标：开始菜单里有个 10-27 建的「AMO Relay」快捷方式（AppUserModelID `AMO.Relay`，指向 `release/relay-pack` 里旧的、带 R 角标图标的 exe），任务栏按它显示旧图标；已改成指向 `D:\TOOLS\AMO Platform\apps\relay\current` 和新的 `icon.ico`（原快捷方式备份在会话 scratchpad），中转下次启动生效。平台装的 exe 本身是 Electron 默认图标（共用 Electron，方案里定的代价）。验证：relay e2e 4 条过（新加：平台已登录直接进、没登录显示提示、之后登录自动连上、退出回到提示，截图 `screenshots/relay/43-platform-login-there.png`）；relay / account 单测 50 过；打包后的中转用隔离目录启动正常。

**2026-10-29 上午 · 远程也能看文本文件（Studio 0.9.7，测试和正式通道都发了）**

用户：A 上查看器里点 HTML 引用的 md / 脚本会接着在查看器打开（没固定就换掉当前窗口，固定了开新窗口），B 上也要这样。之前 B 只放行 HTML / Markdown / 图片，脚本、配置、txt、json 会被拦。改动：远程文件类型加 `text`——除已知的二进制扩展名（exe、dll、zip、pdf、docx、视频、字体等，B 上直接提示）外都当文本问 A，A 看开头 4 KB 有没有 NUL 字节，文本最大 2 MB（和本地查看器一样，`MAX_TEXT_FILE_BYTES`）；B 上用本地查看器的代码视图显示（高亮、跳到行、查找）。提示改成「远程任务不能看程序和二进制文件，只能看文本、HTML、Markdown 和图片」。验证：全量 vitest 990 过；e2e remote-files（远程 HTML 里点 `../tools/gen.py` 打开、点 `../run.exe` 提示且页面不动，截图 `screenshots/studio/remote-viewer-script.png`）、remote-tasks、viewer-rendered、chat-files 过。

**2026-10-29 上午 · 远程副本归档即删、几项定下不做（Studio 0.9.7）**

用户 10-29 早：「B 归档 = 同时删除」（会话本体在 A，B 只是看）。查到上次「文件夹 20 秒内没删掉」不是杀毒软件：是 B 的 Host 给查看器送图片用的流，查看器换页后一直没关，句柄占着图片（杀掉 Host 立刻能删）。改动：远程缓存的图片（`/api/remote/files/…`）和 `/api/fs/raw` 里 ≤32 MB 的图片改成整个读进内存再发（`FileReply` 的 `whole`），不再留着文件；归档副本时先把 `remote-files/<taskId>` 改名挪到 `.gone-…` 再删（挪不动才退回原来的重试），Host 启动时清掉剩下的；归档时还在路上的取文件不再写回来（不会把文件夹又建出来）。验证：远程单测 31 过（新加「取到一半归档」）；全量 vitest 989 过（claude-runtime 集成测试那条高负载偶发失败，单独重跑 16/16 过）；e2e remote-files（归档后 5 秒内文件夹没了）、remote-tasks、chat-files、viewer-rendered 7 条过。

用户同时定的：会话级授权先不做；远端允许的模型到渠道一级就够；对话正文里 A 的绝对路径先不管（B 只关心在哪个项目）；HTML 的 CSS / JS 不用做——看了 project_mining 里的 HTML 报告（`out/html`、`AIWork`、`Docs` 下 15 份），全是单文件，样式和脚本都内联，远程查看用 `srcDoc` + `sandbox="allow-scripts"`，内联的都能用；引外部 css / js 的只有 `Tools/Archify/web/index.html`（是个工具页，不是报告），Archify 导出页只引 Google 字体（本地看也一样）。

**2026-10-29 早 · 远程第 3、4 步和收尾，测试通道 Studio 0.9.6、Reviewer 0.9.6（用户回来先看这条）**

做了什么：第 3 步（`a2d58e3`）B 在远程任务里点开 HTML / Markdown / 图片：新命令 `rt.file`，A 只放行任务文件夹里（先解析 junction / 软链接）、对话里发过的附件图片，类型 HTML / Markdown / 图片、≤20 MB、512 KB 分片带 sha256；B 缓存在数据目录 `remote-files/<taskId>/`，没变就不重传，A 离线显示上次的版本，归档时清掉；查看器读条「正在从 <A> 取文件…」；HTML 同目录图片走 B 的 `GET /api/remote/files/<随机 key>/…`（不要令牌，只给图片）；A 推给 B 的命令卡片 cwd 改写成「任务文件夹\…」（对话正文里的绝对路径没改）。第 4 步（`e680461`）B 在 设置 → 远程 → 已配对设备「请它跑一个任务…」→ A 的 Focus 出现「任务请求」→ A 在 设置 → 远程 选项目 / 专题 / 允许的模型同意 → A 建任务、授权给 B、开会话发出第一句话 → B 看板出现并在跑；A 可以拒绝写原因；A 离线时 B 发不出（服务器不存请求）。收尾（`15a4e81`）托盘「完全退出」时有任务正被在线设备远程使用会提醒；被远程使用时 A 不睡眠（`powerSaveBlocker`）；B 的 AMO MCP 不列远程副本、碰到副本一律拒绝；B 归档副本会告诉 A 结束授权（`rt.drop`）。另外查看器里的 Markdown 会显示文件旁边的图片（本地文件也是）。

验证：全量 vitest 989 过、typecheck 和 build 过；子 agent 跑了 remote-files、remote-requests、remote、remote-tasks、tray、viewer-rendered、chat-files、markdown、focus、viewer-review、settings、mcp 的 e2e。主会话用测试账号连团队服务器：任务请求整条通过；文件查看整条通过，只有最后「归档后本地文件夹 20 秒内删掉」没等到（Windows 刚写完的大文件被占用，代码会重试、Host 下次启动也会清），不影响使用。

待用户验收（在上面「待用户验收」清单之外）：
- 远程文件：B 上打开远程任务对话里的 .md / .html / 图片链接，看读条和显示；点 .exe 之类会说明不支持。
- 任务请求：B 的 设置 → 远程 →「请它跑一个任务…」；A 的 Focus →「去处理」→ 选模型同意（先在 A 的 设置 → 远程 勾「远端允许的模型」）。
- 完全退出提醒：A 有任务授权给在线的 B 时，托盘「完全退出」会多问一句。

没做 / 以后：会话级授权（只有任务级）；远端允许的模型只到渠道一级；HTML 只取同目录图片，CSS / JS 不取；对话正文里的 A 绝对路径还会带用户名；Focus 里不能直接同意请求（要选项目和模型，只能「去处理」）。下一件：`plans/relay-in-sessions.md`（会话里直接用中转，用户 10-29 定在远程之后）。

**2026-10-29 凌晨 · 远程第 2 步（测试通道 Studio 0.9.5、Reviewer 0.9.5）**：A 把任务授权给配对的设备（`942e099`…`c84173d`）。「远程」是 B 的 Host 里一种会话运行方式（`RemoteAwareRuntime`，runtime `remote`）：B 的副本放公共目录、`tasks.remote` 列（migration 23，0.9.5 打开过数据后不能回 0.9.4）；A 的远程命令 `rt.list / rt.task / rt.items（since 补齐）/ rt.send / rt.approve（先到先得）/ rt.answer / rt.interrupt / rt.start`，推送 `rt.push`；授权表 kv `remote.grants`、远端允许的模型 kv `remote.allowed`（只到渠道一级）；B 在线时 A 的 Focus 不提醒；被授权任务里禁止跨项目委派。主会话补了一处（`8c88d9a`）：B 上的远程副本不算「正在跑的会话」，不挡完全退出 / 重启。验证：合并后全量 vitest 975 过；remote-tasks / remote / canvas-resize / board / focus e2e 过；tray 的一条在 20 条之后跑时超时一次，单独重跑 2/2 过（偶发）。用测试账号连团队服务器走通：配对 → 授权 → B 看板出现 → B 发消息 A 回复 → 审批 B 点批准两边同步 → B 新开会话 → 收回授权 B 显示「授权已收回」（断线那段在真服务器上没法测，本地 e2e 覆盖）。在做：第 3 步（B 看 HTML / Markdown / 图片，读条）、第 4 步（B 请求、A 同意后自动建任务）、收尾（A 完全退出前提醒远程使用、被远程用时阻止睡眠、B 的 MCP 不把副本当本地任务）。

**2026-10-29 凌晨 · 待用户验收（测试通道：Studio 0.9.4、Reviewer 0.9.4、平台 0.9.6、便签 0.9.2、中转 0.9.0；之后 Studio / Reviewer 又发了 0.9.5）**

Studio 托盘（`04869d9`）：× 只隐藏窗口，Studio 和 Host 留在托盘；托盘「完全退出」连 Host 一起关（有会话在跑先问）；`/api/health` 带 `version`；`POST /api/shutdown`（要令牌，有会话在跑时 409，带 `interrupt` 才放行，退出前写 `host-exit.json` 让外壳跟着退）；外壳写 `shell.json`；平台 Studio 卡片显示后台状态和版本，后台比已装旧且空闲时给「重启 Studio」（平台从不带 interrupt）。验证：合并后全量 vitest 963 过；e2e tray / remote / canvas-resize 6 条、platform 8 条过。

验收清单（给用户）：
1. **第一次升级 Studio 要手动关一次旧后台**：现在跑着的 Studio 0.9.3 后台不报版本、没有退出接口，平台的「重启 Studio」用不了。做法：Studio 里没有会话在跑时，关掉 Studio 窗口，再用任务管理器结束剩下的 `AMO Studio.exe`（或者让主会话来关），然后在平台里把 Studio 更新到 0.9.4 再打开。以后就能用托盘「完全退出」和平台的「重启 Studio」了。
2. 平台更新到 0.9.6（顶栏会提示「平台有新版」→ 设置 → 平台更新 → 重启平台）。Studio 卡片上应该能看到「后台在运行 · N 个会话进行中 · 后台版本 0.9.4」。
3. Studio 托盘：点 × 窗口消失但托盘还在、会话照跑；点托盘图标回来；托盘右键「完全退出」。
4. 画布：拖卡片和分组的右下角改大小、双击恢复；删分组时的勾选框。
5. 设置 → 远程：本机设备名、连接状态应是在线（已部署到团队服务器）；配对要另一台电脑（或另一个账号的 Studio），没有也可以先看界面。
6. 远程授权（Studio 0.9.5 起）：需要两台电脑（或另一个账号的 Studio）先配对；A 的任务页 ⋯ →「授权给…」，B 的看板会出现「远程在 … 上」的任务卡，能发消息、审批、新开会话；A 在任务页或 设置 → 远程 里收回。设置 → 远程里的「远端允许的模型」先看一眼。
7. 留意杀毒软件有没有再拦。

**2026-10-29 凌晨 · 远程第 1 步上线、画布调整（用户不在，主会话接着推进）**：远程会话第 1 步（`528f446` 中转服务端的设备登记 / 配对 / 只在配对设备间转发，`c2bb7be` Studio 的 Host 连出、设置 → 远程、配对请求进 Focus、设置旁亮点；设备编号 `%APPDATA%\AMO\device.json`，配对存 Host kv `remote.pairs`）已部署到 Mac（health 里 `devices: 1`）。主会话在团队服务器注册了测试账号「测试-A」「测试-B」（负责一栏写明是测试账号，密码在主会话 scratchpad 的 test-accounts.json），用两个 Studio 测试实例连真服务器走通：配对请求 48 ms 到达、测试连接往返 2–4 ms、解除配对两边同步。画布（`88f9648`）：删分组有确认框和「同时删除组里的 N 张卡片」（任务卡只从画布拿掉，任务不删），删除配色同「归档」，四种卡片拖右下角改大小（存在画布 JSON 的 `size`，无新迁移）。修了一条早就红的 e2e（`c622cc6`，naming）。`studio` e2e 里还有两条在 master 上就红的：`cli.spec.ts:35`、`turn-start.spec.ts:74`（第 1 步的 agent 切到旧提交复现过，和这轮改动无关，没修）。测试预算：gpt 300、claude 300、dsh-dxx-ds 1000（`bf96f93`）。在做：Studio 托盘、远程第 2 步。

**2026-10-28 深夜 · 平台 0.9.5：装在解压的文件夹里、账号页、「⋯」菜单；服务器清旧版本**：平台和工具装在平台所在的文件夹（`cb35829`，入口转发 + 入口换新，火绒对旧的「原地改名」方式报过勒索行为，新方式没报）；账号单独一页，昵称、头像、负责什么从中转搬到平台改（`7a083ce`，中转界面只显示、提示去平台改）；回滚和卸载收进「⋯」。服务器每个工具留最近 3 个版本（`b2aca32`），用户手动跑过一次 `platform-prune` 删了 410 MB，以后 publish 自动清（这次自动删了平台 0.9.2）。`npm run relay:mac` 加了本机允许规则（`.claude/settings.local.json`）。`studio/.data` 旧备份清掉，留最近 5 份（7.4 GB → 1.2 GB）。远程会话方案定了大半（`plans/remote-session.md`：远程用、按任务 / 会话授权、B 是自己的另一台设备但不同账号要配对、B 上远程任务是普通任务卡、Focus 只提醒 B），平台稳定后开工；Multica 调研在跑。验证：全量 vitest 935 过（1 条 claude-runtime 集成测试忙时超时，单独重跑 16/16 过）、平台 e2e 7 条和中转 e2e 4 条（子 agent 跑）。待用户：删掉 `D:\TOOLS\AMO Platform` 和 `AppData\Local\AMOpps`，重新下载 zip 解压试用。

**2026-10-28 深夜 · 杀毒误报、中转走平台**：用户的杀毒软件（像火绒）在平台下载 Studio 时把 `host/dist/runtime/priority.js` 报成 Trojan/Veil.a（`-EncodedCommand -ExecutionPolicy Bypass` + `Add-Type DllImport ntdll` 改别的进程）。本机用 curl 和平台 exe 下载都复现不出。修法（`322cb20`）：6 处 PowerShell 调用改成脚本走 stdin，不再有 `-EncodedCommand`/`Bypass`/`ntdll`；agent 进程去掉磁盘优先级（用户同意），内存优先级改用 `SetProcessInformation`，CPU 照旧。中转桌面客户端改由平台安装和更新（`11d0cf7`，`AGENTS.md` 第 3 条已改）：平台模式的中转不再自己更新外壳，界面照旧热更新；MCP 配置和 `amo-relay.cmd` 指向 `apps
elay\current`；平台打开中转时带 `--server`。发布：中转界面 deploy（服务没变、没重启），测试通道 Studio 0.9.3、Reviewer 0.9.3、中转 0.9.0、平台 0.9.4（便签仍 0.9.2），每个新上传都不到 0.3 MB；下载页 zip 0.9.4。验证：全量 vitest 917 过、typecheck 过；平台 e2e 6 条、中转 e2e 4 条（子 agent 跑）。没验证：杀毒软件还拦不拦（等用户在平台里重装 Studio）；中转登录还是自己的登录页（改读平台的 `account.json` 是下一件事）。

**2026-10-28 夜 · 平台自更新，测试通道发平台 0.9.3**：平台自更新（`da59bf7`，`self-update.ts`：发现通道里 `platform` 的新版 → 「设置 → 平台更新」装进 `apps\platform\<版本>` → 人点「重启平台」；从 zip 解压的第一次更新后搬进 `apps\platform`，开机启动改指 `current`；开发版不自更新）。工具照旧从版本文件夹启动、不走 `current`（查过原因，见方案）。平台 0.9.3 发到测试通道（新上传 16 个文件，0.1 MB），下载页 zip 换成 0.9.3。验证：子 agent 用真打包的平台在本机走过「发现新版 → 更新 → 重启 → 登录还在」；合并后 typecheck、平台和 app 的单测 47 条过。注意：稳定通道还是空的，从下载页装的平台默认看稳定通道，要切到「测试」才看得到工具；给同事用之前要 `promote`。

**2026-10-28 夜 · 共用 Electron、环境页，测试通道发 0.9.2**：共用 Electron（`1d2f264`：`npm run package:platform` 打平台包到 `release/platform/`，exe 不写图标，安装引擎按 sha256 跨工具硬链接，`file-index.json`）；平台「环境」页（`7bb3e78`：Claude Code、DSH 桌面版、Codex、git，去下载官方页，新包 `@amo-studio/locate` 放 host 和平台共用的查找函数）；平台装的 Studio 不经平台打开时读 `%APPDATA%\AMO\platform.json` 的数据目录（`8be9e9e`，只认平台模式的包）。四个工具 0.9.2 发到测试通道：Studio 新上传 24 个文件（共用的 exe 压缩后 104 MB，只传这一次），Reviewer、便签各 2 个、平台 16 个，都不到 0.1 MB；下载页的平台 zip 换成 0.9.2（portable 模式）。验证：合并后 typecheck、相关单测、平台 e2e 4 条过；环境页两条测试在忙机器上不稳，改了（`ed8327d`）。平台自更新在做（子 agent）。

**2026-10-28 夜 · 图标、注册、下载压缩，测试通道发 0.9.1**：图标定成「取景框」一家（`design/icon/tools/`，生成器 `gen-tools.mjs`，`make-icons.mjs` 出各工具的 png/ico/托盘图，Reviewer 和平台有了自己的，AMO 娘没动，`5d8d3cd`）；平台登录页能注册（`d1ad3e1`）；下载压缩（`707b3c6`，规则写进方案的接口约定）。Mac：先 deploy 新服务（一次成功，START 的修复有效），再 `platform-compress`：8463 个文件 1077 MB → 467 MB，167 秒。四个工具升 0.9.1（各自 CHANGELOG），打包、发到测试通道：每个工具新上传 3–21 个文件，约 235 MB、压缩后 104 MB（几乎都是 exe：rcedit 给每个 exe 写了自己的图标，每版都不同，共用 Electron 会解决）；平台 zip 换成 0.9.1。中转下载页只给平台（`8387fc7`）。验证：合并后 typecheck、account/platform/relay/testkit/scripts 的单测 103 条、平台 e2e 2 条都过；压缩脚本在 Mac 上每个文件解压核对 sha256。没在真服务器上用账号装过（等用户第一次用平台）。下一步：共用 Electron（方案「共用 Electron」一节）。

**2026-10-28 晚 · 平台部署到 Mac、测试通道第一批发布**：本机 Studio 关掉前没有会话在跑（17 空闲、26 完成），库备份 `.data/backup-before-platform-20261028`。`relay:release` → `relay:mac -- deploy`：重启时 launchd 报 `Bootstrap failed: 5`（`bootout` 是异步的，紧接着 `bootstrap` 会撞上），服务停了一两分钟，`start` 拉起来了；`relay-mac.mjs` 的 START 改成等旧任务真正卸载再 bootstrap。plist 带 `--platform-dir /Users/td/Services/amo-relay/platform`。Studio / Reviewer / 便签 / 平台 0.9.0 都发到测试通道（Mac 上 bash 3.2 + BSD tar 那条路正常；Studio 传 6571 个文件 269 MB，Reviewer 只缺 4 个），共 8463 个文件 1.1 GB。平台 zip 手动放在 `platform/downloads/AMO-Platform-win.zip`（sha256 和本地一致），下载页有「下载 AMO 平台」。还没做：用户用 `start-platform.cmd -Test` 登录、装 Studio、把数据目录设成 `studio\.data` 后从平台打开（第一次由用户操作）；稳定通道还空着。

**2026-10-28 晚 · AMO 平台第一版**（方案 `plans/amo-lan-platform.md`「10-28 晚定的推进方式」「第一版的接口约定」「进度」；三个子 agent 在 worktree 里并行做，主会话合并和联调）：
- 小改动：Host 遇到被更新版本迁移过的数据库拒绝启动，弹窗说明（以前启动失败是一声不响地退出，现在都弹窗）；`/api/health` 不要令牌，多返回 `running`；设置 → 维护的终端可选 Claude Code / Codex。
- 服务器发布：Studio（`packages/app`）、Reviewer、便签、平台各自的版本号（都 0.9.0）和 `CHANGELOG.md`，工具表 `scripts/amo-tools.mjs`；`package:portable -- --only <工具>`；中转服务 `--platform-dir` 和三个平台接口；`npm run relay:mac -- publish/promote/platform-status`（`--target-dir` 发到本机文件夹）。
- 平台：`packages/account`（登录、`account.json` 用 DPAPI 加密、最近 3 个服务器）、`packages/platform`（托盘、单实例、版本文件夹 + `current` 联接、硬链接复用、sha256 校验、保留 2 个版本、回滚、卸载、拉起 Studio 必须先设数据目录）、界面 `platform.html`。开发时 `npm run platform`；双击用 `start-platform.cmd`（`-Test` 走测试通道）。
- 验证：各 agent 的单测和 e2e（`--project platform` 用 testkit 假服务器走完登录 → 安装 → 更新 → 回滚 → 卸载 → Studio 数据目录，截图 `screenshots/platform/`）；合并后全量 vitest 869 过，host 包 4 个文件机器忙超时，单独重跑 21/21 过；typecheck 过。主会话本机联调（真实中转服务 + 本地发布 + 打包好的 `AMO Platform.exe`，临时目录）：发布便签 0.9.0（3384 个文件）→ 平台登录 → 安装 5 s、文件逐个对上 → 发布 0.9.1（只传 2 个文件）→ 更新 2 s（3382 个文件硬链接复用）→ 回滚 → `account.json` 的 key 是加密的 → 真实 `%APPDATA%\AMO`、`%LOCALAPPDATA%\AMO` 没被碰。
- 没做：部署到 Mac（`relay:mac -- deploy` 会重启中转一次，要先问用户）、第一次真实发布（Mac 上是 bash 3.2 和 BSD tar，要盯着）、平台 zip 上服务器、第 3、4 步、平台图标（等用户在图标家族方案里选）。本机 master 上新增了两个 workspace 包，`start-platform.cmd` 第一次运行会 `npm install`。

**2026-10-28 · 数据位置检查**（平台方案「开工前先整理」第 4 步，只查不改代码）：用 `release/` 里 10-24 的三个 portable 包实测（解压到 `%TEMP%mo-studio-sandbox`，设好变量、测试模式、端口 0，各跑一次再关掉，比对程序文件夹前后的文件清单）：三个程序文件夹都**没有任何新增或改动**，`%APPDATA%` 下的 Electron、AMO Studio / Reviewer / Notes、AMO 也没被碰；数据都进了变量指的目录（Studio：studio.db、host.log、codex、common、electron 等；Reviewer：data、electron；便签：electron）。10-24 之后这几处路径代码没改过。代码上也对得上：Studio 设了 `AMO_STUDIO_DATA_DIR` 就不走首次设置，不写 `amo-studio.json`（`app/src/paths.ts`）；Host 的东西全在数据目录下（`host/src/host-process.ts`）；Reviewer、便签不设变量时也默认在 `%APPDATA%`，只有 Studio 不设变量时会用 exe 旁的 `data/` 和 `amo-studio.json`。所以平台装 Studio 时**必须**设 `AMO_STUDIO_DATA_DIR`，另两个设不设都不会写进程序文件夹。没覆盖到的：没开真实会话、没走 DSH、没用附件，但这些都按 Host 的数据目录走。 详细见 `plans/amo-lan-platform.md` 第 4 条。

**2026-10-28 · 整理：HANDOFF 瘦身、旧文档归档**（平台方案「开工前先整理」第 1、2 步，只动文档）：这份文件只留当前状态和 10-26 以来的记录，更早的原样挪到 `docs/history/handoff-2026-10.md`；`docs/` 里 /loop 时期的五份文档挪到 `docs/archive/`，`plans/stage-1…17` 挪到 `plans/done/`；`README.md` 的「开发者文件导航」、代码注释里指向 `plans/stage-*.md` 的路径跟着改；`design/architecture.md` 开头标了哪些部分已过时；`packages/relay/README.md` 注明本机跑中转的脚本只是退路；`plans/` 里三个没跟踪的原型 html（relay-tasks、relay-ui-prototype、token-stats-prototype）用户让删了。全部用 `git mv`，历史还在。

**2026-10-28 · 新架构：AMO 平台（amo-lan-platform）**：用户定了以后的开发流程——本机开发 → 推送到团队服务器（Mac）→ 每个人在托盘常驻的「AMO 平台」里自己选怎么更新；平台安装、更新、设置 Studio / Reviewer / 便签，不改工具本身；中转保持现状。根目录新增项目说明 `AGENTS.md`（`CLAUDE.md` 引用它），写了工具和包的对应关系和**架构约束**（工具不依赖平台、数据不放程序文件夹、更新只走统一方式、Reviewer 只有一份、各工具单独的版本号、重启由人点）。方案和「开工前先整理」的清单在 `plans/amo-lan-platform.md`。界面原型：https://claude.ai/artifact/Uu4fL3bXZg1NZHXDSKBPc9 。下一步：用户看原型，然后先做整理（HANDOFF 瘦身、旧文档归档、各工具单独的版本号）。

**2026-10-28 · AMO 中转部署到 Mac**：服务在 Mac mini `http://172.16.8.85:47120/`（SSH 别名 `mac`，用户 td），launchd `com.amo.relay`，程序 `~/Services/amo-relay/app`、数据 `~/Services/amo-relay/data`。从本机管理：`npm run relay:release` 后 `npm run relay:mac -- deploy`，另有 status/restart/logs/backup/`passwd <名字>`（重设并打印新密码）/migrate，见 `packages/relay/README.md`。用户决定不搬本机数据：Mac 从空库开始（拷过去的那份另存为 `data/copied-from-windows-20261028-164410.db`），大家重新注册。Windows 上的旧服务（172.16.1.62）10-28 已停（`scripts/relay-service.ps1 stop`），同事在客户端点「更换」填新地址。下一步方案见 `plans/amo-lan-platform.md`（团队安装更新平台，中转保持现状、改用 Reviewer）。同时做了：读条页记住最近 3 个服务器（`shell.json` 的 `recent`，默认连上次的），登录页在新地址上找不到已存账号时借用别的地址上存的（服务器搬家后不用重输密码）；e2e 第 3 条覆盖，截图 `screenshots/relay/34-recent-servers.png`；桌面程序 zip 已重打（build 2026.10.28-161641）。

**2026-10-28 · AMO 中转收紧**：relay 只突出一件事——策划的 AI 卡住了、或方案要程序把关时发会话给程序，程序单轮或多轮回复后 AI 继续推进；人和人只聊天。任务、新会话、流转、团队流程/流程速查的入口都藏起来了（代码和数据都在，`relay-ui/src/features.ts` 的 `fullUi()`，localStorage `amo-relay.full=1` 打开），给 AI 的用法默认不提团队任务。见 `plans/relay-tasks.md`「收紧」，已发布客户端 2026.10.28-122112。

**2026-10-28 · 渲染批注**：查看器（和查看包里的文件）里 Markdown、HTML 默认渲染显示，选中文字点「批注」就能写意见，右边是批注栏。批注还是项目的文件批注（range `file`，`GitReviewComment.passage` = 引文 + 前后各 24 字 + 可选源 md；`line` 是推断的源码行，所以切到「源码」也在那一行），用原来的「复制注释」一起带走。定位做法同 relay 2d：`viewer/passageKit.ts`（自包含函数，渲染 md 直接用；HTML 时把它的源码注入 iframe），文件重新生成后按原文和上下文重新找到，空格多了少了也能对上，找不到的标「原文找不到了」。HTML 在 `sandbox="allow-scripts"`（不给同源）的 iframe 里**照常运行脚本**，注入脚本（`viewer/passages.ts` 的 `frameMain`）负责报告选区、画高亮、跳转时展开收起的 `<details>`、内存版 localStorage、复制按钮经查看器写剪贴板、外链交给系统浏览器。HTML 的源 Markdown 自动找：`<meta name="amo-source">`、同目录同名 .md、页脚（`<footer>` 或页尾）写的 .md；找到时批注里写「这份 HTML 由 x.md 生成：请改 x.md，再重新生成这份 HTML」（用户决定不改 `html-output.md` 规则）。e2e `viewer-rendered.spec.ts`，截图 `screenshots/stage-18/S25-rendered-*.png`。链接（同日补）：网址交给系统浏览器；`#标题` 在本页跳（Markdown 按 GitHub 规则算标题锚点，HTML 的锚点由注入脚本滚动，因为 srcdoc 里 `#x` 会按查看器地址解析）；其他文件（相对当前文件、绝对路径、`file:///`，可带 `#L12` 或 `:12`）在查看器里打开（`passages.ts` 的 `resolveLink`）。没做：右栏快速查看里的 HTML 仍是源码；HTML 里没有 Ctrl+F。同日：**查看器是默认方式**——对话里单击 .html 也进查看器（原来是浏览器），浏览器在菜单里；文件右键菜单改成共用的 `lib/ActionMenu.tsx`（分组 + 分隔线，每项右边一个字母，菜单开着时按字母直接执行，菜单先接按键所以不和页面快捷键冲突）。对话里：在查看器中打开 O / 在侧栏预览 P / 查看未提交的改动 D / 用 VS Code 打开 V / 用浏览器打开 W（仅 html）｜在资源管理器中显示 E｜复制路径 C / 加书签 B。Review 文件列表：在查看器中打开 O / 用 VS Code 打开 V / 用浏览器打开 W｜在资源管理器中显示 E｜复制路径 C。Review 文件标题栏「查看文件」挪到最前；侧栏预览标题栏加「在查看器中打开」。 同日：**位置批注**——HTML 页面任意位置右键「在这里批注」（A；有选中文字时还有「给选中的文字批注」S），钉编号圆点，批注栏里同号。记的是元素（先按 id，再按路径并用文字核对，最后按附近文字）和点在元素框里的比例（`GitCommentPassage.point`）。HTML 交给 iframe 前每个开始标签加 `data-amo-line`（`passages.ts` 的 `lineTags`），复制出的批注写 `path:元素所在行（位置批注：标题 › 元素）`，`>` 后是离它最近的文字。用户 10-28 决定：**截图先不做**（原方案：Electron 截点附近一块存 attachments，批注里写路径），先用一段时间再定；框选区域也没做。已知：行号是写批注时的，文件重新生成后不更新。

**2026-10-27 · 画布审阅（分支 `studio/review-canvas`，worktree `G:\PROJECT\AgentMonitorOverlay-review`，未合并）**：要点多的审阅放到专题画布上。AI 用 `canvas_items_post` 铺编号的审阅条目卡片，用 `canvas_callout` 在卡片上写说明或提问。人在画布上点问题，弹窗回答；回答作为消息发回提问的会话，问题框收成「已回答」，卡片显示进行中。条目右键可以改状态，或者「就这条展开聊」（开一个新会话）。侧栏新增「沟通」页。计划、场景和进度在 `plans/review-canvas.md`，决定记在 memory `review-canvas-decisions`。10-27 用户让直接合并（fast-forward 到 master）并重启验收；重启前备份在 `.dataackup-before-review-canvas-20261027`，重启后任务 38、专题 3、会话 150 与重启前一致，数据库到迁移 22。同次：Review 文件列表右键对 .html/.htm 加「浏览器打开」（`7a113fc`）。阶段 3 也已合并（`6fd0d6e` 专题分组、`38c78e8` Focus 画布问题 + 画布小窗），15:13 重启，**带着 `AMO_STUDIO_TRACE_STALLS=1`**：用户说推进任务时又有卡顿（14:40 主进程最长 4.1 s、14:48 880/718 ms），抓到后分析（15:15:13 那份）：主线程 646 ms 卡在 `amo:app-icon` → `mainWindow.setIcon`（等 Windows 处理 WM_SETICON），AMO 娘表情一变就换一次窗口图标 → 改成窗口图标固定为她的头像（`afd9a42`）。同时发现 15:14:13 Host 被看护误重启：看护改为 `/api/health`、5 s × 3 次、进程还在就只记日志不重启，日志进 resize-trace.log；`host:stop` 遇到 taskkill 部分失败不再崩（`744849e`）。15:26 重启，仍带 `AMO_STUDIO_TRACE_STALLS=1`。

**2026-10-26 · AMO 中转（`packages/relay`）开工**：让 AI 会话把请求发给团队里的人（比如策划的 AI 去问程序），人和人之间也能直接聊，记录存在服务上。中转服务跑在 Mac 上。计划和进度见 `plans/relay.md`，用户的决定记在 memory `relay-decisions`，用法见 `packages/relay/README.md`。已经做好服务、命令行、MCP、桌面客户端（`relay-app` 外壳 + `relay-ui` 界面，界面由服务器下发热更新）和账号密码。**本机已经部署**：`http://172.16.1.62:47120/`，用 `scripts/relay-service.ps1` 启停。更新界面跑 `npm run relay:release`，不用重启服务，在线的客户端会自己更新（窗口没在用、也没有草稿时）；改了服务端代码要 restart。登录页和登录后都会显示服务器状态，断开后自动重连（1c）。10-27：话题、归档、气泡（1d）；阶段 2 方案 `plans/relay-tasks.md`，**2a 完成**：请求变成会话（现在等谁、AI 取回 / 卡住 / 我来处理、需要回复的会话只有发起方能标记完成），界面换成 Studio 的设计（引用 `packages/ui/src/styles/base.css`，深浅色）。**2b（团队任务）、2c（文件）、2d（批注）也已完成**（服务 0.5.0），进度见 `plans/relay-tasks.md`。Mac 打包机部署等用户准备好 SSH。
