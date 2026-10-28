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
| AMO 平台 | 方案 `plans/amo-lan-platform.md`，界面原型 https://claude.ai/artifact/Uu4fL3bXZg1NZHXDSKBPc9 。整理已做完；第一版（第 1、2 步）10-28 晚合进 master，见下面那条。下一步：部署到 Mac 并第一次真实发布（先问用户），然后第 3 步 |
| 远程会话（在我另一台设备上接着用本机会话） | 10-28 只讨论了方案，`plans/remote-session.md`，未开工；开工前要用户定配对方式、B 上卡片放哪、开放多久 |
| 便签进 Portable 包 | 到发布时再做 |
| 位置批注的截图 | 用户 10-28 决定先不做，用一段时间再定 |
| 扩展包 `.amo/packs/` 的实际用法 | 用户暂缓，做到时再说（`plans/maintenance.md`） |

### 已知问题

- `packages/host/src/runtime/codex/server-manager.test.ts` 的「停止并释放端口 / 崩溃后同端口重启」在完整并行跑时偶发失败（端口释放慢），单独跑通过。记录在 `plans/maintenance.md`，不是功能问题。
- 端到端里 Claude 的 mock 配置没法向 Claude Code 要型号列表（会超时），所以测试模式给 mock 配了内置列表（`packages/host/src/bin.ts`）。
- Studio 里 agent 的命令 PATH 去掉了 WindowsApps，用不到应用商店版的 `pwsh`、`python3`、`winget`（本机 `python`、`node`、`git` 不受影响）。

## 最近的改动（新的在上面）

**2026-10-28 深夜 · 杀毒误报、中转走平台**：用户的杀毒软件（像火绒）在平台下载 Studio 时把 `host/dist/runtime/priority.js` 报成 Trojan/Veil.a（`-EncodedCommand -ExecutionPolicy Bypass` + `Add-Type DllImport ntdll` 改别的进程）。本机用 curl 和平台 exe 下载都复现不出。修法（`322cb20`）：6 处 PowerShell 调用改成脚本走 stdin，不再有 `-EncodedCommand`/`Bypass`/`ntdll`；agent 进程去掉磁盘优先级（用户同意），内存优先级改用 `SetProcessInformation`，CPU 照旧。中转桌面客户端改由平台安装和更新（`11d0cf7`，`AGENTS.md` 第 3 条已改）：平台模式的中转不再自己更新外壳，界面照旧热更新；MCP 配置和 `amo-relay.cmd` 指向 `appselay\current`；平台打开中转时带 `--server`。发布：中转界面 deploy（服务没变、没重启），测试通道 Studio 0.9.3、Reviewer 0.9.3、中转 0.9.0、平台 0.9.4（便签仍 0.9.2），每个新上传都不到 0.3 MB；下载页 zip 0.9.4。验证：全量 vitest 917 过、typecheck 过；平台 e2e 6 条、中转 e2e 4 条（子 agent 跑）。没验证：杀毒软件还拦不拦（等用户在平台里重装 Studio）；中转登录还是自己的登录页（改读平台的 `account.json` 是下一件事）。

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
