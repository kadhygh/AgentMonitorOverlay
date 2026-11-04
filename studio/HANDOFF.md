# 交接：AMO 的当前状态

新会话先读这份。长期有效的规则（工具和包的对应、架构约束、怎么干活）在仓库根目录的 `AGENTS.md`，这里只写现在的状态和最近的改动。做完一段，在「最近的改动」最上面加一条（做了什么、怎么验证的、还剩什么）。

更早的记录原样挪进了 `docs/history/`：10-13 到 10-25 在 `handoff-2026-10.md`，10-26 到 10-31 在 `handoff-2026-10-late.md`；做完的阶段计划在 `plans/done/`，/loop 自动迭代时期的文档（STATUS、NEEDS_YOU、ROADMAP、LOOP_RULES、LOOP_LOG）在 `docs/archive/`。查某个功能当初为什么这么做，先在这几处搜。

## 当前状态

### 在哪、怎么跑

| 项目 | 内容 |
|---|---|
| 开发目录 | `G:\PROJECT\AgentMonitorOverlay\studio`（桌面快捷方式「AMO Source」指这里的 `start-studio.cmd`） |
| 分支 | `master` 是主线；旧版 AMO 在标签 `amo-legacy-final` |
| worktree | 常设两个，都是 master 的 detached worktree：值守目录 `G:\PROJECT\AgentMonitorOverlay-duty`（值守修问题、`release land`）、打包目录 `G:\PROJECT\AgentMonitorOverlay-release`（自动打包跑 `release auto --if-due`）。别的 worktree 是各任务自己的（`git worktree list` 看）。11-04 时 `-claude-code-mirror`、`-issues`、`-package-slim`、`-send-now`、`-review` 五个都已全部合进 master，等用户点头删 |
| 用户在用的 Studio | 平台装的版本（`D:\TOOLS\AMO Platform\apps\studio\<版本>`），不是这个开发目录：在这里改代码、build 都不影响它；提交进 master 且写了「下一版」的会被自动打包发到测试通道，用户自己选装 |
| 开发版 | `npm start`（先 build 再开窗口），数据在 `studio\.data`。Host 常驻在 47900 端口；改了 Host 代码要先 `npm run host:stop` 再 `npm start` |
| 帮用户重启开发版 | **先问用户，而且只在没有会话运行时做**。`npm run build` → `npm run host:stop` → 结束 `electron.exe packages/app` 主进程（命令行不含 `--type=`）→ 备份 `.data\studio.db*` 到 `.data\backup-before-<名字>-<日期>` → 在 PowerShell 里先删掉匹配 `^(CLAUDE|ANTHROPIC_|AMO_STUDIO_|NO_COLOR$|FORCE_COLOR$|COLOR$|TERM$)` 的环境变量（Claude Code 工具 shell 带的，Studio 会传给维护终端）→ `Start-Process node_modules\electron\dist\electron.exe packages/app`（工作目录 `studio`）→ 用 `.data/host-token` 在 node 脚本里查 `GET /api/state` 核对任务和会话数（不打印令牌）。只改界面时让用户按 Ctrl+R 即可 |
| 验证 | `npm run verify`（typecheck + vitest + build）；`npm run e2e`（Playwright project：`studio`、`notes`、`reviewer`、`relay`、`platform`）。都用 BelowNormal 优先级、`--maxWorkers=6` |
| 发布 | 都走 `npm run release`（`status`、`<工具…>` / `auto`、`relay-service`、`promote`；用法在 `scripts/release.mjs` 开头，节奏见 `plans/release.md`）。自动打包每 60 秒跑 `release auto --if-due`，只发「下一版」里有条目的工具 |
| AMO 中转 | 服务在 Mac mini `http://172.16.8.85:47120/`（SSH 别名 `mac`）。部署：`npm run release -- relay-service`（会重启中转几秒，先问用户）；底层命令和服务器上的位置见 `packages/relay/README.md` |

### 规则补充（`AGENTS.md` 之外的细节）

- 不改 `~/.codex/config.toml`、`~/.claude/` 设置、用户已有的凭据条目（Studio 只写用户在 设置 → 模型 加渠道时的 `channel-<id>` / `channel-<id>-access`）。
- 测试只在 `%TEMP%\amo-studio-sandbox\` 和临时目录；端口只用 47900–47999；测试窗口不抢焦点、不开终端/浏览器、不碰剪贴板。
- 不 reset --hard、不删分支。密钥不打印、不写日志/文件/命令行。
- **真实模型额度**（`budget.json`，用 `spikes/lib.mjs` 的 `countTurn(note, provider)` 先计数再调用）：11-04 时 DeepSeek 50/1000、GLM 28/5000、GPT 订阅 6/300、Claude 订阅 0/300、Dxx-DS 0/1000（以文件为准）。平时测试用 mock。
- 工具坑：heredoc 里的 Python 会吃掉 `\n`、`\v` 等转义 → 有转义的改动用 Edit/Write 或 scratchpad 里的 `.py` 文件；Windows 文件名不分大小写（`Transcript.tsx` 和 `transcript.ts` 会撞）；跑完 e2e 用 `git checkout -- studio/screenshots/` 丢掉无意的截图变化；清理 `%TEMP%\amo-studio-test-*`、`amo-studio-e2e-*`。

### 还开着的事

| 事项 | 状态 |
|---|---|
| Android Studio | 工程 11-02 起在 `mobile/`（原 `android/`，为 iOS 改成 KMP：`shared` + `app`，见 `plans/ios.md`），调试 APK 位于 `mobile/out/`；团队服务器真实 Dxx-DS、远程可靠性、标准及 360 dp / 1.3 倍字体 UI 验收通过。范围、证据及未验项见 `plans/android-studio.md`；真实手机和 Tailscale 实网待验 |
| iOS Studio | `plans/ios.md`：KMP 跟 Android 共用，TestFlight 内部测试，发布走 `npm run release -- ios`（已接上，还没整条跑过）。App 记录 `com.gorilla.amo`，描述文件 `AMOStudio_AppStore` 已装在打包机上。第 0–2c 步做完；2d：iOS 版在打包机的模拟器里能启动（只看了登录页）。**签名 11-03 通了**：用户定只解锁 Jenkins 的 jenkins-build 钥匙串（读 Jenkins 自己的密码文件，只解锁不锁回），普通 SSH 下打出的 ipa 核对过。**等 API Key**（打包机 `~/.amo-ios/config` 两个 ID 空着、没有 .p8），之后 validate、问过用户再第一次上传。打包机上 LaunchAgent `com.amo.ios-build` 的残留还没卸（代码已删，等用户点头删 Mac 上的文件） |
| AMO 平台 | 方案 `plans/amo-lan-platform.md`。在团队服务器上发布、自更新、环境页装 Claude Code / Codex 都在用；11-04 两个通道都是 0.9.21（各工具版本用 `npm run release -- status` 看）。11-03 的「用完整包更新」还没在用户机器上真点过 |
| 远程会话（在我另一台设备上接着用本机会话） | 第 1–4 步和收尾 10-29 做完（`plans/remote-session.md`）；10-29 晚改成弹窗、加「安全」、B 能带图片和文件给 A（`plans/remote-page-and-new-task.md` 第 7、8 节，Studio 0.9.10）。等用户用两台真电脑验收；会话级授权、模型细到型号、HTML 的 CSS / JS、正文路径去用户名、远程权限上限，用户 10-29 定先不做 |
| 会话里直接用中转（回复自动回到会话） | 10-30 第一版做完（`plans/relay-in-sessions.md`，用户定的 5 条在里面），同天加了「不用确认直接发」的设置和远程默认关闭。已发布在用。终端里的会话、普通聊天、超时提醒以后再说 |
| 便签进 Portable 包 | 到发布时再做 |
| 位置批注的截图 | 用户 10-28 决定先不做，用一段时间再定 |
| Studio 托盘 | 用户 10-29 定：× 只关窗口，托盘右键「完全退出」连 Host 一起关（有会话在跑先确认）；平台的 Studio 卡片显示后台状态、给「重启 Studio」（没有会话在跑才能点）。画布调整合并后做，见 `plans/remote-session.md`「前置」 |
| 提示词模板 / 删扩展包 | 10-31 合进 master，已发布（记录在 `docs/history/handoff-2026-10-late.md`）。以后可能做类似 DSH 的插件架构，到时另起方案 |
| 11-03 项目梳理 | 结论和推进顺序在 `plans/cleanup-2026-11.md`（第 0–8 步）。11-04 起按它推进，做到哪一步写在那份方案里 |

### 已知问题

- `packages/host/src/runtime/codex/server-manager.test.ts` 以前偶发失败，原因不是端口释放慢：app-server 启动后会在后台 `git fetch` OpenAI 的插件市场，这个 git 继承了监听端口；如果它恰好在杀进程的那一刻启动，`taskkill /T` 就漏掉它，端口一直被占到 GitHub 返回为止。11-03 起这个测试用 `-c features.plugins=false` 启动 app-server（单独连跑 8 次、全量都通过）。Studio 实际运行的 app-server 照旧会同步插件；碰到这种情况会换个端口重启，功能上没问题。自动打包时这个测试还是被排除在外（`release.mjs`），要不要放回去，等它稳定一阵再定。
- 端到端里 Claude 的 mock 配置没法向 Claude Code 要型号列表（会超时），所以测试模式给 mock 配了内置列表（`packages/host/src/bin.ts`）。
- Studio 里 agent 的命令 PATH 去掉了 WindowsApps，用不到应用商店版的 `pwsh`、`python3`、`winget`（本机 `python`、`node`、`git` 不受影响）。

## 最近的改动（新的在上面）

**2026-11-04 晚 · 梳理第 7 步合并、平台关闭变快、详细档展开思考（master）**
- 第 7 步 ui 数据流和共用件前两批合进 master（`36cc5a49`）：`host/live.ts` 的 `useLiveResource`、`host/shared.ts`、`settings/useSettings.ts`、`lib/Modal`（19 个对话框）、`lib/ContextMenu`（8 个菜单）、`styles/controls.css`。细节和用户定的（base.css 不合、`formatBytes` 统一成一位小数到 GB 留到下一轮）在 `plans/cleanup-2026-11.md` 第 7 步。合并时全部 e2e 跑过：224 条过；`cli.spec` 的 Codex 压缩、`turn-start` 的「Focus 看过就消失」两条在合并前的 master 上就不过，还没查。
- 平台的「关闭」「正在运行」先看工具自己记的进程号（`shell.json` / `running.json` 带 exe）和平台启动过的（`%APPDATA%\AMO\launched.json`），都不知道才扫全部进程（`cbd13ca6`，`platform/src/running.ts`）；各步耗时记在 `%APPDATA%\AMO\platform.log`。工具要从下一版起才写这些文件，装好后让用户试关闭、重启 Studio，慢就看 platform.log。
- 「详细」「完全展开」里思考默认展开，思考灰色斜体、命令青绿色（`e75407da`）：用户插话后模型把回话写进了思考（Claude 自己的记录里也是 thinking 块）。

**2026-11-04 · 消息投递统一（分支 `studio/message-delivery`，11-04 晚合进 master `6a231509`）**：11 月梳理第 3 步，方案和进度在 `plans/message-delivery.md`。
- 会话收件箱 `features/sessions/inbox.ts`：中转回复和说明、值守接着做、传话、邮件转发、session_send、session_start 的回报不再像人发的那样插进正在跑的一轮，而是先显示成 `delivery: "held"`（「等这一轮结束后送进去」），会话空下来再用 runtime 的 `resend` 送进去；kv `sessions.inbox` 落盘，重启接着送，旧的 `sessions.peer-queue` 启动时搬进来；送不进去变「没送到」加一行原因。人发的（界面、远程 B、画布回答、批注）照旧。
- DSH 补上 waiting / 立即发送 / Ctrl+Enter / 重新发送；出错、进程退出、归档、Host 重启时排队的变「没送到」；停止后排队的接着发（同 11-02 对 Claude / Codex 的决定）。
- `RuntimeBase`：`writable`（中文、`profileGone`）、`archiveTree`、`settleLeftovers`、`armStopGrace`（DSH 关进程、Codex 本地记成已停止）；protocol `TURN_STATUSES` / `inTurn`。
- 用户定的五条（方案「用户定的」）：人点了停止的会话，收件箱先不送，等人下一条消息一起送（`SessionInbox.pause / resume`）；`awaiting-review` 不再算「忙」，`BUSY_STATUSES` 删了。
- 验证和没验证的见方案文件末尾；最该在真环境里看的：真 DSH 收到 session/cancel 后多快停、真 Codex 卡住时的停止兜底、Claude 重启后被中断的那一轮怎么显示。新代码要等 Host 下次重启才生效（由人点）。

**2026-11-04 · 项目梳理第一轮（master + 两个 worktree）**：11-03 只读审查的结论和推进顺序在 `plans/cleanup-2026-11.md`，用户 11-04 定「都照做，按流程推进一轮」。
- 已提交进 master：第 1 步文档对齐（`63413744`：本文件「当前状态」、AGENTS.md、发布命令统一成 `npm run release`，10-26～10-31 挪进 `docs/history/handoff-2026-10-late.md`）；第 2 步发布脚本漏判（`dbc97045`：中转服务的范围补 locate / account / base.css，外壳 zip 的触发补包，`package-lock` 跟着升版本）；第 5 步清死代码中不碰 runtime 的部分（`ff7d4a2f`）；第 4 步中转给 AI 用的身份不再存明文 key（`0d56e627`，中转外壳「下一版」有一条，会随自动打包发测试通道）；第 6 步中转服务的孤儿截图清理和异步写盘（`6280aeb4`，**没部署**，等用户说再 `release -- relay-service`）；第 8 步只写了方案 `plans/host-structure.md`。
- 第 3 步、第 7 步在各自的 worktree 里做完，11-04 晚合进 master（见上面两条）。worktree `.claude/worktrees/cleanup-delivery`、`cleanup-ui` 合并后没用了，删之前问用户。
- 已合并的 worktree、`release/` 旧包、`studio/Microsoft/` 用户 11-04 已删。还等用户：中转服务部署（`6280aeb4`）；没有会话在跑时重启 Host，第 3、7 步才生效。
- 下一步：第 6 步 Host 那一半（purge 清按会话的 kv 键、DSH 日志轮转、kv 键登记）；第 8 步下一轮新开 worktree。
- 审查里核对后不成立、没改的：`ClaudeLogin = "token"`（API Key 渠道在用）、`relay-service.ps1`（README 写明的退路）、平台装的中转客户端早已只认平台登录。

**2026-11-04 · MCP 设置（master）**：同事反馈 Figma MCP 在 Studio 的 Claude 会话里用不了。原因是本机登录时固定传了 `strictMcpConfig`（10-14，4cef30ce），只挡了 MCP，skills、CLAUDE.md 等一直照常加载。用户定的做法和细节见 `plans/mcp.md`：全局在设置 → 「MCP」；项目在「编辑项目」；会话在输入框下的「MCP」按钮，新会话沿用同一任务上一个会话的选择；AI 用 `mcp_server_save` 加 MCP，每次都要人批准；Codex 在下次启动时生效；`amo-relay` 默认不启用。
- Host：`features/mcp/`（`local.ts` 只读 `~/.claude.json` 和 `.mcp.json`，带 Claude Code 自己的批准状态；`service.ts` 负责三级合并和各运行时的启动参数 `launch`，Studio 加的 MCP 的密钥存在凭据管理器 `mcp-<id>` 里）；`runtime/mcp-launch.ts`。Claude 在人自己的配置目录里运行时不加 strict，让 CLI 自己加载本机 MCP（OAuth、插件、批准都照它原来的办法），关掉的用 `managedSettings.deniedMcpServers` 挡掉（只作用于这个进程，不写文件；不用 `toggleMcpServer`，它会写 `~/.claude.json`），`.mcp.json` 里打开的用 flag 级 `settings.enabledMcpjsonServers` 批准；其他情况仍加 strict，由 Studio 显式传进去。运行中改：Studio 加的用 `setMcpServers`。实测启动时传入的 MCP 用它去不掉（CLI 2.1.304），所以这类改动和本机 MCP 的改动一样，等进程空闲后关掉，下一条消息再 resume。DSH 的做法和改权限一样（`release`，下一条消息 resume）。Codex 用 `-c mcp_servers.*`，密钥通过 `env_vars`、`env_http_headers` 走环境变量，并加进 `shell_environment_policy.exclude`。`store/rows.ts` 的 `parseOptions` 现在会保留 `options.mcp`。e2e 和 `bin.ts` 测试模式改读 `AMO_STUDIO_TEST_CLAUDE_CONFIG`（默认是数据目录里的 `test-claude.json`），不碰真的 `~/.claude.json`。
- 验证：单测 `features/mcp/mcp.test.ts`（读配置、三级合并、密钥遮盖、Codex 参数）；集成测试 `runtime/claude/mcp.integration.test.ts`，用真实 SDK 和 CLI 加一个测试用的 stdio MCP 跑：运行中加、删动态加的，amo 一直可用；启动时传入的 MCP 要等重启；deny 生效；重启后接着同一段对话。DSH 集成测试新加一条（假 agent 的 `[[mcp-list]]`）。e2e `mcp-settings.spec.ts`，截图 `screenshots/studio/mcp-*.png`。全量 vitest 只有 AMO 工具数量的断言要改，已经改了。
- **没验证**：真实的 Figma（OAuth 型 MCP）在 Studio 会话里能不能用上授权（Studio 弹不出授权流程，要先在终端用 `/mcp` 授权一次；本机登录和终端共用 `~/.claude`，应该能用）；真 DSH 碰到连不上的 MCP 会怎样；Codex 真实 app-server 带上 `-c mcp_servers.*`（只对过参数，还没真的启动一次）。

**2026-11-03 · 平台：用完整包更新、续传、删得掉旧版本、连接快了（master）**：用户的平台自更新先后卡在 EPERM 和「下载 0ab1410c676d 中途断了（terminated）」（0.9.20 修了后者：Response 在下载中途被回收，见 62cf5127），用户要平台里有个不靠平时下载代码的出路。
- **完整包**：中转服务新增 `/platform/zip/<工具>/<版本>`（`relay/src/platform-zip.ts`）。它按清单拿对象现拼 zip，不另存：.gz 对象的 deflate 流直接当 zip 的 method 8，CRC 和大小取自 gzip 尾；不压缩的对象用 store，CRC 读一次后缓存。布局先算好，所以知道长度，支持 Range 和 If-Range；不用 zip64，超过 4 GB 就拒绝。下载页的平台压缩包改成用这个，给最新发布的平台（用户：每次发版下载页跟着更新）；以前那份手动放的是 10-29 的旧包。
- 平台「设置 → 平台更新」里加了「用完整包更新」（`platform.updateSelfFull`、`package-install.ts`、`client.downloadPackage`）。压缩包用 Electron 的 `session.fetch` 下（单独的 session，代理设成 direct），断了接着下，再点一次也接着下。下完用 System32 的 `tar.exe` 解压，再走 installer 的 `fresh`：逐个文件按清单核对，不硬链接别的工具的文件。之后照常点「重启平台」。
- **删除**：实测（`remove.ts` 开头的表）在平台的 Electron 44 里，`rmSync` 删不掉正在运行的程序的硬链接（EPERM），`unlinkSync` 删得掉，连正在运行的 exe 本身也删得掉；普通 Node 正好相反。所以旧版本一直删不掉。现在逐个文件 unlink，先挪进 `apps\.trash`，名字立刻空出来，删不掉的下次启动再删。因为 unlink 连运行中的程序也会删，prune 前先查有没有程序从这个版本文件夹运行（`runningPaths`），查不到就一律不删。
- **续传**：下好、核对过的文件硬链接进 `apps\.objects\<sha256>`，装好后删，一周没人再试也删。再装时先拿这里的。
- **连接慢**：`runningExePaths` 的 `Get-Process … .Path` 在这台机器上要 10.9 s，换成 `Get-CimInstance Win32_Process`，0.97 s，结果一样（107 条逐行比过）。登录到「服务器在线」从 10.6 s 降到 1.8 s。平台 e2e 自 10-30 起大多过不了，就是卡在这里：「正在连接」超过 5 s。
- **验证**：平台 + 中转单测 154 个全过。新测试有：zip 用自己的解析器读一遍、再用 Windows tar 解开（含中文文件名）、Range 续传、下载页、缺对象时报 409；完整包下载断两次后接着下完；`.objects` 续传；运行中的版本不删；`fresh`。平台 e2e 11 个全过，以前失败的几个也过了。新增「用完整包更新」：走 Electron session.fetch，断一次后接着下。截图 `screenshots/platform/P44`、`P45`。另外用平台的 Electron 跑了 `removeTree`、`discard`：能删掉运行中程序的硬链接，运行中的 exe 没被碰。
- **没验证**：真服务器上的大 zip（等 relay-service 部署后用 curl 加 tar 试 Studio 那份）；用户机器上真点一次「用完整包更新」。
- **Claude 提示 317、装上的是 316**（用户另报，从「团队服务器」那一行点的）：官方 latest 是 2.1.317（stable 是 2.1.311），所以不是分批推送。按平台的步骤重做了一遍：`versions\2.1.317 install 2.1.317` 输出「successfully installed! Version: 2.1.317」，但 `~\.local\bin\claude.exe` 还是 316。原因是 Studio 的 Claude 会话（`AMO Studio.exe` 0.9.26 的子进程）正在运行这个 launcher，Windows 不让覆盖。修法：`installClaude` 第 5 步，launcher 和清单对不上时，把它改名成 `claude.exe.amo-old-<t>`（运行中的 exe 可以改名），再复制新版过去。挪开的旧文件只在没有程序从 launcher 运行时才删：改名后进程列表里还是显示原来的名字，分不出新旧。在用户机器上用新代码重做一遍，launcher 变成了 2.1.317，旧的留在一旁。单测 `claude-install.test.ts` 加了一条。

**2026-11-03 · 程序包瘦身（分支 `studio/package-slim`；11-04 注：已合进 master，随 Studio 0.9.29 发布）**：`plans/package-slim.md`。用户定的范围只做低风险的：`scripts/package-portable.mjs` 里工作区包只放一份（按路径用的在 `packages/`，只按包名用的在 `node_modules/@amo-studio/`，host、reviewer 两样都要，`node_modules` 里只放转发文件）；不带 `.d.ts`、`.map`，第三方包不带 README/CHANGELOG/`*.md`、测试、示例、配置；许可证照留。`@anthropic-ai/sdk`、codex 的空模块、`.ts` 源码、字体、打成一个文件这次不做。rebase 后：Studio 11230 → 4396 个文件，Reviewer 11144 → 4344，中转 3871 → 1808，便签 3436 → 1114，平台 414 → 355。新的 `scripts/check-package.mjs` 每次打包后自动跑：写死的 import 都要找得到文件，瘦身前就缺的记在 `check-package.allow.json`。e2e 加了 `AMO_E2E_APP=<打好的文件夹>`，用打好的 exe 跑。验证：import 检查五个工具都过；e2e 前后对比，`studio` 瘦身前 188/9、瘦身后 189/8（失败的是同一批，都是打好的包和开发版本来就不同的地方，见方案「结果」），`notes` + `reviewer` 前后都 9/1，`platform` 前后 2/6、`relay` 前后 2/5（平台模式的包在这两个 project 上本来就大多过不了，只能看出能启动、能连服务器）；便携包冒烟都过；rebase 后 import 检查和冒烟又跑了一遍，都过（e2e 没重跑）。**rebase 后 import 检查抓到 master 自己的问题**：`@amo-studio/relay` 从工具镜像起要 `@amo-studio/locate/download`，中转的包列表（`amo-tools.mjs`）没有 locate，从 master 打的下一个中转客户端会一启动就报 `ERR_MODULE_NOT_FOUND`；分支上已经补上（单独一个提交）。用户试过瘦身版的 Reviewer，正常。**还剩**：用户说了再合并；合并后五个工具的 CHANGELOG「下一版」都有这一条，`release auto` 会都发。

**2026-11-03 · DeepSeek 可以用 DSH 桌面版的账号；去掉 DeepSeek（Codex）（master；11-04 注：随 Studio 0.9.30 发布）**：用户提的：没装过旧 AMO 的电脑设不了 DeepSeek 的 Key，而 DSH 桌面版登录后不用 Key 就能用。设置 → 模型 → DeepSeek 加了「登录方式」：`DSH 桌面版的账号` / `API Key`（kv `settings:dsh-auth`；没选过时有 Key 用 Key，没有用账号）。账号方式的做法（`dsh/install.ts` 开头的注释）：Studio 的 DSH 仍用自己的 `DSH_HOME`（会话不混进桌面版），每个进程多一个 `--patch`，把 DSH 凭据插件 `credentials` 的 `path` 指到桌面版的 `~/.dsh/.credentials.yaml`（有 `DSH_HOME` 时用它），ACP 默认走 `deepseek-account/deepseek-flash`；不传 `DEEPSEEK_API_KEY`。登录判断只看那个文件里有没有 `deepseek-account-platform/default:` 这条记录，不读 token。两种方式的型号分开缓存（`dsh:config-options` / `…:account`），账号方式只列 `deepseek-account/*`，Key 方式不列它们；换了方式后旧会话选的另一边的型号不再下发，用默认。第三方 DeepSeek 渠道不变。`deepseek-v4` 进了 `WRITABLE_CREDENTIALS`，Key 在 DSH 那一段里直接填、删。另外按用户说的去掉了内置的 `codex-deepseek-flash`（`CODEX_PROVIDERS` 清空，删了 `assets/codex/deepseek-flash.models.json`）：用过它的旧会话还能看，发消息时说「模型渠道已经没有了」；常用预设读出时去掉渠道已不在的。验证：先用本机桌面版手动跑通——新的空 home + patch 后 DSH 列出 `deepseek-account/deepseek-flash`、`deepseek-account/deepseek-v4-pro`，选账号 Flash 发一句回了 OK；单测 `dsh.test.ts`、集成 `dsh-runtime.integration.test.ts`（没 Key 走账号：无 Key、凭据文件、只列账号型号、换型号、退出登录后报错；填 Key：保存后传给 DSH）、`profiles.test.ts` 改成测试自己的路由渠道；e2e `dsh.spec.ts` 新增「登录方式」，截图 `screenshots/studio/dsh-auth-*.png`；全量 vitest 只有 `server-manager.test.ts` 的 afterAll 超时（端口和正在用的 Studio 冲突，跟这次无关）。**没验证**：Studio 里真实的账号会话（没重启用户的 Studio；重启后在设置里选「DSH 桌面版的账号」，开一个 DeepSeek 会话试一句）；账号 token 过期、DSH 自己刷新写回桌面版文件的情况。

**2026-11-03 · Claude 多账号（master；11-04 注：随 Studio 0.9.30 发布）**：用户定的：做到方案 C（会话能换账号接着聊），登录在设置界面做，额度按账号分开显示，当前账号单独显示，其他账号收在一起，可以折叠，上面直接有「切换」，会话进行中不能切换。Claude Code 本身没有账号切换器，官方的多账号做法就是一个账号一个 `CLAUDE_CONFIG_DIR`。`runtime/claude/accounts.ts`：默认账号就是 `~/.claude`；添加的账号放在 `~/.claude-accounts/<id>`，用目录联接（junction，不用管理员）链到默认目录的 `projects`（对话记录和记忆）、skills、plugins、agents、commands 等，CLAUDE.md、settings.json 在每次启动前从默认目录复制过去。登录是在后台跑 `claude auth login`：实测没有终端时它会打印登录页地址，并从 stdin 读粘贴的代码，界面上两样都给了。邮箱和套餐来自 `claude auth status --json`。`ClaudeRuntime` 的 `homeOf`/`newHome` 改用当前账号；切换前 `switchBlocked()` 检查有没有在跑的回合、待批准、待回答的问题、后台命令，没有就关掉空闲进程，下一条消息在新账号下 resume。额度按账号查（各读各的 `.credentials.json`）；不用的账号 token 过期时，先跑一次 `auth status` 让 Claude Code 续期。rate limit 窗口按「渠道 + 账号」记。接口 `/api/claude-accounts*`，`settings.claudeAccounts`，`AccountUsage.account`。验证：`accounts.test.ts`（链接、删目录不伤默认目录、守卫）；Claude 集成测试加了第二个账号：会话进行中切换被拒，结束后切换，同一会话发出的 Authorization 是第二个账号的 token，而且带着之前的对话；e2e `settings.spec.ts`「Claude 多账号」，截图 `screenshots/settings/claude-accounts*.png`。全量 vitest 只有 `server-manager.test.ts`（端口断言）和一次值守超时失败，单独重跑值守能过，和这次无关。**没验证**：真实的第二个账号登录（本机只有一个账号，等有多账号的人测）；浏览器回调和粘贴代码这两条登录路径；不用的账号 token 过期后，`auth status` 能不能真的把它续上。

**2026-11-03 · iOS 签名改用 jenkins-build，SSH 下打出 ipa**（用户：wunaiyu 在 SSH 下试过，允许走「只解锁 jenkins-build」）：`build-on-mac.sh` 第 2、5 步照 Jenkins 的 `~/.jenkins/bin/xcodebuild`，读 `~/.jenkins/secrets/build-keychain-password` 解锁 `jenkins-build.keychain-db`，`codesign --keychain` 指定它签；钥匙串内容、搜索列表、访问权限都不动，只解锁不锁回（Jenkins 也不锁回）。SSH 下能签了，LaunchAgent 那套删掉：`submit-build.sh`、`agent/`（runner、plist、`setup-keychain.sh`）、`ios-release.mjs --install-agent`，`plan().build` 改成 `nice -n 10 bash build-on-mac.sh …`。验证：打包机上普通 SSH 跑 HEAD 的 `studio/mobile` + 新脚本 `0.1.0 1 --no-upload`，8 步全过、退出码 0；ipa 的 `codesign --verify --deep --strict` 通过，Team `D39JR23NC7`、Bundle `com.gorilla.amo`、描述文件 `AMOStudio_AppStore`、get-task-allow false、beta-reports-active true；`ios-release` 单测 6 条过。没做：validate 和上传（没有 API Key）；打包机上 LaunchAgent 的残留（plist、`~/amo-ios-build/agent`、`queue`、`jobs`）删除被自动审批拦下，等用户点头。

**2026-11-03 · Codex 镜像 + 环境页「团队服务器 / 官方」两块（分支 `studio/claude-code-mirror`，已合进 master，中转服务 0.7.9 已部署；11-04 注：平台 0.9.20 起带着）**：用户定的在 `plans/claude-code-mirror.md`「Codex」一节。中转 `mirror.ts` 改成按工具（`ToolMirror` + `CLAUDE_CODE_SOURCE` / `CODEX_SOURCE`）：Codex 每小时查 npm 的 `latest`，下平台包 `codex-<版本>-win32-x64.tgz`（180 MB，原样），按 npm 的 sha512 核对；管理页每个工具一张卡片、各自的设置；接口按工具（`/api/platform/mirror/<工具>`，管理接口 body 带 `tool`）。平台：共用的 `tool-mirror.ts`；`codex-install.ts` 下 .tgz（服务器或 npm，续传）→ 核对 sha512 → `npm cache add` → `npm install -g @openai/codex@<版本>`（npm 从缓存拿大包）。环境页 Claude Code 和 Codex 都改成两行：「团队服务器」（有备好的版本时）和「官方」，各自的版本和按钮，人来选；从服务器没下成不再自动换官方，提示点官方那行（同一个 `.part` 接着续）。没有 npm 时按钮灰着、给 Node.js 下载页；OpenAI 独立安装版的 Codex 写明平台不更新它。验证：单测 184 条全过、类型检查通过；本机服务真实下好两个镜像，从它把真的 Codex 0.166.0 装进临时 npm 前缀（npm 日志里大包 `cache hit`，`codex --version` 对）；平台 e2e「环境」三条通过，新截图 P41–P43；管理页两张卡片浅色、深色看过。11-03 合进 master（先 rebase 到 0.9.16 之后，类型检查、单测 188 条、环境 e2e 三条重跑通过），部署中转服务 0.7.9：Mac 上启动 30 秒后两个镜像开始下，Claude Code 2.1.317（122,895,826 字节）和 Codex 0.166.0（180,706,795 字节）约 1–1.5 分钟下好并核对通过（`data/mirror/`，日志 `~/Library/Logs/AMO Relay/serve.log`）。还要做：平台下一版发到测试通道后，用户从平台真实装一次。

**2026-11-03 · Claude Code 镜像 + 平台一键安装（分支 `studio/claude-code-mirror`，已合进 master，见上一条）**：方案、调查和用户定的 7 条在 `plans/claude-code-mirror.md`。中转服务 `src/mirror.ts`：每小时查官方 `latest`，后台下 `.zst`（122 MB，不是 335 MB 的 exe），Range 续传、卡住断开、重试，解压后按官方清单核对 sha256 和大小才算备好，留最新 3 版，默认只要 win32-x64；管理页加「Claude Code 镜像」卡片；登录的人拿 `/api/platform/mirror/claude-code` 和带 Range 的 zst。只有带平台目录的服务默认开。平台 `claude-install.ts`：「环境」页没装时「安装」、官方方式装的有新版时「更新」，先从团队服务器下，没有再从官方下，都能续传；清单优先直接问官方；放进 `%USERPROFILE%\.local\share\claude\versions\<版本>` 再 `install <版本>`（实测这样 7 秒、不再下载）；真实进度走 `PlatformView.envTask`。续传和 zst 校验是共用的 `@amo-studio/locate/download`。验证：单测 relay / platform / locate / testkit 共 177 条全过；本机打包后的服务从官方真实下了 2.1.316 并校验通过，平台从它装进临时用户目录共 10.1 秒；平台 e2e「环境」两条通过，截图 `screenshots/platform/P38–P40`；管理页卡片浅色、深色截图看过。整组平台 e2e 另有 6 条登录后「正在连接」超过 5 秒失败，master 上同一条也失败，和这次无关。（Codex 和「两块」见上一条。）

**2026-11-03 · 问题页的维护者和审核（master，中转服务 0.7.9 已部署）**：用户定的规则写在 `plans/issues.md`「问题页（服务器）」最后一条。账号多了 `members.maintainer`（管理页「设为维护者」，`POST /api/admin/maintainer`），问题多了状态 `review`（待审核）、`rejected`（打回）和 `approved_by`（旧问题迁移时记成作者）。问题服务的每个调用都带上提问的人（`IssueViewer`），由服务端拦，页面只是不显示不能按的按钮；`GET /api/issues` 返回 `me`。Host 的 `issue_reply` / `issue_update` 拒绝这两种状态，默认列表本来就不含它们。验证：relay 单测（含新的审核流程、截图权限、管理接口）和 Host 的 issues / duty 单测都通过；e2e `issues-page.spec.ts` 两条通过（新加一条两个账号走完 待审核 → 打回 → 补充 → 确认制作），截图 `screenshots/relay/I9`～`I11`。**部署后要先在管理页把用户自己设成维护者**，否则值守读不到别人的问题、代 AI 回复会被拒。

**2026-11-02 · 立即发送（分支 `studio/send-now`；11-04 注：已合进 master，随 Studio 0.9.27 发布）**：方案、调查和用户定的 4 条在 `plans/send-now.md`。用户消息加 `delivery: "waiting" | "unsent"`；`messages` 路由加 `now`，新增 `items/:itemId/send-now`、`items/:itemId/resend`，远程 `rt.send` 带 `now`、新增 `rt.sendNow`、`rt.resend`。Claude：每条消息带 uuid，按 `command_lifecycle` 清「等待送达」，立即发送用 CLI 内部的 `interrupt` + `send_now`（init 报 `interrupt_send_now_v1` 才用，否则普通打断），Ctrl+Enter 用 `priority: "now"`；进程结束时还在等的标「没送到」（以前 15 秒兜底会悄悄丢掉）。Codex：插话带 `clientUserMessageId`，马上显示；一轮结束还没读到的由 `afterTurn` 作为下一轮发出（以前打断就丢了）；立即发送 = `turn/interrupt`。假 app-server 加了 `[[busy: ms]]`（命令跑着时插话先压着）。验证：Claude 集成测试 4 条、Codex 单测 5 条、takeBack 单测；e2e `claude.spec.ts` 点「立即发送」和 Ctrl+Enter，截图 `screenshots/send-now/`；完整 vitest 只有已知的 `server-manager.test.ts` 失败。没验证的：真 Claude / Codex 只用假模型和本机实验脚本试过；两台电脑的远程没端到端跑。

**2026-11-02 · 远程任务的 Reviewer（分支 `studio/remote-reviewer`；11-04 注：已合进 master，随 Studio 0.9.27 发布）**：方案和用户定的都在 `plans/remote-reviewer.md`（A 跑任务，B 控制）。一共 4 步：
1. B 的查看包、Review 窗口经自己的 Host `/api/remote/view/<task>/…` 走新的 `rt.view` 从 A 读，存在 `remote-views/<task>/`，A 离线时显示旧的并写明。A 上的检查在 `host/src/features/remote/views.ts`：只给这个任务的 pack、任务项目的 git（只读），文件只给 pack 点名的和改动里的，先解析链接和 junction，有大小上限，路径写「任务文件夹/…」。审阅后补了一处（`pointedAt`）：单个文件的 diff 也只给同一范围改动列表里的或 pack 点名的文件，`untracked` 由 A 按列表定；提交的 diff 只给这个提交改了的文件；历史最多 `GIT_LOG_MAX` 条。之前带 `untracked=1` 能整个读走被 gitignore 的文件。
2. A 记住这一轮是谁发起的（`grants.ts` `turnOf`），用 `open` 只推给发起的 B；A 勾了「我也关心」（`ALSO_MINE_KEY`，和 Focus 的同一个勾）时 B 的轮次 A 也弹，B 没有勾，A 的轮次不推给 B。原来单独的「我也关注」用户当天晚上让并进了「我也关心」。
3. B 的批注由 B 自己的 Host 回（`remote/comments.ts`，存在 kv 里，归档副本时删掉），「复制注释」的路径写「任务文件夹/…」，「发到对话」走 `rt.send`。
4. e2e 在 `e2e/studio/remote-reviewer.spec.ts`。

中转服务没改（它转发任何合规的 kind）。验证：`npm run verify` 过（完整跑时 server-manager 偶发失败，是已知问题，单独跑通过）；e2e `remote-reviewer`、`remote-files`、各个 `remote*`、`view-packs`、`review-open`、`review`、`gitreview`、`chat-files`、`task-head` 共 29 条都过，reviewer 项目 1 条也过；并进「我也关心」之后重跑了单测全部和 `remote-reviewer`、`remote-files`、`remote-tasks`、`view-packs`、`review-open` 12 条 e2e。截图在 `screenshots/studio/remote-reviewer-*.png`。还剩：没在两台真电脑上走过；A 离线时界面上的「旧内容」提示只有单测，没有 e2e。

**2026-11-02 晚 · iOS 第 2d 步和发布脚本（签名没定）**：`mobile/shared` 加 iOS 目标和 iosMain（钥匙串里的 EC 密钥加密账号、NSUserDefaults、Ktor Darwin、WKWebView、Skia 解码图片），`mobile/iosApp` 手写 Xcode 工程和图标；共用代码清掉 `String.format`、`Math`，`JSONObject.NULL` 在 iOS 头文件里改名。发布：`scripts/ios-release.mjs`（git archive 送代码到打包机、跑、拷回日志；`--install-agent`）、`mobile/iosApp/build-on-mac.sh`（8 步，每步一份日志，退出码 10+N）、`submit-build.sh` + LaunchAgent，`release.mjs` 认 `ios`（测试是「移动端测试」；`due` 不再先读没有 tag 的工具的 CHANGELOG）。打包机：JDK、iOS 模拟器运行时、LaunchAgent（都是用户同意的）。验证：打包机上 Kotlin/Swift 编译链接都过，模拟器里启动、登录页截图正常；Windows 上 Android 编译、lint、共用测试 14 条、`ios-release` 单测 6 条都过。没做：签名（见上一行）、validate 和上传、登录后的 iOS 页面、改共用代码后的 Android 模拟器 `test.ps1`。

**2026-11-02 · 移动端界面和文件查看进 commonMain（iOS 第 2b–2c 步）**：`AmoTheme`、`AmoControls`、`Icons`、`Markdown`、`ChatUi`、`StudioUi`、`FileUi` 和字体进 `mobile/shared/src/commonMain`。字体改用 Compose 资源，`BackHandler` 用 CMP 的，草稿走 `Platform.drafts`（发送前同步写盘照旧，已有草稿不丢），HTML 预览和图片解码是 `expect/actual`（Android 那份就是原来的 WebView / BitmapFactory 代码），`Uri.decode` 换成照 Android 规则写的 `percentDecode()`。iOS 上设置页的「更新」换成只显示版本。细节见 `plans/ios.md`。验证：共用单测 14 条（新加 `SharedUiTest` 4 条），Android 编译、lint 都过，模拟器 `test.ps1` 6 条一次过，截图看过对话、设置、HTML 和 Markdown 查看。

**2026-11-02 · 移动端数据层进 commonMain（iOS 第 2a 步）**：`StudioRepository`、`HistoryCache`、`Models` 进 `mobile/shared/src/commonMain`；org.json → 同名的 `Json.kt`（照 Android 的规则），OkHttp → Ktor 3.5.2，java.io → okio，java.time → kotlinx-datetime；手机相关的放在 `Platform` 后面（Android：`AndroidPlatform.kt`，Keystore 和 OkHttp 设置照旧）。踩到的坑：Ktor 的 WebSocket 要用 ws://，用 http:// 会变成普通 GET，服务器回 404。验证：`JsonTest` 10 条，Android 编译、lint 都过，模拟器 `test.ps1` 共 6 条过。被挤掉（4001）和登录失效（401）这两条路没有测试。

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
