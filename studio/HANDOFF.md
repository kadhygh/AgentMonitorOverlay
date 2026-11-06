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
| 全景（userlayer） | 分支 `studio/panorama`（worktree `G:\PROJECT\AgentMonitorOverlay-panorama`）比 master 多 4 个提交：全景里抽屉打开会话（`plans/userlayer/framework.md` 第 1 步）、内存测量，没合 |
| 远程会话 | 功能都在 master、已发布（`plans/done/remote-session.md`、`plans/done/remote-page-and-new-task.md`；11-06 加了远程任务页的被控端额度）。等用户用两台真电脑验收；会话级授权、模型细到型号、远程权限上限等用户 10-29 定先不做 |
| Android Studio | 工程在 `mobile/`（KMP：`shared` + `app`），调试 APK 在 `mobile/out/`。真实手机和 Tailscale 实网没测（`plans/done/android-studio.md`） |
| iOS Studio | `plans/ios.md`：签名 11-03 通了（jenkins-build 钥匙串），**等 App Store Connect API Key**（打包机 `~/.amo-ios/config` 两个 ID 空着、没有 .p8），之后 validate、问过用户再第一次上传。打包机上 LaunchAgent `com.amo.ios-build` 的残留没卸（等用户点头删 Mac 上的文件） |
| AMO 平台 | 方案 `plans/amo-lan-platform.md`。11-03 的「用完整包更新」还没在用户机器上真点过（11-04 时）。11-06 起清单带更新记录（`history`）；便签、Reviewer、中转要等各自下次发布才有完整历史。展示站统一的更新记录页没做 |
| @ 子会话 | 11-05 合进 master。没验证：真 Claude 开 Fast、真模型会不会照着带 `setup`（`plans/done/subsession-mention-2026-11-05.md`） |
| 等用户点头删的 worktree / 分支 | `G:\PROJECT\AgentMonitorOverlay-devui`（`studio/dev-ui-dir`，已全部合进 master）、`.claude/worktrees/agent-a04ca2f0eeff1a610`（展示页，已合）、`.claude/worktrees/agent-abb445f58543b0e8b`（10-30 的「环境装 Claude Code / Codex」早期版本，多 1 个提交；11-03 master 上另做了一版）。老分支 `codex/chatgpt-binding-name-sync`、`codex/task-launch-entry`、`issue/8` 各多 1 个提交 |
| 以后推进 | 谈过、现在不做的在 `plans/later/`（`README.md` 有清单）：教程第 2、5 章和产品内引导、文件快传、画布工作流，以及几件用户定了以后再说的小事 |

## 已知问题

- `packages/host/src/runtime/codex/server-manager.test.ts` 以前偶发失败：app-server 启动后在后台 `git fetch` OpenAI 的插件市场，这个 git 继承了监听端口，`taskkill /T` 可能漏掉它。11-03 起这个测试用 `-c features.plugins=false` 启动；自动打包时还是把它排除在外（`release.mjs`），等它稳定一阵再定要不要放回去。同一个 git 也会拿着 Electron 的输出管道，让 e2e 的 `app.close()` 等到超时：11-05 起 e2e 的 `launchStudio` 在每个用例的 `codex-home` 写 `[features] plugins = false`。Studio 实际运行时照旧同步插件，碰到端口被占会换个端口重启。
- `packages/host/src/runtime/dsh/dsh-runtime.integration.test.ts` 的「session_start with write in a folder not set up」在全量 vitest 负载下偶尔超时，单独跑能过（11-05、11-06 都见过），原因没查。
- 端到端里 Claude 的 mock 配置没法向 Claude Code 要型号列表（会超时），所以测试模式给 mock 配了内置列表（`packages/host/src/bin.ts`）。
- Studio 里 agent 的命令 PATH 去掉了 WindowsApps，用不到应用商店版的 `pwsh`、`python3`、`winget`（本机 `python`、`node`、`git` 不受影响）。
