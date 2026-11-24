# 交接：AMO 的当前状态

新会话先读这份。长期有效的规则在仓库根目录的 `AGENTS.md`；这里只写**现在**的状态和还开着的事，不记改动流水（2026-11-06 用户定）：改了什么看 `git log` 和各包 `CHANGELOG.md`。做完一段，只改下面受影响的行（状态变了、事做完了就删掉那一行、新开的事加一行）。

找功能在哪：`node scripts/nav.mjs --query 关键词`（导航索引，`docs/nav/`）。查某个功能当初为什么这么做：先看 `plans/` 里对应方案开头的状态和正文的决定，再在 `docs/history/`（11-06 之前的交接记录：`handoff-2026-10.md`、`handoff-2026-10-late.md`、`handoff-2026-11.md`）、`plans/done/`、`docs/archive/`（/loop 时期）里搜。文档怎么分层见 `plans/doc-architecture.md`。

## 在哪、怎么跑

| 项目 | 内容 |
|---|---|
| 开发目录 | `G:\PROJECT\AgentMonitorOverlay\studio`（桌面快捷方式「AMO Source」指这里的 `start-studio.cmd`） |
| 分支 | `master` 是主线；旧版 AMO 在标签 `amo-legacy-final` |
| 常设 worktree | 都是 master 的 detached worktree：值守目录 `G:\PROJECT\AgentMonitorOverlay-duty`（值守修问题、`release land`）、打包目录 `G:\PROJECT\AgentMonitorOverlay-release`（自动打包跑 `release auto --if-due`）。别的 worktree 是各任务自己的（`git worktree list` 看） |
| 用户在用的 Studio | 平台装的版本（`D:\TOOLS\AMO Platform\apps\studio\<版本>`），不是这个开发目录：在这里改代码、build 都不影响它；提交进 master 且写了「下一版」的会被自动打包发到测试通道，用户自己选装 |
| 开发版 | `npm start`（先 build 再开窗口），数据在 `studio\.data`。Host 常驻在 47900 端口；改了 Host 代码要先 `npm run host:stop` 再 `npm start` |
| 帮用户重启开发版 | **先问用户，而且只在没有会话运行时做**。`npm run build` → `npm run host:stop` → 结束 `electron.exe packages/app` 主进程（命令行不含 `--type=`）→ 备份 `.data\studio.db*` 到 `.data\backup-before-<名字>-<日期>` → 在 PowerShell 里先删掉匹配 `^(CLAUDE|ANTHROPIC_|AMO_STUDIO_|NO_COLOR$|FORCE_COLOR$|COLOR$|TERM$)` 的环境变量（Claude Code 工具 shell 带的，Studio 会传给维护终端）→ `Start-Process node_modules\electron\dist\electron.exe packages/app`（工作目录 `studio`）→ 用 `.data/host-token` 在 node 脚本里查 `GET /api/state` 核对任务和会话数（不打印令牌）。只改界面时让用户按 Ctrl+R 即可 |
| 验证 | `npm run verify`（typecheck + vitest + build）；`npm run e2e`（Playwright project：`studio`、`notes`、`reviewer`、`relay`、`platform`）。都用 BelowNormal 优先级、`--maxWorkers=6` |
| 发布 | 都走 `npm run release`（用法在 `scripts/release.mjs` 开头，节奏见 `plans/release.md`）。自动打包每 60 秒跑 `release auto --if-due`，只发「下一版」里有条目的工具。各工具现在的版本：`npm run release -- status` |
| AMO 中转 | 服务在 Mac mini `http://172.16.8.85:47120/`（SSH 别名 `mac`）。部署：`npm run release -- relay-service`（会重启中转几秒，先问用户）；底层命令和服务器上的位置见 `packages/relay/README.md` |

## 规则补充（`AGENTS.md` 之外的细节）

- 不改 `~/.codex/config.toml`、`~/.claude/` 设置、用户已有的凭据条目（Studio 只写用户在 设置 → 模型 加渠道时的 `channel-<id>` / `channel-<id>-access`）。
- 测试只在 `%TEMP%\amo-studio-sandbox\` 和临时目录；端口只用 47900–47999；测试窗口不抢焦点、不开终端/浏览器、不碰剪贴板。
- 不 reset --hard、不删分支。密钥不打印、不写日志/文件/命令行。
- **真实模型额度**（`budget.json`，用 `spikes/lib.mjs` 的 `countTurn(note, provider)` 先计数再调用，以文件为准）。平时测试用 mock。
- 工具坑：heredoc 里的 Python 会吃掉 `\n`、`\v` 等转义 → 有转义的改动用 Edit/Write 或 scratchpad 里的 `.py` 文件；Windows 文件名不分大小写（`Transcript.tsx` 和 `transcript.ts` 会撞）；跑完 e2e 用 `git checkout -- studio/screenshots/` 丢掉无意的截图变化；清理 `%TEMP%\amo-studio-test-*`、`amo-studio-e2e-*`。

## 还开着的事

| 事项 | 状态（2026-11-06 核对） |
|---|---|
| 文档整理（Archify 三层） | 11-06 用户审过，合进 master：HANDOFF 瘦身、导航索引 `docs/nav/`（`node scripts/nav.mjs`）+ 锚点测试、plans 只留决定、`plans/later/` 放以后推进的。维护办法和对比实验在 `plans/doc-architecture.md`；以后每批文档改动后用里面的 3 个问题复测 |
| Host 结构 | `plans/host-structure.md`：8a–8c 已合进 master；剩一个 feature 环组 {collab、gitreview、projects、remote、review、sessions、tasks、viewpacks}，拆法写在方案里，没开工。项目梳理总表 `plans/done/cleanup-2026-11.md` |
| 中间层主线（11-19 定） | 用户定「AI 写结构化状态、人看和批注」先只试白板，别的版本停下或并进白板（盘点在主工作区 `out/html/amo-iteration-inventory.html`，不进仓库）。由「AMO迭代」专题的主控会话推进，决定记在专题文档「决定记录」。全景挪进了 `plans/later/userlayer/`（分支 `studio/panorama` 多 4 个提交，不合、不删） |
| 脉络（tracks） | **11-20 冻结**：楼的开关和代码留着、不再加东西，删不删等用户说；顶楼画布并进白板（`plans/tracks.md` 开头）。以下是冻结前的记录。11-09 开工，`plans/tracks.md`。第 0 步（测试功能「开发中」标签、「脉络」开关）合进 master，随 Studio 测试版发；之后在 worktree `G:\PROJECT\AgentMonitorOverlay-tracks`（分支 `studio/tracks`）用开发界面目录迭代。11-15：界面示例 v7（楼）和 alt（并排立面）做完，成品在主工作区 `studio/out/tracks/proto-v7.html`、`proto-alt.html`（源文件在那个 worktree 的 `plans/tracks/`，没提交）。同一天用户定直接走 v7：「脉络会话」第一版合进 master（对话上方「对话 | 脉络」+「脉络会话」勾选；楼是 Host 从会话记录现算的，AI 用 `track_note` 写每轮标题和「要点」；楼的页面是 `packages/ui/tower.html`，在 iframe 里），11-16 用户用过之后：点卡片改成会话弹窗、导航和坐标挪了位置，并说「脉络可能没那么方便，顶楼有必要，先不删、再用一段时间」——楼先留着不再加东西。同一天用户又要弹窗能拖出主窗口：会话弹窗改成独立的系统窗口（`app/src/round-window.ts`、`ui/src/tracks/RoundApp.tsx`；对话的接线从 `TaskPage.tsx` 抽成了两边共用的 `task/SessionThread.tsx`），随 Studio 0.9.74 发到测试通道。等用户在真屏幕上用：拖到别的显示器、记住的位置、和主窗口的前后关系、焦点都只有 e2e（窗口在屏幕外）验过；开着弹窗退出会卡住的原因没查到，现在是退出前先关弹窗（`before-quit`）。worktree `studio/tracks` 现在和 master 一样，可以接着用。没做的列在 `plans/tracks.md`「脉络会话（楼）」末尾。**11-16 晚用户换了方向**：楼层去掉，只留顶楼，顶楼改成 CSS 3D 的画布，数据用白板的节点（`plans/tracks.md`「顶楼画布」）；HTML 原型在 `studio/out/tracks/roof-canvas.html`，等用户看过、答完原型页末尾的五个问题再接进 Studio |
| 白板（whiteboard） | **中间层主线**（11-19），「AMO迭代」主控会话 11-19 起在用，摩擦记进专题文档。11-16 用户提的：AI 写、人只看和批注的会话工作白板，`plans/whiteboard.md`（代码里叫 whiteboard，board 是看板）。第一版在测试功能「白板」后面（Studio 0.9.73 起）：AI 用 `whiteboard_update` 写节点、`whiteboard_view` 可以自己给画它的 HTML，人在节点上或任意位置写批注、随下一条消息带给 AI。入口：设置 → 测试功能 →「白板」，会话对话上方那一行的「白板」→「开白板」（用户 11-16 问过入口，已答，还没说用得怎么样）。等用户用真任务试，要定的几条在方案「还要用户用过再定的」（最要紧：真模型会不会勤快地写、多花多少 token，没验证）；之后是任务级的白板 |
| 协作（cowork） | 11-23 用户从「步长太大、审核爆炸」谈出来的：中转上一个协作，人和各自拉进来的 Studio 会话一起推进一件事（群聊、子会话弹窗、@ 才叫醒 AI、白板弹窗多人同时改），中转客户端同时整体换成原型 A 的布局。`plans/cowork.md`；11-23 第一版合进 master、中转服务部署、测试包发出（用户授权做完直接发，回来一起审）。真模型场景 `spikes/cowork-scenario/`（报告在主工作区 `studio/out/cowork-scenario/`）。11-24/25 换成事项架构（见下一行），中转服务 0.7.20 + Studio 0.9.85 发测试通道，用户 11-26 装来试；怎么测在 `plans/collab-round-report.md`（旁边有 HTML）。分支 `studio/cowork`、`collab-items`、`collab-studio`、`cowork-ui`、`collab-local`、`cowork-e2e` 和对应 worktree（`AgentMonitorOverlay-cowork*`、`-local-mail`）都已合进 master，等用户点头删 |
| 交流框架（事项 / 消息 / 板） | 11-20 起后面几步等白板升到任务级再定，第一版照常用（`plans/collab-framework.md` 开头）。11-15 和用户谈定概念，`plans/collab-framework.md`；第一版合进 master（消息带来源 `origin`、对话里折叠成一行、「脉络」开关后的事项清单；打字时不插队用户当天说先去掉，改成脉络「详细设置」页里默认关的选项；这条线上做到一半的东西以后都先放那一页）。11-24/25 用户定「趁现在落完整的交流架构」，分六步（方案「本轮分六步」），11-25 全部合进 master 并发测试（中转服务 0.7.20、Studio 0.9.85）：事项状态由事件推、回执、待我处理、主控 / 执行 / 任务主控的角色卡、巡检、闸门、AI 之间带来源问答、板由事项算出来、拖卡和改事项的锁；本机留言成了事项里的消息。AI 这边的规格 `plans/collab-agent-spec.md`（真模型改到 v6，再按真 Host 联调改了几处，记在它「v6 之后定的」「11-25 联调」）；成果和怎么测 `plans/collab-round-report.md`。等用户真用后的反馈；已知：gpt 当主控 token 高、常不写来源（建议主控用 Claude），对方主控回执行贴的提交会白叫醒执行一次。后续 AMO 怎么借鉴这套：`plans/amo-collab-next.md`（待确认，末尾三个问题）。顺带谈的审阅进度见下一行 |
| 审阅进度（review-progress） | `plans/review-progress.md`，对话这一块在测试功能「审阅进度」后面。11-16 一天里换成第二版，在 master（`153a3139`），等自动打包发测试版（「下一版」里有条目）：回复右边一条竖线，左键标读到哪一块、右键标「!」有问题，复盘里没读的块带底色，不自动记、没有「审过」按钮；新标的「!」和最后一条回复读到哪随下一条消息告诉 AI。是用户看了两版演示定的（演示页在主工作区 `studio/out/review-progress/read-marks-demo*.html`，不进仓库）。等用户用过再调；没问过用户、先按推荐做的几处列在方案「第二版」里「做的时候自己定」：右键「!」只是记号不弹批注框、各条回复各记各的位置、底色只在复盘里、带给 AI 的那几行、每轮右边留的宽度。11-16 晚用户用过后：去掉复盘，竖线挪到对话区右边缘、从头到尾连成一条（演示里的方案 A），修了悬停时变灰；已提交（`f6ed17f4`，见方案「第二版用过之后」）。测试功能里它的说明还在讲已删掉的「复盘」（`packages/protocol/src/api.ts`），没改。已知问题：远程副本上标的「!」带不到 AI；回复跳转按钮盖住竖线最上面一小段。文档按节记、查看包和 Git 改动的「已看」、批注卡片还没做 |
| Gemini（Antigravity） | 11-24 开工，`plans/agy.md`，worktree `G:\PROJECT\AgentMonitorOverlay-agy`（分支 `studio/agy`）。第 1 段（Host 运行时 `runtime/agy`、设置页、界面分支，测试功能「Gemini（Antigravity）」后面，默认关）、第 2 段（平台环境页装 / 更新 agy）、第 3 段（中转服务的 agy 镜像）都在 master；只用假 agy、假服务器测过。第 4 段（真模型）等用户在浏览器里验证 Google 账号，可能拉协作请别人一起跑 |
| 中转「传文件」 | 11-23 做完（`plans/done/relay-file-transfer.md`）：服务 + 界面随中转服务发、外壳随 AMO 中转桌面程序发（版本见各自 `CHANGELOG.md`）。自动测试是本机的单测和三个客户端的 e2e；两台真电脑之间、经 Mac 上的服务传大文件、真实断网续传都还没试过，等用户用 |
| 远程会话 | 功能都在 master、已发布（`plans/done/remote-session.md`、`plans/done/remote-page-and-new-task.md`；11-06 加了远程任务页的被控端额度）。等用户用两台真电脑验收；会话级授权、模型细到型号、远程权限上限等用户 10-29 定先不做 |
| Android Studio | 工程在 `mobile/`（KMP：`shared` + `app`），调试 APK 在 `mobile/out/`。真实手机和 Tailscale 实网没测（`plans/done/android-studio.md`） |
| iOS Studio | `plans/ios.md`：签名 11-03 通了（jenkins-build 钥匙串），**等 App Store Connect API Key**（打包机 `~/.amo-ios/config` 两个 ID 空着、没有 .p8），之后 validate、问过用户再第一次上传。打包机上 LaunchAgent `com.amo.ios-build` 的残留没卸（等用户点头删 Mac 上的文件） |
| AMO 平台 | 方案 `plans/amo-lan-platform.md`。11-03 的「用完整包更新」还没在用户机器上真点过（11-04 时）。11-06 起清单带更新记录（`history`）；便签、Reviewer、中转要等各自下次发布才有完整历史。展示站统一的更新记录页没做 |
| @ 子会话 | 11-05 合进 master。没验证：真 Claude 开 Fast、真模型会不会照着带 `setup`（`plans/done/subsession-mention-2026-11-05.md`） |
| 等用户点头删的 worktree / 分支 | `G:\PROJECT\AgentMonitorOverlay-devui`（`studio/dev-ui-dir`，已全部合进 master）、`.claude/worktrees/agent-a04ca2f0eeff1a610`（展示页，已合）、`.claude/worktrees/agent-abb445f58543b0e8b`（10-30 的「环境装 Claude Code / Codex」早期版本，多 1 个提交；11-03 master 上另做了一版）。老分支 `codex/chatgpt-binding-name-sync`、`codex/task-launch-entry`、`issue/8` 各多 1 个提交 |
| 以后推进 | 谈过、现在不做的在 `plans/later/`（`README.md` 有清单）：教程第 2、5 章和产品内引导、文件快传、画布工作流、全景和三层架构（`userlayer/`）、agent 协作方向，以及几件用户定了以后再说的小事 |

## 已知问题

- `packages/host/src/runtime/codex/server-manager.test.ts` 以前偶发失败：app-server 启动后在后台 `git fetch` OpenAI 的插件市场，这个 git 继承了监听端口，`taskkill /T` 可能漏掉它。11-03 起这个测试用 `-c features.plugins=false` 启动；自动打包时还是把它排除在外（`release.mjs`），等它稳定一阵再定要不要放回去。同一个 git 也会拿着 Electron 的输出管道，让 e2e 的 `app.close()` 等到超时：11-05 起 e2e 的 `launchStudio` 在每个用例的 `codex-home` 写 `[features] plugins = false`。Studio 实际运行时照旧同步插件，碰到端口被占会换个端口重启。
- `packages/host/src/runtime/dsh/dsh-runtime.integration.test.ts` 的「session_start with write in a folder not set up」在全量 vitest 负载下偶尔超时，单独跑能过（11-05、11-06 都见过），原因没查。
- 端到端里 Claude 的 mock 配置没法向 Claude Code 要型号列表（会超时），所以测试模式给 mock 配了内置列表（`packages/host/src/bin.ts`）。
- Studio 里 agent 的命令 PATH 去掉了 WindowsApps，用不到应用商店版的 `pwsh`、`python3`、`winget`（本机 `python`、`node`、`git` 不受影响）。
