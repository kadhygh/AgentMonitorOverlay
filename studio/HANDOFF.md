# 交接：继续开发 AMO Studio（2026-10-17）

给下一个会话看的起点。先读这份，再按需读下面列出的文件。

**2026-10-26 · AMO 中转（`packages/relay`）开工**：让 AI 会话把请求发给团队里的人（比如策划的 AI 去问程序），人和人之间也能直接聊，记录存在服务上。中转服务跑在 Mac 上。计划和进度见 `plans/relay.md`，用户的决定记在 memory `relay-decisions`，用法见 `packages/relay/README.md`。已经做好服务、命令行、MCP、桌面客户端（`relay-app` 外壳 + `relay-ui` 界面，界面由服务器下发热更新）和账号密码。**本机已经部署**：`http://172.16.1.62:47120/`，用 `scripts/relay-service.ps1` 启停。更新界面跑 `npm run relay:release`，不用重启服务，在线的客户端会自己更新（窗口没在用、也没有草稿时）；改了服务端代码要 restart。登录页和登录后都会显示服务器状态，断开后自动重连（1c）。

**2026-10-23 晚 · 用户出门期间整体推进（回来一起审）**：决定记在 memory `studio-reviewer-standalone`，计划和进度见 `plans/reviewer-standalone.md`。

- **e2e 按程序分开**：`e2e/studio`、`e2e/notes`、`e2e/reviewer` 是三个 Playwright project，共用的启动工具放在 `e2e/support`。
- **`studio/` 根目录清理**：过程文档（STATUS、NEEDS_YOU、ROADMAP、LOOP_RULES、LOOP_LOG）挪进了 `docs/`。
- **便签单独的页面入口**：`notes.html`，约 250 KB；原来要加载 Studio 整个 1.3 MB 的界面包。
- **删除旧 AMO**（`ea939ab`）：标签 `amo-legacy-final` 里还能找回；旧文档挪到了仓库根目录的 `docs/archive-old-amo/`。用户回来后让全部清掉：本机没被 git 跟踪的残留（`overlay`、`broker`、`dist`、`tmp`、`tools`、`amo.local.json`）、旧的 `AgentMonitorOverlay-studio` worktree 和 `-scratch` 文件夹，以及 G:\PROJECT 下各工程里旧 AMO 的部署：`.amo/`，`.claude/settings.local.json`、`.codex/hooks.json`、`.grok/hooks/amo.json` 里的 hook，`.git/info/exclude` 里的那几行，还有 AMOTest* 这几个测试工程。注意工程里的 `.amo/packs` 是新 Studio 的扩展包，以后清理时要保留。
- **Reviewer**：
  - 选会话发回改成「复制注释 / 复制并关闭」。
  - 窗口模块挪进了 `packages/reviewer`，Studio 从这个包引入。
  - 独立程序 AMO Reviewer：自带一个不接模型的 Host，页面入口是 `reviewer.html`，不显示书签；用 `amo-review --reviewer` 或 `npm run reviewer -- <文件夹>` 打开。

**2026-10-23 · 便签独立成程序（AMO 便签，`packages/notes`）**：用户每天在用的便签以前是 Studio 进程里的窗口，Studio 一重启就跟着关掉。现在拆成单独的程序，计划和需求在 `plans/notes-standalone.md`，界面定稿在 Design 画布 https://claude.ai/artifact/BXngZSwVW1TwTWYkcGcnVr ，用户的决定记在 memory `studio-notes-standalone`。

**程序本身**：
- `main.ts`：只允许一个实例，第二次启动会把正在跑的那个呼出来；托盘菜单是 显示便签 / 设置… / 退出便签；全局快捷键归它自己管；开机启动用 `--hidden`，只进托盘。
- `server.ts`：本机小服务（127.0.0.1，随机端口加 token），提供 Host 里便签窗口用到的那几个接口，所以 `ScratchpadApp` 原样能用；同时直接托管 UI 构建产物。另有 `/api/notes/*` 接口：设置、工作文件夹、清缓存、打开文件夹、show、Studio 导入。启动后在 home 里写 `running.json`。
- `store.ts`：`settings.json` 固定在 `%APPDATA%\AMO Notes`（测试用 `AMO_NOTES_HOME` 改位置）；工作文件夹里放 `pages.json`、`images\`、`cache\`。迁移是先复制再切换，旧文件夹原样留着。缓存指已经不被任何一页引用的图片，加上 `cache\`。
- 文档的纯函数从 host 挪到了 protocol（`scratchpad-doc.ts`），host 那边留了重新导出。

**界面**：
- `ScratchpadApp` 按定稿「甲」重做：整块一个色调、两条缩进 16px 的细线、按键提示，新增 Ctrl+Enter 复制并隐藏；空白页列出按键，其中呼出快捷键按实际绑定的显示；导入后提示一次。
- 新增 `notes/NotesSettingsApp.tsx`（窗口 `#notes-settings`）和迁移对话框。

**接入 Studio**（`app/src/notes-link.ts`，替换掉了 `scratchpad-window.ts`）：
- Studio 启动时把便签带起来，只进托盘；测试模式不自动启动。
- 顶栏「便签」：便签在跑就呼出，没跑就先启动。
- 第一次会把 Host 里的便签页和图片交给便签程序，只在便签那边还是空的时候导入，Studio 的旧数据不动。
- 启动用 `cmd start`，所以便签不算 Studio 的子进程，`taskkill /T` 关 Studio 也带不走它。
- 设置 → 便签换成 `NotesLinkSection`：显示运行状态，按钮是「显示便签 / 启动便签」和「打开便签设置」。普通浏览器里没有 Electron，那里仍保留旧的页内编辑。

**测试**：
- 单元测试：`notes/src/store.test.ts`，还有从 app 挪过来的 `placement.test.ts`。
- e2e：`notes-app.spec.ts` 5 条，直接启动便签程序，原来 Studio 便签窗口的分页、图片、复制换行、页数这些测试都搬到了这里；`scratchpad.spec.ts` 改成测「Studio 启动便签 → 导入一次 → 设置节」。截图在 `screenshots/notes/`。

**同日后续（`a2ced1e`）**：冷启动时先弹「便签启动中」小读条，等窗口准备好才出现；从托盘启动时会在后台预先建好窗口，所以之后每次都是瞬间出现。Studio 会把自己的界面大小同步给便签（`/api/notes/look`）。翻页改成 Alt+1…9，并去掉了应用菜单。托盘图标换成便签自己的图标（`packages/notes/assets`），右键菜单改成 AMO 风格的小窗（`#notes-tray-menu`）。复制按钮的颜色还在等用户在画布上挑。

**还没做**：Portable 打包时把便签带上（到发布时再做）。在打包版里，`notes-link` 用 `process.execPath` 加 `resources/app/packages/notes` 启动，需要确认打包后的目录里有它。

**2026-10-23 · 开始 / 新会话的「正在启动」**：用户反馈点「开始」或任务里「开始新会话」后要卡一下界面才变。原因是请求要等模型进程：Claude 在非默认权限模式下要等 `setPermissionMode`（`live.ready`），Codex 要等 `thread/start`（首次还要起 app-server），另外 `withDefaults` 的型号列表缓存超过 10 分钟会重新起一个 CLI 去问。**界面**：`lib/StartingCover.tsx` 盖住会话启动所在的区域，挂载后立即拦截点击和按键；200ms 后才显示变暗、转圈和「正在启动 <模型>…」，15 秒后再加一句「启动得比平时慢…」。新建任务页盖整个 `.draft-page`；任务页只盖 `.thread-col`（`TaskPage` 的 `starts()` 包住 `newSession`、`startPreset`），左边会话列表和窗口其他部分照常可用。失败时遮罩撤掉，错误照常显示。**Host**：Claude 的 `sendMessage` 不再 `await live.ready`，改成 `live.ready.then(push)`，按顺序排队，调用方不用等进程起来。Claude 和 Codex 的 `choices` 改成先返回旧缓存、后台再刷新（`askModelsFor` / `listModels`，同一 key 同时只问一次），只有完全没有缓存时才等。Codex 的 `thread/start` 和 DSH 起进程还是要等，靠遮罩提示（用户说用过再看要不要改）。e2e `starting.spec.ts`：用 `context().route` 拖慢请求，检查遮罩的出现、位置、消失和失败路径；截图 `screenshots/stage-18/S24-starting-cover.png`。顺带修了 e2e 并行跑时的端口冲突：Codex 的 app-server 以前总是从 47910 开始挑空闲端口，几个 Host 同时启动会挑中同一个，结果报 os error 10048 退出。现在 `pickPort` 从范围里随机一处开始找。

**2026-10-23 · Reviewer 第三批（用户试用后的反馈）**：(1) 查看包里的文件：Tab 现在会带动上面的重点栏，效果和点了上面的按钮一样。`FileReview` 新增 `onActiveRow` 参数，`FileItemView` 把当前行对应到某个重点，记为 `pressed`，按钮可能在栏外就滚动过去；点栏上按钮时用 `clicks` 计数放进 `openKey`，所以 Tab 走开后再点同一个也会跳回去。按某一行打开时，那一行直接就是当前行（`setActive(line - 1)`），Tab 从它往下走。按键都写出来了：文件下面一行 `vw-keys`（Tab/Shift Tab、w/s、Ctrl G、Ctrl F），「重新载入」按钮上标 r（查看包里的文件现在也响应 r），查看包列表底部写 j/k，git 条目再加 Ctrl J/K。(2) 「打开 Review / 打开查看包」以前在 agent 回复之后会跟着那组工具一起折叠起来，所以找不到。现在折叠的那组下面照样显示这些按钮（`ProcessRows.tsx` 的 `ReopenButton` 和 `reopenTarget`）。

**2026-10-23 · Reviewer 优化（两批，`bcc26a8` 和其后一次）**：
- **快捷键统一**：同一功能用同一个键（记忆 studio-view-packs）。
  - Git Review：q 循环切换范围，e 切换单栏 / 左右对照，r 刷新，Tab / Shift+Tab 在当前文件的批注行之间跳（到头绕回，`logic.ts` 的 `cycle` / `nextOf`）。
  - 文件查看（`FileReview`）：Tab 在批注和重点之间跳，w / s 翻页；`ViewerApp` 的 r 重新载入。
  - 改动预览：e、a / d、n / p、Tab、w / s。
  - 查看包有多项时，j / k 切换左边的条目（`PackViewer`），内嵌 Review 的文件改用 Ctrl+J / K（`ReviewPage fileKeys="ctrl"`）；只有一项时 j / k 照旧切换文件。
- **工具栏不换行**：`lib/fitWidth.ts` 测出工具栏里不收缩的项、可收缩项的 min-width，再加上工具栏左右两侧被占的宽度（查看包左边的列表），通过 `amo:min-width` 报给主进程。主进程按缩放和窗口边框换算后 `setMinimumSize`，不低于窗口创建时的最小值。`.gr-head` / `.vw-actions` 改成 nowrap，项目名、分支名放不下时省略。
- **书签说明框**：加了 ×，Esc 取消，取消时抛 `BookmarkCancelled`，各调用方忽略它，不加书签。
- **git 条目**：`files` 不再过滤，而是作为「重点文件」一组排在最上面，下面是「其他改动」（`ReviewPage only` + `FileList group`）。新增 `highlights: {path, line, endLine?, note}[]`，带重点的文件会自动加进 files。提交类条目在 Host 端读出 `source.subject`，列表里显示「提交 xxx · 说明」，下面一行列出重点文件名和重点数。
- **重点的样式**：紫色 `--gr-hl`。增删行保留原底色，只加左边条、细描边和荧光笔图标（`hl-start` 的 ::before mask）；未改动的行铺紫色底；左右对照模式下画在新版本一侧。
- **标尺**：`OverviewRuler marks`（`markRuns`），重点和批注画在标尺右半边，和改动颜色并排。文件查看也用这个标尺代替原生滚动条。
- **会话里的工具行**：`review_open` 打开整个项目（没有生成查看包）时，那一行有「打开 Review」按钮（`reviewTargetOf`）。

**2026-10-23 · DSH 写入沙箱和文件夹权限**：起因是 DSH 子会话用 write 档跑在 `G:\PROJECT\project_mining_dev` 上，每条命令都报 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(…)`，然后都要人批准（调查A 82 次）。查下来这不是 write 档或 `session_start` 指定目录的问题。DSH 0.2 的 Windows 沙箱要给项目根目录加一条自己身份的权限，再加一个 Low 完整性标签，然后传给所有子目录。设标签要 `WRITE_OWNER`，所有者默认只有 `READ_CONTROL`/`WRITE_DAC`，所以需要「完全控制」；要传给已有的子目录，每个子目录也得有完全控制。G 盘下的目录一般只继承到 Authenticated Users 的「修改」，所以：没有完全控制，沙箱直接起不来；只在根目录有完全控制（DSH 自带的修复脚本 `diagnose-windows-sandbox-acl.ps1` 就只加这一层），授权只落在根目录，已有子目录里写不进去，只有之后新建的子目录才有。用测试目录对比验证过：可继承的 `(OI)(CI)F` 才行；根目录已经有授权的，`icacls /grant` 会把权限项重新传下去，标签要再 `icacls /setintegritylevel (OI)(CI)low` 一次。沙箱的防护不受影响：受限令牌照样只能写工作区，工程外照样被拒（实测过）。**Studio**：`runtime/dsh/folder-access.ts` 做两件事：`readIcacls` 判断是否「本人或 everyone 类组有根目录的 F，并且有可继承的 F」；`windowsFolderAccess` 修复，步骤是 `/save` 备份到 `<data>/dsh/acl-backup`，然后 `/grant 本人:(OI)(CI)F`，有标签的再 `/setintegritylevel`，低优先级跑。`DshRuntime` 在 write 档会话起进程时先检查一次（同一文件夹每次运行只读一次），另外认出 `grantWrite` 的报错。两种情况都在会话里发一条提示（`notice.action = { kind: "folder-access", path, state }`），带「修复文件夹权限」按钮，对应 `POST /api/sessions/:id/folder-access`。修复中、修好、失败都更新在同一行，修好会同时更新同一文件夹其他会话的提示。设置 → 项目与目录 有一节「DSH 沙箱的文件夹权限」（`settings/FolderAccessSection.tsx`）：选一个项目，看它的状态，点「一键修复」，对应 `GET /api/dsh/folders`、`POST /api/dsh/folders/:workspaceId/fix`。修复按文件夹排队，每个文件夹同时只跑一个（`DshRuntime.fixFolder`、`folderJobs`），和会话提示用的是同一个修复，提示会跟着更新。不用管理员：所有者本来就有 WRITE_DAC。**低完整性标签的副作用（同日）**：DSH 给工作区打的 Low 标签会被新文件继承，不管是谁创建的。Windows 从 Low 标签的 exe 启动进程时，进程会降成 Low，于是写不了项目外，Electron 甚至直接崩。Studio 仓库就中过一次：沙箱测试后 node_modules 里的 electron.exe 起不来，已把 AgentMonitorOverlay 的标签恢复成 Medium。因此「设置权限」= 缺完全控制时补上可继承 F → 打 `(OI)(CI)low`（先于 DSH，DSH 之后的授权会保留 exe 上显式的标签，实测过）→ 把所有 .exe 设成显式 Medium（`findExes` 只跳过 .git、不跟随链接，然后按目录 `icacls dir\*.exe /setintegritylevel medium`）。结果记在 kv `dsh-folder:<path 小写>`。状态 ready = 有可继承 F 且有这条记录。设置 → 项目与目录 现在是摘要 +「管理…」，打开 `FolderAccessDialog`（每个项目一行：设置权限 / 重新扫描）。在新建任务页和会话权限托盘里，DSH 选「工作区可写」而项目没设置过时，显示 `SandboxHint`（设置权限… / 改用完全访问）；`session_start` 的返回也会带 `sandbox` 说明。「工作区可写」会话每轮结束时，已设置的项目会自动补扫，最多每 10 分钟一次（`AUTO_SCAN_MS`，测试里用 `dshFolderScanMs: 0`）。新生成的 exe（构建产物、pull、npm install 带来的）都会继承 Low，所以要么重新扫描，要么把构建输出放到项目外。测试用 `agent` 时默认关掉这项（`folderAccess: null`），可以通过 `startHost({ dshFolderAccess })` 注入。假 agent 新增 `[[nosandbox]]`。主会话写的那条「DS 子会话一律 full」记忆（E--TOOLS-AMO memory）已按用户要求删掉。

**2026-10-23 · 查看包（view packs）：给人看东西的统一架构**：起因是 agent 连着用 `review_open` 打开 a、b 两个文件，预览窗口被第二个冲掉。用户定的方案（记忆 studio-view-packs）：agent 一次调用交一个「查看包」，里面是带类型的条目，每种类型两端各一个模块。**数据**：`protocol/src/viewpacks.ts`（`ViewPack`、`ViewItem` = file / git / proposal、`viewItemLabel`/`viewItemDetail`），表 `view_packs`（迁移 21，body JSON），事件 `viewpack.upserted` / `viewpack.open`（带 `itemId`：这次加的那项先显示）。**Host**：`features/viewpacks/`——`service.ts`（校验、同一会话 10 秒内再发就合并进同一个包、存、发事件）、`kinds/kind.ts`（模块接口：`check` 解析校验、`merge` 判断是否同一条、可选 `diff`）、`kinds/file.ts`（文件 + 重点：行/范围 + 说明）、`kinds/git.ts`（working / base / commit / range，refs 解析成完整 id，`files` 只看几个文件）、`kinds/proposal.ts`（改动预览：建包时读原文件，`git diff --no-index` 两个临时文件算差异，磁盘不动）、`kinds/index.ts` 注册表；MCP 工具 `view_open`（自动批准）；`review_open` 打开单个文件（mode file，或 changes 带 file）时改成生成查看包，整个项目的 Review 照旧。**界面**：查看器窗口 `#viewer?pack=…&item=…` → `viewpacks/PackViewer.tsx`（左列表、多于一项才显示；右边按类型）；`viewpacks/kinds.tsx` 注册表（图标 + 视图）；`FileItemView`（复用 FileReview：重点画在行上、说明插在最后一行下、顶部重点按钮；书签、批注照旧）、`GitItemView`（嵌入 ReviewPage，新 `only` 参数只列这几个文件并说明哪些在范围里没改动）、`ProposalItemView`（DiffView + 只在窗口里的临时批注，「发回会话」拼成一条消息，没有书签）。`DiffView` 新 `highlights` 参数。对话里 view_open / review_open 那一行有「打开查看包」按钮（`viewpacks/logic.ts` 的 `packIdOf` 从工具输出里认 packId）。**加新类型**：Host 在 `kinds/` 加模块并登记到 `kinds/index.ts`，界面在 `viewpacks/kinds.tsx` 加一项，protocol 的 `VIEW_KINDS` 和 `ViewItem` 加类型；窗口和流程不用动。验证：Host 单测 5 项（文件/重点、拒绝、git refs、改动预览差异、合并规则）、界面 logic 单测、外壳 viewerHash；e2e `view-packs.spec.ts` 3 条（截图 `screenshots/stage-18/S23-viewpack-files.png`、`S23-viewpack-proposal.png`），`review-open.spec.ts` 按新行为改了两处。

**2026-10-23 · DSH 0.2.1-rc.2 已构建并实测**：`pnpm install`（pnpm 11.28.5）+ `pnpm run build:artifacts` 通过；设置里「检查」：可用 · ACP 1 · 3 个型号；真实回归 3/3（含速度/token 和「完全访问由 Studio 同意」），DeepSeek 用到 45/1000。

**2026-10-22 · session_start 的回报改成按事件、每轮都报**：用户发现子会话有时做完不回报。实测原因：调查 A 被人停止时，Studio 把半截回复当「这一轮做完了」报给主会话，之后「继续」真正做完却没报（旧规则只报第一轮，而且监视只在内存里，重启就丢）。用户定了不做定时检测、只按事件触发：`Session.reportTo`（迁移 20，`sessions.report_to`）记下回报给谁；`SessionsFeature.watchReports()`（HostService 构造时注册）在会话每次 upsert 时看最新的 turn 条目：completed → 转最后回复（这一轮里它已给主会话留过言就只发一句）；interrupted → 「被人停下了，还没有结论」；failed → 错误信息；等人审批不算结束。已报过的 turn 记在 kv `report-turn:<sessionId>`，重启不重复也不丢。验证：peer 测试（停下→继续→留言→改名不重报）、vitest 715/721（server-manager 端口冲突同前）、e2e session-start 2/2。

**2026-10-22 · DSH 会话的 token 速度、DSH 拉到 0.2.1-rc.2（未构建）**：用户选「读 DSH 自己的会话记录」。`runtime/dsh/session-log.ts` 读 `<DSH_HOME>/sessions/<cwd>/<acpId>/session.v4.jsonl.zstd`（Electron 的 Node 24 有 zstd），只解析最后一个 `turn/start` 之后的行，照 DSH 的 session-stats 算：每次调用从首个输出 token 到 `assistant/message`、加它的 `usage.outputTokens`；同时补上这一轮的输入/缓存/输出 token（以前都是 0）。一轮结束时读（2 秒后再读一次防止没写完），运行中在 `usage_update` 时最多 30 秒读一次；DSH 这一轮的开始时间早于 Studio 这一轮 5 秒以上就不用（还是上一轮）。实测三个会话 213/253/222 tok/s，每次 14–20 ms。模拟 DSH（testkit）也写这份记录（每轮 400 token / 2 s），集成测试核对。DSH 仓库 `git pull` 到 0.2.1-rc.2（9 个提交：网页版 DeepSeek 搜索、Flash 显示名，ACP/权限预设/会话格式只改版本号）；**还没 `pnpm install` + `pnpm run build:artifacts`**：用户有 DSH 会话在跑，构建会替换它正在用的 `lib`。等用户这轮跑完：构建 → 设置里「检查」→ `AMO_STUDIO_DSH_CLONE=G:\PROJECT\deepseek-harness npx vitest run packages/host/src/runtime/dsh/dsh-real`（新增速度和「完全访问由 Studio 同意」两项，约 4 次 DeepSeek 调用）→ 重启 Studio。

**2026-10-22 · 委派会话可以在别的项目里、DSH 权限的真实原因**：用户要求放开「任务的会话都在任务的项目里」：`session_start` 加 `workspace`（项目名/id/路径），会话仍属于该任务，只是在那个项目的文件夹里工作（第一句话说明在哪），会话列表行上显示项目名小标签、详情写「在项目 X 里工作」。刚加的 `fullAccess` 换成 `permission: read-only | write | full`，按运行时映射（Codex read-only/workspace-write/full-auto，Claude plan/acceptEdits/bypassPermissions，DSH read-only/workspace-write/full-access）。**DSH 0.2 的权限**：它的 permission-presets 插件在会话创建时把权限写进会话记录（`permission/preset`、`sandbox/mode`、`approval/policy` 三条事件，见 `.data/dsh/home/sessions/<cwd>/<id>/session.v4.jsonl.zstd`），之后进程重启也以记录为准，`DSH_PERMISSION_MODE` 只决定新会话；ACP 没有斜杠命令也不能改它。所以：完全访问＝Studio 对 DSH 的每个提权请求直接同意（从选中那一刻起，等着的一并同意）；对已开始的会话收紧权限不生效，界面如实提示「要更严的权限请新开会话」。用户实测「停止再继续仍要权限」就是这个原因。另：新版 DSH 默认只有 workspace-write / danger-full-access 两个预设，Studio 的「只读」可能让 DSH 启动报 no preset，未验证。**DSH 会话没有 tok/s**：ACP 只给上下文用量；DSH 自己的会话记录里每次调用有 `usage.outputTokens` 和流式时间（`assistant/message` 的 `usage`、`stream`），可以读来算准确速度，等用户决定。验证：typecheck/build 通过；vitest 711/716（server-manager 端口冲突同前）；DSH 16/16；e2e session-start（含跨项目标签）+ focus-subagents 5/5。

**2026-10-22 · 委派会话实测后的四个修正**：用户在任务「将lks的分支改动合并到本分支」里让 Opus 主会话开了 3 个 DSH（deepseek-flash）调查会话。①Focus：委派会话在开它的会话未归档时按子 agent 处理（`lib/sessionSeen.ts` 的 `hangsUnderOf`；进行中挂在父会话「▸ N」下、带拐弯箭头；父会话要等它们跑完才算完成；置顶取父会话）；等你审批的委派会话仍单独列在等你处理。②根因：任务建在公共空间 `E:\TOOLS\AMO`，代码在项目 project_mining_dev；DSH 在公共目录初始化沙箱失败（Win32 5），几乎每条命令都要批准。有会话的任务不能改项目，所以 `session_start` 加了 `fullAccess: true`（Codex full-auto / Claude bypassPermissions / DSH full-access），guide 里说明什么时候用。以后这类任务直接建在对应项目里。③会话中途切到完全访问立即生效：DSH（ACP 只能换模型和思考强度，换权限要重启进程）在这一轮里 Studio 直接同意等待中的和之后的请求，这一轮结束后按新权限重启；Codex 同样直接同意（MCP 表单不算）。改成更严的权限仍是这一轮结束后生效。④「AMO 更新：任务说明改成了…」是会话自己用 task_describe 写的说明又被当成别人的改动告诉它：现在写自己任务说明的会话不再被告知（`noteOwnDescription`），任务里的其他会话照常收到。验证：typecheck/build 通过；vitest 713/715（`server-manager.test.ts` 在开着日常 Studio 时端口冲突，与改动无关）；e2e focus/focus-subagents/focus-history/session-start 15/15。改了 Host，重启后生效。

**2026-10-22 · 委派会话（会话开会话，挂在父会话下）**：`session_start` 本来就能带 `model` 换模型；现在开出来的会话记下 `startedBy`（迁移 19，`sessions.started_by`），会话列表用 `buildSessionTree(live, { delegated: true })` 把它挂到开它的会话下面，图标是拐弯箭头，悬停和详情写「委派会话 · 由「X」开的」，「▸ N」折叠计数也算它。它仍然是 `kind: "main"`、`parentId: null` 的主会话：用户定了**父会话归档时它不跟着归档**（`collectSubtreeIds` 只看 parentId），主控转发、看板计数、Review 列表照旧。`session_tree`（MCP）的节点多一个 `startedBy`。`guide.ts` 和 `session_start` 说明加了一句：强模型额度紧时，把调查和照计划改代码交给便宜模型，计划写到不用再问。验证：typecheck/build 通过；vitest 全量 700/705（`server-manager.test.ts` 3 个在满负载下超时，单独跑 4/4 通过）；`session-start.spec.ts` 两个方向（Claude→Codex、Codex→Claude）通过。截图 `screenshots/stage-18/S18-session-start.png`。改了 Host（有迁移），重启后生效；本轮未重启日常实例。

**2026-10-22 · 输入框里 @ 的任务/会话名变色**：用户反馈 @ 选中的名字和普通文字一样。textarea 不能给部分文字上色，所以 `MentionBackdrop`（`attach/useMentions.tsx`）在 textarea 后面画同样排版的文字，`@名字` 用 `--chat-mention`（浅色 #2a64b0、深色 #8db8ff）加 14% 底色；有提及时 textarea 文字透明、光标和选区保留，滚动同步。只在 `.chat-input` 生效（`.marked` 类），文件 @ 仍然变成上方的附件卡片。`mentionSpans` 有单测；`attachments.spec.ts` 检查颜色不同、背景层和 textarea 位置完全重合。截图 `screenshots/stage-18/S18-mention-colour.png`。纯界面改动，Ctrl+R 即可。

**2026-10-22 · 项目分组（样式 B 树形）**：用户从四种样式里选了 B（预览 https://claude.ai/artifact/P2cxLfTaTrbCXgsRSJ6qwr ）。分组存在 Host 的设置里（`StudioSettings.projectGroups`，kv `settings:project-groups`，`PUT /api/settings { projectGroups }` 整表替换；Host 去掉不存在的项目、一个项目只进第一个提到它的组），只给人用，和专题无关、agent 不读。左栏（`board/ScopeNav.tsx` + `board/projectGroups.ts`）：分组是一行（▾/▸、叠放文件夹图标、加粗名字、项目数），组里项目挂在细竖线下；点标题折叠（本机 `amo.navGroupsFolded`，折叠时仍显示当前所在的项目，组里有会话等你处理时标题多一个黄点）；拖项目到标题进组、拖到别组的项目上换组并排序、拖标题调整分组顺序；组内顺序沿用 navOrder。右键项目：加入分组 ▸（已有分组打勾 + 新建分组…）、移出分组；右键分组：编辑分组…（`EditGroupDialog`，名字 + 说明）、解散分组。「项目」整段折叠时仍按原样只显示置顶的项目。验证：typecheck/build 通过；单测 `projectGroups.test.ts`、`config/groups.test.ts`；e2e `project-groups.spec.ts` 加上 nav-order/nav/board/topics 共 12/12 通过。截图 `screenshots/stage-18/S18-project-groups.png`。改了 Host（设置字段），重启后生效。

**2026-10-22 · Review 快捷键选文件时列表自动跟随**：用户报大量改动时 j/k 或上下键选中文件，左侧滚动条不跟随。原因是 `FileList` 的 LazyChunks 只 keep 选中行所在块，没滚动定位。现在给选中行挂 ref，layout effect 在选中/列表布局/树展开后用 nearest + instant 滚入视口；选中项留 2px scroll margin 避免像素取整裁边。查看器的隐藏改动页用 active 标记避免在后台滚动，显示后再定位。`ReviewApp` 文件切换改为函数式更新，快速连续按键不再依赖旧 selected 闭包。`review-file-scroll.spec.ts` 用固定 600 文件 Git 响应避免按键时大量启动 git：修复前在第 45 个文件稳定复现 viewport ratio 0；修复后平铺/目录树双向切换、可见项不乱滚、跨懒加载块跳到第 350 个、批量连按、自动展开折叠目录都通过，且仍保持分块渲染。typecheck/build 通过，相关 e2e 6/6（含历史、快捷键、查看器批注）。截图 `screenshots/stage-18/S18-review-file-scroll.png`。纯界面修复，使用本轮构建重新加载 Review 窗口即可；本轮未重启日常实例或打包。

**2026-10-22 · 左栏项目/专题拖拽排序**：`board/ScopeNav.tsx` 的项目、专题条目支持拖到目标行前/后（落点线、拖动透明度），也支持 Alt ↑/↓；保留置顶优先，置顶组/普通组各自排序，不跨项目/专题改变归属。模块标题可拖拽交换两个模块的上下位置，实际 DOM 顺序跟随。`board/navOrder.ts` 把条目 id 和模块顺序分别保存在 `amo.navOrder.project/topic/sections`，跟随 storage 事件；默认沿用原来的列表和置顶顺序，改名不影响位置，新条目追加，折叠时调整不会丢失隐藏条目的顺序。与其他 localStorage 界面偏好一样按实例地址保存（端到端重启使用相同 Host 地址）。验证：typecheck/build 通过；`nav-order.spec.ts`、`board.spec.ts`、`topics.spec.ts`、`task-head.spec.ts` 共 11/11 通过，含真实 HTML 拖拽、跨类别拒绝、置顶边界、折叠、改名、刷新和关闭后重开。截图 `screenshots/stage-18/S18-nav-order.png`。纯界面改动，使用本轮构建重新载入即可；本轮未重启日常实例或打包。

**2026-10-22 · 提问弹窗与来源/阻断标记**：用户截图里的 GPT 大选项板来自 AMO MCP `decision_request`，原来 `SessionDecisions` 固定占对话区最高 45%；Claude 的原生提问原本用 `q-popup`。现在 AMO 决策也复用 `PromptCard`（从 `QuestionCard.tsx` 抽出同一套问答界面），只在顶部保留紧凑待回答行，弹窗支持收起、关闭后重开、草稿保留、多条决策依次处理；回答仍经 decisions API 作为留言返回，Focus 保留快捷回答。来源与阻断分开标记：AMO 为「跨工具请求 · AMO MCP」+「非阻断 · 留言返回」；Claude/Codex 原生同步问题「阻断式 · 等待回答」；Codex 原生异步问题「非阻断 · 下一条消息返回」；MCP 表单同时有跨工具来源和阻断标记。用户引用的 DSH AskUserQuestionRequest 的“跨包”是实现层接口共用，不等同于非阻断，因此界面使用跨工具来源标记。核查本机 `G:/PROJECT/deepseek-harness/packages/acp/acp`：当前 automation-only ACP 没有原生问答/elicitation 通道；DSH MCP instructions 补充使用 decision_request，fake ACP 支持带 JSON 参数调用 MCP，用真实 AMO HTTP 链路验证。验证：typecheck/build 通过；相关单测 48 通过；第一轮相关 e2e 10/10（含 DSH），加标记后的最终 e2e 7/7。完整单测 700 通过、2 跳过，server-manager 的 stops the server and frees the port 失败（47941 != 47940，afterAll 超时），单独重跑仍同样失败；该测试和实现本轮未改动，未处理这个已有端口释放问题。截图 `screenshots/stage-18/S18-decision-popup.png`。界面更新需要重新载入；DSH 新工具说明需要 Host 重启后重新连接，本轮未重启日常实例或打包。

**2026-10-22 · Reviewer 接口增强**：受管会话新增 MCP `review_open`（`features/gitreview/mcp.ts`），默认当前项目、批注发回调用者，无需模型提供 session id；可用 `workspaceId` 指定另一登记项目。HTTP `POST /api/review/open` 和 `amo-review` 共用：`mode=file` + `file` 看当前文件，可带 `line/endLine`（CLI `--line/--end-line`），不要求 Git；`mode=changes`（默认）保留 base/commit/range，提交视图也支持选文件。重复打开文件或整个项目会重新读磁盘/Git，修了查看器同路径内容不刷新的问题；请求无效时不再遗留新登记项目，指定文件没有差异时明确报错。可复用 skill 源文件在 `skills/amo-review/SKILL.md`（未安装全局或接入额外的 skill 加载器，AMO 内可直接用 MCP）；调用说明在 README。验证：typecheck/build 通过，完整单测 701 通过/2 跳过，最后改动的定向单测 18 通过，相关 e2e 11/11（含 Claude/Codex mock 对话打开文件、行号、修改后刷新、批注实际发回、再次 MCP 打开 Git 差异、提交选中非首文件）。截图 `screenshots/stage-18/S18-review-mcp-file.png`。当前比较来源为 Git，未增加按单次 LLM 编辑保存的独立 before/after 快照。**改了 Host 和主进程，需要重启后生效；本轮未重启现有实例或打包发布。**

> **2026-10-17 更新（下一个会话从这里开始）：阶段 16 全部做完，计划和每项做法在 `plans/stage-16.md`；阶段 15 的设计在 `plans/stage-15.md`。**
> - **10-19**：「执行」角色卡不再要 agent 主动记进度（人让记才用 task_note_add，交接才用 handoff_submit；`0c438d6`）；批注可以置顶（`pinnedAt`，`PATCH /api/annotations/:id` 带 `pinned`，已发送的也能置顶，置顶的排在批注栏最上面、不进「已发送」折叠；`ccbaa13`）；新任务页能粘贴 / 拖入 / 回形针加图片和文件，跟第一句话一起发（`NewSessionInput.attachments`，有图片时会话建好后按普通消息发；放进待办不带；`d4939d8`）。之后：渲染的 Markdown 文件（查看器、快速查看）用源码视图的颜色（标题、链接、代码、粗斜体、列表符号、引用、表头）；会话里 Ctrl+F 查找（复用 `FindBar`，新增 `within` 只搜 `.thread-inner`，页面文字模式从视口处开始找；`f159326`）。用户让重启，10-19 已重启开发版（库备份在 `.data/backup-before-mdfind-20261019`，任务 17 / 会话 46 前后一致），以上都已生效。再之后：Claude 权限加「帮我审批」（`auto`，Claude Code 分类器代人审批，拿不准仍走 canUseTool 卡片；第三方端点标不可用；实测记在 spikes/RESULTS.md h 节；`76d638a`，已重启生效，备份 `.data/backup-before-auto-20261019`）。**书签**（`673fc64`，用户定的：文件标记合并成书签、按专题分组；对话只收藏选中的一段；看的地方是书签窗口 + 专题页「书签」栏）：迁移 18（`file_marks.topic_id`、新表 `chat_marks`），`GET /api/bookmarks`、`POST /api/chat-marks`、`PATCH/DELETE /api/bookmarks/:id`；选区条多了「书签」；书签窗口里对话片段可拖成引文、「打开对话」经 `openInWorkbench` 的 `passage` 回到主窗口并只闪那段字；查看器 / 快速查看的「书签」按会话的专题放。**这个还没重启**（有迁移，重启前备份）。没做的：agent 读对话书签的 MCP 工具（list_file_marks 仍只读文件）、对话里已收藏的段落不显示标记。再之后（`221eea5`）：定位到原文改成只滚对话、按原文位置居中（原来 scrollIntoView 居中整段，长段落里的原文落在视野外）；发送后跳到最新（设置 → 界面，存 localStorage `amo.scrollOnSend`，默认开）。画布（`583ff59`）：拖空白处网格跟着动（`gridStyle`）；**连线**（`CanvasDoc.links`，与依赖分开；卡片四边圆点拖出，双击写字，右键 编辑文字/反过来/删除；Host 保存时 `pruneLinks` 去掉卡片已不在的线；大纲多「连线」一节）。书签和连线都改了 Host，**等重启**。后退/前进（纯界面，`shell/navHistory.ts`）：Alt+←/→、鼠标侧键、顶栏两个箭头；回到会话时还原滚动位置；用户选了不要「最近去过」列表。第三方 DeepSeek（`68ba436`）：设置 → 模型「+ DSH 方案」，渠道 kind `dsh`；会话启动 DSH 时带 `DEEPSEEK_BASE_URL`（渠道网址，要 Anthropic 兼容接口，DSH 的 deepseek-official 路由只说 Anthropic Messages）和渠道自己的 `DEEPSEEK_API_KEY`；模型名要和官方一致（DSH 目录只有官方名，可配 `models` 但要写 profile patch，整段替换，没做）。DSH home 里若有存下的 Key 会盖过环境变量（Studio 自己的 home 现在没有）。改了 Host，**等重启**。用户问过的「MCP 服务 unityMCP 没能启动」是用户全局 `~/.codex/config.toml` 里的 Unity MCP（127.0.0.1:8080），用户已自己关掉。
> - **10-20**：桌面快捷方式「AMO Source」改指 `studio\start-studio.cmd`（图标 `packages/app/assets/icon.ico`）。**设置 → 维护**（新页）：显示是不是从 git 工程源码启动（Host 看 studio/ 上一层有没有 `.git`；分支、提交、未提交文件数），「打开维护终端」在工程根目录开 PowerShell，跑选中模型自己的 CLI（`GET /api/maintenance`、`POST /api/maintenance/terminal`，`features/maintenance`；runtime 新增可选 `freshTerminal`）。Claude 用自带的 claude.exe、按渠道带密钥，但**不设 CLAUDE_CONFIG_DIR**，用用户自己的 ~/.claude（记忆和设置都在）；Codex 用 `CodexServerManager.terminal`，和 app-server 同一套 `-c`（不带 AMO MCP），TOML 值改成单引号，因为 Windows PowerShell 5 会弄坏参数里的双引号（已实测 codex 能读）。DSH 没有。终端环境去掉 `ELECTRON_RUN_AS_NODE` 和 `AMO_STUDIO_*`，在里面能正常 `npm start`。改了 Host，**等重启**。 之后：打开维护终端报「Windows 找不到文件 'Studio'」——Node 把 `start` 的标题引成 `"\"AMO Studio…\""`，cmd 读成标题 + 程序 `Studio`（会话「交给终端」同样受影响）；`WindowsTerminalLauncher` 改成自己拼 cmd 行（verbatim），PowerShell 命令走 `-EncodedCommand`（`72da594`）。**开发目录搬家**（用户同意）：主仓库 `G:\PROJECT\AgentMonitorOverlay` 切到 master，`-studio` worktree 分离留作退路；`studio\.data` 整个复制过来，2 条附件记录和 4 个附件 json 里的旧路径改成新目录；桌面「AMO Source」改指新目录；三个旧 worktree 已删（`task-launch-entry` 未提交的改动先存成 `557c338`）。 再之后：维护终端优先用 PATH 上用户自己的 `claude`（`installedClaudeExe`，找不到才用 SDK 自带的；「交给终端」仍用 SDK 自带的，`219db41`）；SDK 升到 0.3.304（自带 Claude Code 2.1.304，peer 依赖不用动，`f3415df`）。改了 Host，**等重启**；重启后要实际跑一个 Claude 会话确认新 SDK 正常。 再之后：**加书签先写说明**（选中段落、书签按钮/菜单、找文件、书签窗口加单个文件都先弹「书签说明」，只有确认、可留空，然后提示「书签添加成功」；已有的不再问；`NotePrompt.tsx`，`8ec4b1c`）。**打开大文件整机卡死**（用户在查看器里点开 project_mining 的 prefab「改动」，所有窗口卡 18–22 秒）：查到是**辅助功能树**——有程序经 UI Automation 读窗口时，页面把整棵辅助功能树和每次变化发给主进程，主线程处理（Chromium 追踪里 `render_accessibility_host.cc HandleAXEvents` 一个任务 17957ms；2879 行的 prefab 在查看器里是 3.3 万个元素）。修法：默认 `disable-renderer-accessibility`，`AMO_STUDIO_A11Y=1` 可重新打开（读屏、划词取词在 Studio 里就读不到字了，用户同意；`e089e62`）。排查时加的记录（git 追踪、事件循环卡顿、主进程 JS 采样 + Chromium 追踪）修好后都已删掉（`2c0b7f4`），要再查可以从 `4eefb99`、`9d9732f`、`5918ced`、`5e9cfbd` 拿回来。顺带发现但没改：查看器「改动」打开时 `git/changes` 请求两次（选中文件后又 reload 一次）；`POST /api/fs/exists` 每次都对整个仓库 `git ls-files`（project_mining 5MB 输出）。 再之后：**性能审计**（三个只读 agent 查主进程 / 页面 / Host 同类问题），大的建成了 AgentMonitorOverlay 项目里的 4 个待办任务（查看器/Review 只渲染可见行、对话渲染性能、Host 数据规模、主进程杂项，说明里有具体位置）；小的做了（`0054fff`）：非看板事件不再给 state 新对象（流式 token 不再重绘所有窗口）、Ctrl+F 一次读完再上高亮（`cellSelector`）、Host 启动时一次异步读全部密钥（`preload`，PowerShell 读写改 UTF-8）、查看器「改动」不再重复读 git、Focus 点击穿透只在变化时设置（`forward` 会装全系统鼠标钩子，跑在主线程上，主进程一卡全桌面鼠标都卡）。**SDK 0.3.304 的坑**：Claude Code 2.1.304 默认把 MCP 工具藏在 ToolSearch 后面，AMO 的 SDK MCP 服务加了 `alwaysLoad: true`（`c39b343`；e2e 的决策 / 邮件 / 交接 / MCP 画布因此挂过）。用户提的 4 点（`1526f73`）：批注气泡顶部可拖；Focus 展开有「进行中」（任务名 + 说明第一行）；底部「历史」最近 10 条（`focus/history.ts`，每段等待一条，localStorage `amo.focusHistory`）；停在会话上回复完也提醒（`useMarkSessionSeen`：打开算看过，之后的变化要等下一次点击/按键/滚轮/窗口回到前台）。新 e2e `focus-history.spec.ts`。改了 Host 和主进程，**等重启**。 再之后：Focus 点击修复（按下就确认提醒会让机器人消失、面板变高、点击落空 → 改成点击时确认；「进行中」挪到列表最上，`7b76e21`）。**第二批 4 个性能任务都做完了**（项目 AgentMonitorOverlay 里 4 个任务已挪到完成）：① 查看器 / Review 只画视口附近的行（`gitreview/LazyChunks.tsx` + `reveal.ts`：按块挂载，保留当前行 / 批注 / 草稿 / 标记行所在块；按行跳转的地方先 `revealRow`；prefab 3.3 万元素 → 1568；Review 文件列表同样；长 diff / 命令输出先显示一部分 + 「显示全部」，`5f65b7a`）；② 对话渲染（Markdown memo + 按 source 缓存解析，Transcript memo，代码块和快速查看上色走 worker `useWorkerHighlight`，回复导航二分 + 每帧一次，会话 Ctrl+F 300ms 一次，批注高亮只在带批注的回复变化时重算，草稿 400ms 防抖，`8315d67`）；③ Host（`store.findItems` / `listUnfinishedItems` 换掉 9 处整会话读取，事件表只留最近 5000 条，文件选择器按码排序 + 旧列表先答 + 递进筛选，`fs/exists` 按文件名索引，书签网络路径不 stat，`d0fdb68`；DSH 的「每片段重写」核实后不成立：DSH 发整块不发 token，没改）；④ 主进程（trace 日志异步写，Focus 鼠标消息日志改为 `AMO_STUDIO_TRACE_INPUT=1` 才开，机器人 33ms 一帧，启动清理异步，屏幕变化防抖，`8144733`）。辅助功能仍关着：查看器已小，但长对话的 DOM 仍大，开回来前要再测。全部改动**等重启**。 再之后（10-21）：Codex 在一轮刚结束时发消息不再报「turn/steer: no active turn to steer」（插话失败就开新一轮）。**已知不稳定**：`nav-history.spec` 第二个测试约 1/6 失败——读到一半的位置在回复结束后被拉到底部（偏 -5776px，每次相同），换回 10-20 的对话区代码同样会挂，不是这批改动带来的；加滚动记录后复现不出，没查到根因（怀疑跟随到底部的 stick 与 ResizeObserver 的时序）。
> - **10-21**：
>   - **「恢复后自动继续」**：所有会话默认打开，不再只限 loop（`a59aed4`）。
>   - **整机卡顿已查清**：现象是输入法慢、鼠标拖拽卡、Studio 主进程卡住 0.5～4 s。
>     - **主因**：Claude Code 2.1.304 的 bashEditDiff。auto 审批模式下，它在每条 Bash 命令前后对整个仓库跑 `git status` / `update-index` / `write-tree`，还绕过仓库自己的 fsmonitor。在 project_mining（5.2 万个文件）里，每次会把整机占到 60%～77%，几乎全是内核时间。
>     - **修复**：`claude-env.ts` 设 `CLAUDE_CODE_BASH_EDIT_DIFF=0`（`38d77da`）。测试会检查 SDK 自带的 claude.exe 是否还认这个开关（`9aebeb0`）。升级 SDK 时如果这个测试报错，说明开关被改名或删了，要重新找关闭办法。
>     - **其他来源**：Fork 自动刷新（用户已关）；fuc `prefab read` 每次并行解析约 2.8 万个 `.meta`，已记为 project_mining 的 FUC-033。
>     - **已排除**：豆包输入法；关闭页面无障碍信息（这项设置保留为默认关闭）。
>   - **卡顿日志**：
>     - 主进程卡顿 ≥0.5 s 写入 `.data/logs/resize-trace.log`，每条带无障碍信息状态和当时有焦点的窗口；另有每分钟一行，汇总 ≥0.1 s 的卡顿（`f5031d8`）。
>     - Host 卡顿写入 `host.log`（`4811e54`）。
>     - `AMO_STUDIO_TRACE_STALLS=1` 时，卡顿 ≥1 s 会抓 JS profile 和 Chromium trace：最多 5 分钟一次，保留最近 4 份（`3262f86` / `7dc8ce1`）。现在没有开。
>   - **以后再卡的查法**：每秒记录各进程 CPU（脚本在 project_mining 的 `AIWork/active/long-term/cli-tools-iteration/artifacts/2026-10-21-studio-lag/cpu-watch.ps1`），找峰值进程，再看它的父进程。很可能是 claude.exe 或 codex 起的子进程。
>   - **当前运行状态**：Studio 14:57 起按默认设置运行（不带环境变量）。
>   - **Focus 一轮（傍晚，纯界面，用户让先别重启，Ctrl+R 或下次重启生效）**：
>     - 用户说「要了几次权限、切过去没事」：查库发现没有审批，是 Claude 主会话派出后台子 agent 后自己先空闲，Focus 每次都算「完成待审核」叫一次（子 agent 回报时主会话还会起一两秒的短回合）。现在主会话下还有子 agent 在跑就不算回复完；最后一个子 agent 结束算作会话有变化（`lib/sessionSeen.ts` 的 `unseenSessions` / `subsByParent`）。
>     - 进行中按用户选的**方案 D**（Docs 效果图 https://claude.ai/artifact/147s1TWVcwzG97XFKAyGZW ）：主会话空闲在等子 agent 时空心圆点 +「等子 agent」，「▸ N」展开每个在跑的子 agent（名字、已跑多久，点开子会话），展开记在 localStorage `amo.focusSubsOpen`（`focus/FocusWorking.tsx`、`focus/pins.ts`）。
>     - **置顶**：Focus 条目悬停出现图钉，按任务置顶（localStorage `amo.focusPinned`），置顶的显示任务最新的非子 agent 会话，排最上、详情一直展开、带「取消置顶」，别处不再重复列。「排在上面」按 Focus 自己的列表理解、「永久展示」只对置顶的，用户没反对。
>     - **确认类跳转都给「按 ↑ 回到本轮回复开始」**：打开会话时它在等人或回复完没看过（`awaitsPerson`），或 Focus 刚为它跳过来（Focus 里点开就算看过了，所以 Focus 跳之前写 localStorage `amo.focusJump`，工作台打开后清掉，`lib/focusJump.ts`）；后退还原位置、书签段落不给。`useTurnStartHint` 多了 `arrived` / `loaded`。
>     - 晚上已按用户要求重启（备份 `.data/backup-before-focus-pins-20261021`）。
>   - **维护终端改成「就是你自己的终端」**（用户定的）：在工程根目录开 PowerShell，直接运行用户自己的 `claude`（PATH 上的，没有才用 SDK 自带的），不再选模型、不带渠道的网址 / 密钥 / Studio 的 `CLAUDE_CODE_*` 设置；`freshTerminal`（Claude、Codex）和 `CodexServerManager.terminal` 都删了。原因：Studio 若是被某个 Claude 会话重启的，就继承了它的 `CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION` 等标记，维护终端原样传下去，新的 claude 以为自己是子会话，提示 "Transcript saving is off"；加上 Studio 给的 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`，那个会话里也没有 Artifact 工具（推断，没法在会话内证实）。现在终端的环境去掉所有 `CLAUDE*`、`ANTHROPIC_*`（用户注册表里没有自己设的这类变量）。改了 Host，**等重启**。帮用户重启时用 Start-Process 也会把当前 Claude 会话的这些变量带进 Studio，SDK 会话不受影响（`claudeEnv` 本来就过滤），只有维护终端受过影响。
>     - e2e `focus-subagents.spec.ts`（`[[spawn-bg: …[[shell: ping …]]]]` + 全部允许，让子 agent 跑一会儿）。顺带发现：新会话开始前会空闲一瞬，Focus 会短暂多一条「完成待审核」（旧行为，没改；测试要等到回复出来）。
  - **agent 进程降一档优先级**（晚上，用户要的）：Claude Code（SDK 的 `spawnClaudeCodeProcess`，`runtime/priority.ts` 的 `spawnClaudeProcess`，命令、管道、abort 信号同 SDK 自己的启动）、Codex app-server、DSH 启动后设 below normal，Windows 上它们起的 git / 构建 / Bash 命令跟着继承（单测验证了继承）。自己启动就拿不到 SDK 收集的 stderr 结尾，所以 Claude 非 0 退出时把 stderr 结尾写进 host.log。`AMO_STUDIO_AGENT_PRIORITY=normal` 可关。维护终端、「交给终端」不降。改了 Host，**等重启**。
  - **改渠道的型号列表后，对话和设置里的型号不跟着变**（10-22 用户报的，DSH 渠道）：界面的型号缓存（`lib/choices.ts`）只在 `modelPrefs` 变化时清，改渠道发的是 `profiles.updated`；现在收到它也清，所有选择器重新问。Codex 渠道 Host 端的 10 分钟缓存键加上渠道的固定型号。e2e 在 `model-channels.spec.ts` 的 DSH 那条末尾（没修时会挂）。界面部分 Ctrl+R 生效，Codex 那处要重启 Host。
  - **Focus 拖不动**（10-22 用户报的）：resize-trace 里从 10-21 19:30 起每次按下都是「click given back」——Windows 发 WM_MOUSEACTIVATE，Chromium 对不能激活的无边框窗口答 MA_NOACTIVATEANDEAT，按下被吞；点击能补回，拖动补不回。吞不吞按启动而不同（10-19 15:02、10-21 14:57 几乎不吞，10-18、10-21 晚上起几乎全吞），和代码改动对不上，触发条件没查清。修法：「移动位置」期间 `setFocusable(true)`（`amo:focus-moving`），完成后改回、`blur()` 交还焦点、`setSkipTaskbar(true)`。标题栏直接拖（非移动模式）仍受影响，没改。改了主进程，**等重启后让用户实测**。
  - **start-studio 不再随手 npm ci**（10-26 第二次出事）：18:03 重启时 `node_modules\.amo-lock.sha256` 又不见了（16:34 还在，被什么删掉的没查到，package-lock 没变），脚本跑 `npm ci`，被便签占着的 `electron\dist\dxil.dll` 卡住，node_modules 删到只剩 27 项。修了 `start-studio.ps1`：已经装过（有 node_modules\electron）就用 `npm install` 原地补齐，只有 `-Install` 或全新时才 `npm ci`；装完缺 electron.exe 就跑它的 install.js。这次用 `npm install` + electron install.js 恢复，写回标记，18:08 启动成功，数据不变（任务 36 / 会话 135）。
  - **Focus：审核完的条目不再被「展开着」留住**（10-26 用户第二次报的）：16:45 点「在工作台打开」时主窗口本来就停在那个会话上，拉到前台拿到焦点就算看过了；但 Focus 的 `held`（展开着的已看过条目留着，配合以前「点开算看过」写的）让它继续显示 30 分钟，17:16 点标题收起它就没了。去掉 `held`：看过就立刻移走。另：17:16 起 Focus 的按下又开始被吞（click given back），这次运行 16:34 启动，约 40 分钟后开始。纯界面，Focus 关掉再开或重启生效。
  - **@ 的「AMO 扩展功能」+ 提交并拉取 + 子会话设置页改版**（10-26 晚，用户要的）：
    - 原因：用户写的 Dxx-DS 说明存到了「DeepSeek」(`dsh-deepseek`) 渠道下（两个下拉框，渠道默认选第一个），@子会话 选 Dxx-DS 时对不上。已经用 API 把那条挪到 `ch-f28afeea`（Dxx-DS）。
    - 设置页 `SubsessionPage.tsx` 改成每个渠道一块、型号做成按钮（「整个渠道」+ 非默认型号），点一下在下面写，清空即删，没有下拉框。`model: null` 的含义改成**整个渠道**（所有型号适用，某型号另写时以那条为准）：开子会话弹窗先找型号自己的说明，再找渠道的；`role.ts` 里写成「X 的所有型号（model: "X" 是它的默认型号…）」。
    - @ 菜单：「找文件…」留在文件下面，最后单独一组「AMO 扩展功能」：开子会话…、**快速提交**（用户定的名字；同一晚先叫过「提交并拉取」；用户要求入口只有这一个，推送与否只在弹窗里确认）。选它或在会话页按 **Ctrl+Shift+P**（原来没人用；Ctrl+P 是找文件）弹 `attach/QuickCommitDialog.tsx`，两种方式、每次默认第一种：1 提交 + 拉取合并，2 再加推送（↑↓ / 1 / 2 / 回车）。确定后在输入框放「@快速提交」（只有这一个名字，选的方式记在 pick 里），`MentionPick` `{ kind: "commit", push }`，发出去时附 `quickCommitBrief(push)`：按内容分多条 commit、拿不准先问、`git pull --no-rebase`、冲突列出两边和建议后问人、推送只在第 2 种且不许 --force、不用丢改动的命令、做完报告。`withMentionRefs` 改成按完整名字匹配（像「@快速提交吧」这种更长的名字不再同时算成「@快速提交」）。所有没归档、能写的会话都有它。
    - 单测 `mentions.test.ts`、`subsession-notes.test.ts`，e2e `attachments.spec.ts` 三条（截图 `S11-B-05-at-menu.png`、`S18-subsession-settings.png`、`S18-quick-commit.png`）。只改了 UI 和 role.ts 的文字，Host 部分**等重启**。
  - **设置 → 子会话**（10-26，用户要的）：每个模型（渠道 + 型号，型号空 = 默认）可写一段「作为子会话的用法」，给主模型看。存 Host 设置 `StudioSettings.subsessionNotes`（kv `settings:subsession-notes`，最多 30 条、每条 1000 字，空的去掉，同一模型只留第一条）。主模型在两处读到：身份说明（`role.ts`，子 agent 之外的角色都有，「人写的模型用法 … model 照括号里的写」，改了会经 roleUpdate 告诉会话）；@ 开子会话 选了这个模型时，消息里「人对这个模型的说明：…」。页面 `settings/SubsessionPage.tsx`（选渠道和型号 → 添加说明，离开输入框时保存）。顺带：子会话弹窗**不再记住上次的思考强度**，每次从 设置 → 模型 的默认开始（用户问是否一致：强度条的默认本来就是那个默认，只有「记住上次」这一处不同）。单测 `guide/subsession-notes.test.ts`，e2e 在 `attachments.spec.ts` 开子会话那条，截图 `S18-subsession-settings.png`。改了 Host，**等重启**。
  - **DSH 沙箱权限：确认 + 恢复**（10-26，用户要的）：只读查过，设过权限的项目根目录都带 Low 标签（survivor_io、`E:\TOOLS\AMO` 公共空间、BlockIsland、MobileGameDemo、REA_Planet、WorldOfWarcraft、project_mining / _dev / _dev2、survivorace；EdgeInterface 已归档，只有 S-1-4 条目），之后在里面新生成的 exe 会低权限运行。设置 → 项目与目录 → DSH 沙箱权限：「设置权限」先弹确认（说清这个后果）；已设置或带标签的项目多了「恢复原来的权限」（确认后：先 `/save` 现在的权限到 acl-backup `…-before-revert-…acl`，用 Windows PowerShell 5 的 .NET 删掉 `S-1-4-*` 条目（icacls 认不出），有 grant 备份时 `/remove:g` 账户的完全控制，标签设 `(OI)(CI)medium`，清掉 `dsh-folder:` 记录）。真实目录验证过（S-1-4 条目和 Low 都没了，子目录跟着变）。注意备份文件名是整条路径，备份目录太深会超 260 字符。之后在这项目里用 DSH「工作区可写」时 DSH 会再加回来。哪些项目要恢复由用户自己点。
  - **task_plan_propose 也能设型号和强度**（10-26）：每个任务 `model` 支持「渠道/型号」、新 `effort`，和 session_start 共用 `SessionsFeature.modelByRef` / `effortFor`（原 peerModel/peerEffort）；`PlannedTask.options`；人确认时换了账号就丢掉 options；开会话带上。提案卡片显示「型号 … · 思考强度 …」。`propose` 变成 async。
  - **DSH 会话发图片**（10-26）：DSH 只在 initialize 时按它的 ACP agent 默认型号报 `promptCapabilities.image`，所以 Studio 起 DSH 进程时用 `--patch`（`patches/model-<型号>.yml`，`modelPatchYaml`）把会话选的型号设成 ACP 默认，记下能力（`Live.images`、`Live.model`）。发图片时（`takesImages`）：会话换过型号、且不在一轮中间 → 用新型号重起进程再判断；不收图 → 报「<型号名> 不收图片…换成能看图的型号，例如 DeepSeek-V4.1-Flash」，什么都不显示也不排队。图片按 ACP 的 `{ type: "image", mimeType, data: base64 }` 发；排队的消息带着图片（`takeQueue` 合并文字和图片）；用户消息行带 `images`（同 Claude）。新任务第一句带图也走这条路（去掉了 tasks/service 里对 DSH 的拦截）。渠道自己的型号表（catalogPatch）优先，那些型号 DSH 目录里没声明图片，所以不收。假 DSH（testkit `fake-acp-agent`）多了 `deepseek-flash`（DeepSeek-V4.1-Flash，能收图），按 `--patch` 的 acp 默认报能力、回复「[N 张图 mime]」。真 DeepSeek 发图还没实测（要 Key），重启后用 V4.1-Flash 发一张试。改了 Host，**等重启**。
  - **DSH 来源**（10-26，用户定的）：kv `settings:dsh-source`（`auto` 默认 / `clone`）。`auto` = 装了桌面版就用桌面版（`%LOCALAPPDATA%\Programs\DeepSeek Harness`，`AMO_STUDIO_DSH_DESKTOP` 可改，空串 = 没有），没有就退回源码克隆；`clone` = 只用克隆。桌面版的启动和它自带的 `dsh.cmd` 一样：`DeepSeek Harness.exe --expose-internals <app.asar>\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js --profile acp`，环境加 `ELECTRON_RUN_AS_NODE=1`；版本按 exe 修改时间缓存（问一次约 150ms）。全部在 `runtime/dsh/install.ts` 的 `resolveDsh`（spawn、检查、不可用原因都走它）。实测桌面版和克隆共用 AMO 的 DSH_HOME 没问题（能列出同样的 25 个会话，不改 profile 文件）。设置页：来源两个选项；桌面版显示版本和位置，找不到时说在哪找过、可改用源码克隆；克隆的输入框只在用克隆时出现；「检查」检查当前用的那个（`DshCheck.kind`）。`PUT /api/dsh` 收 `{ source }` 或 `{ path }`。e2e 默认 `AMO_STUDIO_DSH_DESKTOP=""`。桌面版 10-26 下午已自己更新到 0.2.1-rc.3。没测过：桌面版自动更新时 AMO 的 DSH 进程会怎样。改了 Host，**等重启**。
  - **DSH 调查 + 权限事故**（10-26）：本机三份 DSH——源码克隆 `G:\PROJECT\deepseek-harness`（0.2.1-rc.2，AMO 一直用这份）、桌面版 `%LOCALAPPDATA%\Programs\DeepSeek Harness`（0.2.0-rc.2，nightly 自动更新，自带 `resources
untime\cliin\dsh.cmd`，实测支持 `--profile acp`；那个 cmd 用 `DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1 --expose-internals …\dsh-desktop-host\lib\cli.js`）、npm 全局 0.1.6-alpha.2（AMO 没用过，用户同意已卸载）。**用户定的**：DSH 来源默认自动找桌面版，找不到给说明，可手动指定源码克隆。图片：DSH 型号目录里 `deepseek-flash`（V4.1-Flash）声明能收图，`deepseek-v4-pro` 没声明；ACP 模式默认型号是旧名 `deepseek-v4-flash`（不在目录里）所以 initialize 报 `image:false`，用 `--patch` 把 acp 的 model 设成 `deepseek-flash` 后实测 `image:true`——下一步按会话型号设默认型号、读 `promptCapabilities.image`、发 ACP image 块。运行中插话：DSH 原生默认「排队」，AMO 一致；「steer」ACP 没有。在终端打开可用 `dsh tui --resume`。**事故**：重启时 `start-studio.cmd` 因 `node_modules\.amo-lock.sha256` 不存在跑了 `npm ci`，删到一半（electron 被占用）→ `npm install` + electron `install.js` 补回，标记文件已写；新 electron 继承仓库根目录 DSH 沙箱设的 Low 完整性标签，一启动就退出码 3（无输出）。用户让把 `G:\PROJECT\AgentMonitorOverlay` 权限改回 AMO 之前：删了 `S-1-4-880769674-…` 和账户完全控制（.NET 删，icacls 认不出 S-1-4 SID），标签改 Medium；改前存在 `.data/dsh/acl-backup/…-before-revert-20261026.acl`。用户也把 AMO 工程从 AMO 的项目里移除了。另：从我的会话后台起的开发版会随会话结束被关掉，要用 `cmd /c start` 独立启动（且我的命令沙箱里 Electron 起不来，要关沙箱）。
  - **@ 开子会话…**（10-26 用户要的）：输入框 @ 菜单「找文件…」上面多一项（只有任务里的主会话/分支会话有），弹窗选模型（复用 `ModelRow`，含全部型号）、思考强度（`EffortBars`）、权限（默认/只读/可写/完全放开）、结果是否回到这个对话；确定后输入框插入「@子会话N」，发送时消息末尾补「子会话的开法（要开时用 AMO 的 session_start，不要用你自带的子 agent…）：- @子会话1：session_start 带 model…」。用法是**一套设置**，不是马上开：用户写「接下来你开子会话就用 @子会话1」。上次的设置记在 localStorage `amo.subsessionSetup`。Host `session_start` 的 `model` 同时支持「渠道/型号」和直接写型号名（`peerModel`），强度按那个型号校验。文件 `attach/SubSessionDialog.tsx`、`attach/mentions.ts`（`subSessionArgs`、`nextSubSessionName`）。单测 + e2e `attachments.spec.ts` 末条，截图 `screenshots/stage-18/S18-subsession-dialog.png`。
  - **session_start 能设思考强度**（10-26，agent 反馈开会话时设不了）：MCP `session_start` 加 `effort`；Host `startPeer` 按新会话实际会跑的模型（设置 → 模型的默认，否则 CLI 默认）查它的强度列表，大小写不敏感，不在列表里就报错并列出能用的值；CLI 不认识强度的模型（第三方，列表为空）直接拒绝，和工作台一致；拿不到列表时不校验。返回值多了 `effort`，amo_guide 里补了一句。单测 `peer.test.ts`。`task_plan_propose` 仍没有 effort。改了 Host，**等重启**。
  - **进行中 ⇄ 待审阅自动走**（10-26 用户要的，Studio 自己挪卡片，不是 agent）：Host `TasksFeature.watchColumns()`（`service.ts` 构造时挂上，和 `watchReports` 同一挂法）。任务里某个会话从「在推进」变成「停了」，且本任务所有会话都停了，等 4 秒（`reviewSettleMs`，一轮接一轮时不来回跳）再确认一次，进行中 → 待审阅；待审阅里有会话重新开始推进（你再发消息），→ 进行中。「在推进」= `sessionMoving`：running、轮中等你批准/回答、有 /loop 或额度重置后会自己继续（`wake`）、交给终端/终端共用；归档的不算。只看会话状态的**变化**，所以你手动挪的卡片在下次有会话开始/停下前不动；待办、完成、调度任务不碰；Host 启动时不扫。`TASK_COLUMNS` 注释改了。单测 `features/tasks/columns.test.ts`（假 Codex 跑真实轮次）；e2e 看板/任务相关 9 个文件 31 条通过。改了 Host，**等重启**。
  - **Focus 标题栏又拖不动**（10-26 用户报的，开发版从 10-25 01:35 一直跑着）：日志里 10-25 03:07 的按下还正常，08:46（隔了一夜没人用）起每次都是「click given back」，所以**吞不吞是在一次运行中途变的**，不是按启动定（10-21 那次也是 14:57 启动、19:11 起吞）。触发条件仍没查清；现场查过 Focus 的窗口样式（NOACTIVATE + TOPMOST 都在，没被改掉）。用户一直是直接拖标题栏，「移动位置」从没用过（日志里没有 moving on）。修法（`letTitleDragsMove`，逻辑在 `focus-clicks.ts` 的 `CaptionDrag`）：标题栏左键按下带来的 WM_MOUSEACTIVATE（HTCAPTION）在 Chromium 回答之前就到了主进程的钩子，当场 `setFocusable(true)`，Chromium 就答 MA_ACTIVATE 不吞，Windows 自己的拖动照常；WM_EXITSIZEMOVE（或 3 秒内没开始拖）后改回不可激活、`blur()` 交还焦点、不进任务栏（和「移动位置」共用 `setFocusActivatable`）。「移动位置」开着时不重复做。trace 记「title drag: may activate / done」。代价：拖动期间 Focus 会短暂拿到前台。单测 + e2e（`focus.spec.ts` 用 `__amoFocusCaption` 驱动）通过。改了主进程，**等重启后让用户实测**。
  - **任务页会话树能折叠**（10-22 用户要的）：下面挂着子 agent / 分支的会话，行右端「▾ N」/「▸ N」（N = 下面所有层的会话数），收起时里面有等你处理或出错的就变醒目色；默认展开，按会话记在 localStorage `amo.sessionTreeFolded`；选中折叠里的会话（对话里「查看」、Focus、搜索）自动展开到它。`useStoredIds` 从 `focus/pins.ts` 挪到 `lib/storedIds.ts` 共用。e2e `taskpage.spec.ts`。全量 e2e 139/140，便签那条单独重跑通过（失败时正好在重启开发版）。
  - **Focus 置顶收成一行**（10-22 用户要的）：平时只显示状态（进行中 / 等子 agent / 完成待审核 / 空闲 · 说明），只有等审批、等回答、计划待审阅时展开详情；去掉「取消置顶」大按钮和置顶里的「我知道了」（完成待审核点行去工作台看）。置顶的任务所有会话都不再出现在「进行中」；置顶显示的会话先挑等你的，再挑在跑的，再挑最新的（`pins.ts` 的 `pinnedSession`）。纯界面，Ctrl+R 生效。
  - **Focus 历史也能置顶**（10-22 用户要的）：每条历史右边同一个图钉（悬停出现，任务已置顶时常亮、再点取消），会话或任务已不在 / 已归档的不给。e2e `focus-history.spec.ts`。纯界面，Ctrl+R 生效。
  - **发了 Portable 0.9.0**（10-22 用户要的）：版本号 0.8.0 → 0.9.0（`8739625`）；verify 单测只有已知的 4 条不稳定（server-manager 端口 ×3、dsh 加载超时，单独重跑通过），全量 e2e 140/140；`release/AMO-Studio-0.9.0-portable.zip`（292 MB，解压 657 MB）。冒烟脚本跟着新建任务页改成点模型卡片（原来找 `<select>`），冒烟通过。没推送、没打 tag。
  - **「完成」列右键一键归档**（10-22 用户要的，发版之后做的，不在 0.9.0 里）：在「完成」列上右键 →「归档全部已完成（N）」（N = 当前范围看板上这一列的卡片）；在这一列的专题分组上（组头或组里的卡片）右键还多一项「归档「专题」这一组（n）」。不弹确认，逐个调 `POST /api/tasks/:id/archive`（任务和会话一起归档，「已归档」里能打开、恢复）。别的列没有这个菜单。`board/Board.tsx`（`onArchive`、`PopMenu`）、`board/view.tsx`；e2e `board.spec.ts`，截图 `S18-board-archive-done.png`。纯界面，Ctrl+R 生效。
  - **画布上归档任务的卡片不再消失**（10-22 用户报的：归档后卡片没了、只剩连线）：画布原来只按专题里未归档的任务找卡片。现在专题里已归档的任务照样画卡片（`CanvasPage.tsx` 的 `cardTaskById`；离开专题的任务仍不画），灰底虚线框、标题前「已归档」、元信息是「项目 · 多久前归档」（`cards.tsx`、`canvas.css` `.is-archived` / `.archived-mark`）；右键菜单只剩颜色、打开任务（只读）、分组、居中、从画布上拿掉；不能当连依赖的目标；侧栏详情是只读的简版（`CanvasSidebar.tsx`）。旧测试 `canvas-refs.spec.ts`、`search-archive.spec.ts` 原来断言卡片消失，已改；新 e2e 在 `canvas.spec.ts` 末尾，截图 `S18-canvas-archived-card.png`。纯界面，Ctrl+R 生效。
  - **书签窗口的显示范围**（10-22 用户要的）：标题栏下一行「当前专题 / 当前项目 / 全部」（`marks/logic.ts` 的 `scopedGroups`、`scopesFor`、`scopeKey`；`MarksApp.tsx` 的 `useScope`）。当前专题只显示前面的专题（任务没专题就是未归专题）；当前项目只显示这个项目里的书签，按专题分组、不显示空组；全部同以前。**每个任务记住自己的选择**：书签窗口地址加了 `task=`（`marks-window.ts` 主进程的 `marksHash`、preload、`App.tsx`、`TaskPage.tsx`、`SessionHead.tsx`），选择存 localStorage `amo.marksScope`（键 `task:<id>`，没任务时按专题/项目，最多 300 条），没选过是「全部」；从看板顶栏打开（没专题没项目）只有「全部」可选。e2e `marks.spec.ts` 末尾，截图 `S18-marks-scope.png`。**改了主进程，重启后才带得上任务**。
  - **维护终端的颜色和状态栏**（10-22 用户报的：维护终端里的 claude 和手动开的显示不一样）：开发版是我从 Claude Code 的工具 shell 里重启的，继承了 `NO_COLOR=1`、`COLOR=0`、`TERM=xterm-256color`（用户系统里都没设），再传给维护终端。`maintenance/service.ts` 的 `NOT_PASSED_ON` 加上 `NO_COLOR|FORCE_COLOR|COLOR|CLICOLOR|CLICOLOR_FORCE|TERM`，单测覆盖；重启步骤也加了这几个。另外用户的 `~/.claude/settings.json` 从 10-20 16:34 起没有 `statusLine` 了（不是 Studio 写的；7 月的 `settings.json.bak` 里有），用户确认后加回，命令用本机全局装的 `ccstatusline`（2.2.7，`%APPDATA%
  - **Review 快捷键**（10-22 用户要的）：w / s 当前文件上下翻一页（`.gr-scroll` 滚一屏少 60px），a 只看改动、d 完整文件（`ReviewApp.tsx` 的键盘处理）；历史列表（h 打开时）空格同回车（`CommitPicker.tsx`，搜索框里的空格仍是分词）。按钮上用小 `kbd` 标出 h / a / d（`ReviewHead.tsx`、`.gr-key`），文件列表下的提示行加上 w / s、a、d。e2e `review-history.spec.ts` 的 keys 那条，截图 `S18-review-keys.png`。纯界面，Ctrl+R 生效。
  - **会话能在自己任务里开会话**（10-22 用户要的，MCP 工具 `session_start`「开会话」）：用户定的——直接开不用确认；任务里的主会话、分支都能用（子 agent、专题会话不行）；挂哪/要不要回报按情况由 agent 定，所以做成参数 `report`。参数 text、model（默认发起者的型号，`HostService.profileByRef` 从拆任务挪来共用）、title、report。新会话是同任务的普通主会话（没挂在发起者下面：要挂得加字段），第一句话带「【由本任务的会话「X」开启】」和怎么回话。`report: true` 时监听 `session.upserted`，新会话第一轮结束（空闲/完成/出错，不算等人）就把最后回复（≤4000 字）作为消息送进发起者的对话（忙时排队），发不进去就留言；只在内存里记，Host 重启会丢。`features/sessions/service.ts` 的 `startPeer`，`sessions/mcp.ts`，`AmoTool.run` 可返回 Promise（`writeAsync`），`AUTO_APPROVED_WRITE_TOOLS` 加上它，指南 collab 和「执行」角色卡各加一句。单测 `sessions/peer.test.ts`，e2e `session-start.spec.ts`（Claude、Codex 各一条），截图 `S18-session-start.png`。改了 Host，重启后生效。
  - **今天的卡顿和 agent 再降一档**（10-22）：子 agent 查了 resize-trace：16:02–16:05 主进程卡 22 次（共约 35 s，最长 7.7 s），是 Studio 里一个 agent 的 `xargs -P 12` + `grep -r` 进程风暴叠上我在维护终端里跑的全量 vitest（Normal、约 23 个 worker）；e2e、打包本身几乎不卡。BelowNormal 只管 CPU，不管磁盘和内核。用户要的三件：①`runtime/priority.ts` 的 `lowerAgentIo`：agent 进程（Claude/Codex/DSH，都经 `lowerAgentPriority`）的 I/O 优先级设 Low（ProcessIoPriority 33 = 1）、内存优先级设 Low（ProcessPagePriority 39 = 2），经隐藏的 PowerShell 调 ntdll（约 0.4 s，启动后异步）；实测子进程都继承。单测验证 agent 和它之后起的子进程都是 [1,2]；旧的「没降的子进程是 Normal」改成和测试进程自己比（测试本身可能被降了）。②`mcp/tools.ts` 的 MCP 说明加一段：别一次起很多进程、用 rg/git grep 限定目录、测试 runner 限并发。③火绒排除目录：用户在火绒界面里自己加（不替安全软件改配置），清单在对话里给了。我自己的重任务改为 BelowNormal + `--maxWorkers`（记忆 heavy-jobs-low-priority）。改了 Host，重启后生效。
  - **TaskStop 停掉的后台子 agent 一直显示进行中**（10-22 用户报的，task-6aee397f：额度快爆了让主会话停掉子 agent，任务仍显示进行中，重启才变空闲）：主会话用 TaskStop 停了 3 个后台 agent，CLI 回「Successfully stopped」，但 SDK 不一定发 `task_notification`（有一个根本没发），`task_updated` 的 `killed` 原来只用来结束后台命令。改：`messages.ts` 里 `task_updated` 结束（completed/failed/killed）也结束子 agent 会话，TaskStop 调用成功时按它的 task_id 结束对应子 agent（`subagents.ts` 的 `settled` / `onStopped`，停的算空闲）。mock 加 `[[spawn-bg-stop: …]]`（TaskStop 在 CLI 2.1.x 是延迟工具，mock 先 ToolSearch 再 TaskStop）和子 agent 的 `[[slow]]`；集成测试 `claude-runtime.integration.test.ts`，没修时超时、修后 1.7 s 变空闲。改了 Host，重启后生效（当时那 3 个会话已在 17:03 的重启里变成空闲）。
pm`，用户说本机没装就不管，不走 npx），padding 0，改前备份 `~/.claude/settings.json.bak-before-statusline-20261022`。改了 Host，重启后生效；维护终端要重新打开。
  - **git 扫描实测**（project_mining 5.2 万文件，`git status` 每次）：fsmonitor 开 245 ms、整机几乎不加负载；关 fsmonitor（bashEditDiff 的做法）683 ms、多占约 11.5 个核、内核 22%；关 fsmonitor + `core.preloadIndex=false` 858 ms、几乎不加负载。所以将来要重开 bashEditDiff，可以给 agent 注入 `GIT_CONFIG_COUNT` 设 `core.preloadIndex=false`。project_mining 本来就开着 fsmonitor 和 untrackedCache；用户同意后给 `project_mining_dev`、`project_mining_dev2` 开了 `core.fsmonitor`（只改它们自己的 `.git/config`）。
> - S15-L（10-16）：Claude 的 /loop 和订阅额度上限——有 loop 唤醒或在等额度时不关进程，额度恢复后 CLI 没续上由 Studio 补一条；输入框上方的条和会话列表的「loop · 时间」「等额度 · 时间」；用 SendMessage 恢复的子 agent 找回子会话（迁移 13）。**待确认**：下次真碰到额度上限后看 host.log 的「went on after its usage limit (turn started by cli|studio|person)」，判断 SDK 模式下 CLI 会不会自己续。
> - Review（10-16）：l / ; 在改动间跳，h 打开历史（j / k 选）；历史打开从 ~340ms 到 ~50ms（每次起 git 进程在这台机器上要 ~100ms：历史接口一轮 git、窗口打开后预读）。
> - S16-A：子 agent 在主控空闲时发起的审批，批准后会话不再停在「等你批准」；Focus「我知道了」；设置里「默认项目」换成「默认路径」（选文件夹从这里开始）。
> - S16-R 重构（行为不变，完整 e2e 109/109）：Claude / Codex runtime 拆成几个部分（`runtime/claude/*`、`runtime/codex/*`，经 `RuntimeCore` 访问 runtime），Codex 改为继承 RuntimeBase；store 拆出 `rows.ts`、`documents.ts`；Thread / TaskPage / Focus / Review / Canvas 拆出子组件。
> - S16-B：任务说明（迁移 14，画布卡片、任务页、侧栏，MCP `task_describe`）；画布颜色标记（红黄绿蓝，MCP `canvas_color`）；画布右键菜单（空白处 / 卡片 / 便签 / 分组 / 连线）、连依赖、全部显示。
> - S16-C：agent 懂 AMO——MCP 服务说明改写、`amo_whoami`（角色卡，Claude 会话的服务说明里也带）、`amo_guide`；任务「主控」标记（迁移 15）；专题文档（画布侧栏「文档」，MCP `topic_docs` / `topic_doc_write`）。
> - S16-D：主控 `task_plan_propose` → 画布 / 主控任务页 / Focus 上的提案 → 人改过后「放进待办」或「立刻开跑」→ 建任务、写说明、按项目分组放上画布、连依赖、留言告诉主控（迁移 16）。
> - S16-E：传话 `relay_send` → 人在任务页或 Focus 确认（或任务设了「主控传话不用确认」）→ 送进目标任务的会话（迁移 17）。
> - **外部打开 Review（10-18 晚）**：别的 harness 在 Studio 开着时打开 Review——`POST /api/review/open`（`features/gitreview/service.ts` 的 `openReview`：按文件夹找项目，没有就登记；ref 在 Host 解析成完整 id；发 `review.open` 事件，主窗口 `App.tsx` 收到后开 Review 窗口；没有窗口连着时 409）和 `studio/amo-review.cmd`（`scripts/amo-review.mjs`，读数据目录的 host.json / host-token）。可传：未提交改动；`--base`（工作区对比它，用「本分支」视图换 base，能批注）；`--commit`、`--range A..B / A...B`（提交窗口换 base，只读）；`--file`、`--session`（发给会话的默认目标，可以是别的项目的会话）。e2e `review-open.spec.ts`，Host 测试 `open-review.test.ts`。
> - **快速选择（10-18 晚）**：行可以拖动排序（或 Alt ↑/↓），去掉了 ↑↓ 按钮；没设置时页面直接列出现在那一排（最近用过的 + 渠道默认，标「自动 · 最近用过的」），拖动、移除、添加后就固定成自己的。用户问「Claude 出现多个」：没设快速选择时那排来自本窗口的最近使用（`localStorage` 的 `amo.recentModels`），同一渠道的不同型号各占一格；另外「默认」和按 id 写的默认型号曾算成两个，现在 `normalPick` 合并（`lib/recents.ts`）。
> - **S18 设置 → 模型（10-18，分支 `studio/s18-models-page`）**：左边渠道列表（「支持的渠道」/「第三方」，第三方用「+ Codex 方案」「+ Claude 方案」添加；然后是「快速选择」「常用预设」），右边是选中渠道的整页：连接（Key、余额、隐藏、Claude 登录方式或 DSH 源码位置）、型号顺序和默认、**这个渠道自己的自动压缩点**（`autoCompactProfiles`，没单独设的用共用值 272k；DSH 显示「自己管理（80%）」）。再打开设置回到上次看的那一项。截图 `screenshots/stage-18/S18-models-*`。
> - **S18（10-18，分支 `studio/s18-ids-links`）**：任务、会话的 id——任务信息行末尾和会话名旁边显示 `#前 8 位`，点一下复制完整 id（`lib/CopyId.tsx`；用户说给别人看、迭代 AMO 时定位问题用）。回复里的文件名：从项目根找不到的相对路径，再在项目的 git 文件列表（tracked + 未忽略的 untracked，缓存 30 秒）里找**唯一**一个以它结尾的文件（`features/chatfiles/service.ts` 的 `findByEnd`），这样「路径相对 UnityProject/…/Simulation/」之后写的 `System/…/X.cs:8`、光写 `X.cs` 都能点开到那一行；多个同名不链接；非 git 项目不找。e2e `ids-links.spec.ts`，截图 `screenshots/stage-18/S18-ids.png`。
> - **主线（10-17 晚）**：用户同意，`studio/main` 快进进 **master** 并推送，旧版 master 打了标签 `amo-legacy-final`；之后在 master（或 `studio/sNN` 分支再合回 master）上开发，开发目录 `G:\PROJECT\AgentMonitorOverlay-studio` 切到 master。旧 AMO 的分支已清理（未合并的先打了 `archive/*` 标签），各工程的旧 Hook 用户自己清。
> - **S17 DSH（10-17 晚，分支 `studio/s17-dsh`）**：DeepSeek 可以走 DSH 原生框架——第三种运行时 `dsh`，模型「DSH · DeepSeek」，用本机的 DSH 源码克隆（`G:\PROJECT\deepseek-harness`，设置 → 模型 → 该卡片里填位置、「检查」）经 ACP 跑；用户会定期拉最新，坏了就照 `plans/stage-17-dsh.md` 的「依赖 DSH 的地方」（都在 `runtime/dsh/install.ts`）适配，真 DeepSeek 的回归是 `AMO_STUDIO_DSH_CLONE=… npx vitest run packages/host/src/runtime/dsh/dsh-real`。试验在 `spikes/RESULTS.md` s17。另外加了 `studio/start-studio.cmd`（换设备：clone → 切 `studio/main` → 双击），已推到 GitHub 的 `studio/main`（用户授权的这一次）。
> - S16-G（10-17 下午）：自动压缩点（设置 → 模型，默认 272k，Claude 用 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`、Codex 用 `model_auto_compact_token_limit`）；Claude 子 agent 的用量记进子会话并显示在子 agent 那一行和会话底部（输出偏少，见计划）；上下文 ≥150k 时输入框上方提醒（Claude 隔 1 小时以上提示缓存过期）。额度分析、DSH 的上下文做法和接入难点都在 `plans/stage-16.md` 的 S16-G。
> - S16-F（10-17 下午）：Codex 会话开对话时把角色卡作为 developer instructions 带上（和 Claude 一样一开始就知道自己是谁）；任务后来进了专题、被引用到别的画布、成了主控、说明改了，下一条发给这个会话的消息末尾附一段「【AMO：你的任务有变化】」（界面上是消息里的小标签「AMO 更新」，悬停看内容）；角色卡写出被哪些画布引用；主控能给引用在自己画布上的任务传话。做法在 `plans/stage-16.md` 的 S16-F。
> - 都在 `studio/main`，10-17 用户让我重启过开发版（重启前的库备份在 `.data/backup-before-s16-20261017`）。重启做法：备份 `.data/studio.db*` → `npm run host:stop` → 开着的窗口会把 Host 再拉起来，所以还要结束开发版的 electron 进程树 → 后台 `npm start` → 用 `/api/state` 确认。没有用户明说就先问。
> - 工作树：10-17 用户同意后删掉了 s13-*、s14-*、s15-*（分支都留着）。`.codex/worktrees/37fe` 和仓库里 `tmp/worktrees/` 下的两个是 Codex 那边的，没动。之后的活在 `AgentMonitorOverlay-s17`（分支 `studio/s17-roles`）。
> - 没做 / 以后：便签「转为任务」；画布多选和对齐；Codex 的额度上限；Focus 里显示等额度的会话；子会话收到子 agent 的条目时更新它的时间。
> - 工具坑：Git Bash 的 heredoc 里写 Python，`\\n` 会变成真的换行——含转义的脚本先用 Write 写成文件再跑。单测 server-manager 的 3 条端口测试在开发版运行时（占着 47940 起的端口）会失败，原版代码一样。

> **2026-10-15 晚更新（下一个会话从这里开始）：S14-W…S14-Z，见 `plans/stage-14.md` 进度表。**
> - S14-AC（10-16）：乱飞桌宠看着被裁切 → 乱飞窗口的形状（setShape）留足抖动和阴影的余量（量不抖的 `.pixel-bot-slot`，宠物 16px、气泡 10px），并在窗口飞到目标屏幕后重设一次形状（窗口在屏幕外时按那里的缩放设的，换到不同缩放的屏会对不上）。要重启 Electron 主进程才生效。
> - S14-AB：Focus 桌宠可选「看书的 Claude 娘」（像素 44×54，`focus/readerGirl.ts`），默认仍是机器人，设置 → 界面「Focus 桌宠」。用户 10-15 晚要求 commit 后 **push 了 `studio/main`**（只这一次授权；仍不合并 master、不发布）。
> - S14-AA（`33aa309`）：浅色机器人 + 深色描边；有事 5 分钟没确认，机器人生气在自己的小窗口里满屏乱飞（`app/src/bot-window.ts`），点它落地并打开那件事；「Focus 设置」→「机器人动作测试」。
> - S14-Z（`68dffc0`）：Focus 点击被吞的原因找到了（WM_MOUSEACTIVATE → Chromium MA_NOACTIVATEANDEAT），主进程补发被吞的点击（`app/src/focus-clicks.ts`）；Focus 只分「N 件事」和「M 个完成待审核」，只有完成待审核时机器人是绿色。要重启 Electron 主进程才生效（先问）。之后若还有点不动，看 resize-trace 里有没有 `click given back`。
> - S14-Y（`f3a50ed`，纯界面）：设置 →「项目与目录」里选默认项目，新建任务 / Ctrl+N 默认选中。
> - S14-X（`ea832a6`，纯界面）：Focus 列出「回复完了」（主窗口没看过的已结束回复）和「出错」，看过的记在 localStorage `amo.sessionSeen`（`lib/sessionSeen.ts`）；对话里一轮结束、开头在视野外时显示「按 ↑ 回到本轮回复开始」（`task/TurnStartHint.tsx`）。
> - S14-W（`8c2786d`，只加日志）：用户说开始对话后闪了几下（像以前拖动的闪），日志里那段时间没有尺寸变化；Focus 按钮真实鼠标点不动，但 PostMessage 发的点击能用（页面正常，问题在系统层鼠标输入）。加了：页面崩溃 / 重载 / 卡住、Focus 的 Windows 鼠标消息和形状、Focus 页面的点击目标、拖动之外 ≥200ms 的长帧、host.log 时间戳；resize-trace 改本地时间。**下一步**：用户重启 Electron 主进程后让他点 Focus 按钮、再遇到闪烁时看 `.data/logs/resize-trace.log` 对应时间。只读查 Focus 窗口状态的 PowerShell 脚本思路：EnumWindows 找 WS_EX_NOACTIVATE 的可见窗口（Focus 的标题被页面改成了「AMO Studio」），GetWindowRgn 看形状，WM_NCHITTEST / WindowFromPoint 看命中。
> - 生效：界面部分 Ctrl+R + Focus 关开；主进程日志要重启 Electron（不停 Host，会话不受影响，仍要先问）；host.log 时间戳等下次重启 Host。

> **2026-10-15 傍晚更新：S14-O 到 S14-V 做完，都在 `studio/main`（最新 `990fbc1`），开发版 16:11 重启过（只差 `990fbc1` 记住位置，是纯界面改动，用户按 Ctrl+R 即可）。** 每项做法见 `plans/stage-14.md` 进度表 S14-O…S14-V。
> - 拖动闪烁已修（S14-R）：Windows 拖动中会提议离谱的小尺寸，被窗口自带最小尺寸弹到 960×600；现在最小尺寸改在 will-resize 里拦。用户试过不再闪。日志 `.data/logs/resize-trace.log` 继续记。
> - 会话列表细线树（S14-P）、批注改成「批注N」引用（S14-Q）、左栏 A + 右侧 R1 + 额度 C（S14-S，设计画布 https://claude.ai/artifact/6XMDSpE7EtqXvUHgZjTaSo ）、会话输入框草稿（S14-T）、界面大小 / 任务页拖动提速 / 画布便签保存（S14-U）、记住位置（S14-V）。
> - 测试：最后一次完整 e2e 98/98（`990fbc1`），单测除已知的 server-manager 端口测试（单独跑通过）外全过。
> - 待用户反馈：任务页拖窗口和拖会话列表是否还卡（看日志里 `#main 任务` 那几行的 resizeEvents 和主进程 burst 的 `/s`）；界面大小在 125% 时看板四列放不下会出横向滚动。
> - 今天的数据库备份都在 `.data/backup-before-*-20261015`（annorefs、nativeframe、resizeguard、navA、uiscale 等），没问题可以以后清理。
> - 阶段 15（agent 懂 AMO、主控提案、传话）只有计划 `plans/stage-15.md`，用户说晚些一起推进。工作树 s13-*、s14-* 仍在，等用户同意再删。验收清单 https://claude.ai/artifact/CsZnNKcuGnjQxX7W1XtVr2 （db `s14`）没跟上 S14-F 之后的改动。
> - 工具坑补充：bash heredoc 里写含引号的 Python 会断（改用 Write 写 scratchpad 的 `.py`）；`;` 串命令时 tsc 失败也会接着 commit（用 `&&`）；新 e2e 按标题找 Focus 窗口不可靠（页面加载后标题会变），用 `webContents.getURL().endsWith("#focus")`。
>
> **2026-10-15 午更新：S14-K 到 S14-N 做完（Focus 窗口形状和「Focus 设置」小框、快速选择、Focus 图标、编辑专题（迁移 12）、拖宽度），开发版最后一次重启在 10:51，之后的 S14-M/N 还没生效，等用户说重启。阶段 15 只出了计划 `plans/stage-15.md`（agent 懂 AMO、主控提案、传话；用户决定都在里面，记忆 `studio-stage15-orchestration`），用户说晚些一起推进，白天自己手动用。会话列表改版的 4 个方案在 https://claude.ai/artifact/4viCheJyoAsxEeFegNHhyJ 等用户挑。**
>
> **2026-10-15 更新：阶段 14 追加 S14-F 到 S14-J，都合进 `studio/main`，开发版还没重启（还是 10-14 23:41 那次的 Host）。** 详细在 `plans/stage-14.md` 进度表。
> - S14-F/G（主会话）：标题下一行项目、分支只显示不能点；左栏、会话列表可收起；返回按钮「‹ + 图标 + 名字」；新建后会话列表默认收起。
> - S14-H（主会话，`17c4e52` 等）：设置 → 模型 改成渠道卡片，用户可加「第三方 Claude」「第三方 Codex」渠道（网址 + Key + 模型，可沿用旧 AMO 的 DXX Key），每个渠道可「隐藏」不出现在模型选择里；余额查询照 CC Switch 的模板（通用 / New API / Sub2API / OpenAI 计费 / DeepSeek / 自定义）；设置新页「额度」选每个账号在左下角、Focus 是否显示。渠道 Key 存凭据管理器 `channel-<id>`（**Studio 现在除了 `claude-subscription` 还会写这些新条目**；旧 AMO 的条目仍只读）。Claude 本机登录的风险说明改成按 Anthropic 帮助中心 2026-06 起的说法（订阅可用于 Agent SDK 和第三方应用）。
> - S14-I（工作树 `s14-sessbar`，`160b072`）：任务头「会话」开关完全隐藏会话列表；会话标题栏重做（更大的图标、git 分支图标）；所有归档操作深红色（`--danger` 系列颜色）。
> - S14-J（工作树 `s14-focus`，`ee467bc`）：Focus 收起/展开改图标；右键菜单（移动位置 / 锁定位置 / 收起 / 打开主窗口 / 隐藏）；有事等人时边框闪动 + 像素机器人跳舞（`focus/PixelBot.tsx`，以后可做桌宠）。
> - **要看到这些需要重启开发版**（S14-H 改了 Host，S14-J 改了 Electron 主进程的 focus-window）：先问用户，按 §1 的步骤，重启前备份 `.data/studio.db*`。
> - 工作树 s13-*、s14-*（现在 8 个：viewer、pad、shell、sessbar、focus 等）都还在，等用户同意再删。
>
> **2026-10-14 深夜更新：阶段 13 验收 22/23 通过（A5 有问题），阶段 14 三条线做完并合进 `studio/main`，等用户重启开发版后验收。** 计划、用户决定和每条线的做法在 `plans/stage-14.md`；记忆 `studio-stage14-decisions`。合并后单测 538/539（失败的是已知不稳定的 server-manager 端口测试，单独跑通过），e2e 82/83（questions 计划审阅在负载下偶发，已加固测试 `4cbb346`，单独跑通过）。
> - S14-A：A5 草稿存在窗口级 `gitreview/drafts.ts`、切换后按锚点滚回（`gitreview/anchor.ts`）；有总览条时隐藏竖向滚动条；Ctrl+F（查看器两种模式 + Review）、Ctrl+G；查看器文件模式按行批注（`GitCommentRange = GitRange | "file"`，查看器地址带 `session=` 作默认发送对象）。
> - S14-B：设置 → 便签：页数、复制时的换行（常规 / 安全换行，默认常规，kv `scratchpadSafeNewlines`）；便签窗口去掉页数、标题加图标；任务页右栏不再显示便签。
> - S14-C：搜索框（Ctrl+K）；置顶开关（存在外壳 `shell-prefs.json`）；任务页 / 新建任务记住来源（`shell/views.ts` 的 `withOrigin`）；归档任务弹框 + 横幅；已归档会话重新设计。
> - S14-D（用户追加，主会话做，`7443458`）：归档项目（迁移 10：`workspaces.archived_at`）和归档专题（左栏右键）；设置 → 数据管理：恢复、彻底删除（只删已归档的，先预览再确认，一个事务删干净；项目文件和 CLI 自己的记录不动）。Host `features/datamgmt/`，事件 `data.purged`。
> - S14-E（用户追加，主会话做，`0617698`）：任务页改版，用户选方案 A + 标题下一行用 A1（纯文字「·」分隔，专题为空显示「—」）；设计画布 https://claude.ai/artifact/XSHzxmAVeqxyqrguVSnRPT 。状态小菜单、专题搜索弹窗（可新建）、编辑项目（名字 + 说明，迁移 11，说明进 project_context）、分支名、侧栏默认隐藏（e2e 默认打开，`launchStudio({ taskSidebar })`）、会话栏一行图标。完整 e2e 跑过一次 80/86，失败的 6 条已修或单独重跑通过（questions 计划审阅改成 toPass 重试滚动）。已按用户要求重启（数据库先备份到 `.data/backup-before-taskhead-20261014`，迁移 11 已在用户数据上跑过）。
> - 开发版已在 10-14 22:44 重启（阶段 14 + S14-D），重启前数据库备份在 `.data/backup-before-archive-20261014`；迁移 10 已在用户数据上跑过。验收清单同一个链接已换成阶段 14（20 条，含 D 组），结果在 db 集合 `s14`。工作树 s13-*、s14-* 都还在，等用户同意再删。
>
> **2026-10-14 晚更新：阶段 13 全部做完并合进 `studio/main`（`79ceaaa`），等用户验收。** 合并后单测 522/522、e2e 78/78 通过。每条线的做法、查明的原因和取舍都在 `plans/stage-13.md` 进度表；截图 `screenshots/stage-13/`。
> - S13-A 查看器：新窗口 `#viewer?…`（`app/src/viewer-window.ts`、`viewer-rules.ts`、`ui/src/viewer/`），文件模式和嵌入的改动模式；对话里单击文件链接打开它，右键菜单含右栏快速查看、用 git diff 看、标记。固定不能撤销；文件改动后不自动刷新。
> - S13-B：闪烁原因是整份文件一次画出来，改成 64 行一块 + `content-visibility: auto`（真窗口拖动需用户确认）；总览条；「历史」选提交，另开只读的提交窗口（`#review?workspace=…&commit=…`，窗口按 项目@提交 区分）。
> - S13-C：GPT Fast（真实 `model/list`：GPT 订阅各型号都有 id `priority`、名字 Fast 的档，说明因型号而异，见 `spikes/RESULTS.md` s13-00）；批注用 CSS Custom Highlight 只高亮选中文字；Focus 慢的真正原因是 Codex 异步提问要等一轮结束才标「等你回答」，现在问题一到就标。
> - 三个工作树 `G:\PROJECT\AgentMonitorOverlay-s13-{viewer,review,chat}` 还在，等用户同意再删。
> - 开发版已按用户要求在 10-14 19:43 重启（Host 和窗口都是阶段 13 的）。验收清单网页同一个链接已换成阶段 13（23 条，每条有「怎么做 / 期望」），结果在 db 集合 `s13`；阶段 12 的结果仍在集合 `results`。
>
> **2026-10-14 傍晚更新：用户验收了阶段 12（27 通过、5 有问题、4 跳过），开始阶段 13。** 计划和用户的决定在 `plans/stage-13.md`。S13-0（Codex `/G:/` 链接点不开、Review 列表可以拖得更宽、标记按钮显示「已标记」并跳到那条）已提交（`8c62308`）。下一步是三条线：S13-A 查看器（独立窗口，没固定的那个被复用，只有点「固定」才保留；对话里单击文件链接打开查看器，右栏快速查看挪进右键菜单）、S13-B Review 补强（竖向调整窗口闪烁、总览条、提交历史）、S13-C 对话（GPT Fast 开关、批注只高亮选中的文字、Focus 响应慢）。阶段 11、12 的工作树已按用户同意删除，分支保留。验收清单网页：https://claude.ai/artifact/CsZnNKcuGnjQxX7W1XtVr2 （结果在它的 db 集合 `results` 里）。
>
> **2026-10-14 更新：阶段 12 全部做完并合进 `studio/main`，等用户验收。** 计划、调查结果、每条线的做法和取舍都在 `plans/stage-12.md`；截图在 `screenshots/stage-12/`。
> - Review：代码按语言变色（Shiki，`lib/highlight.ts`）、目录树（宽度可拖）、左右对照（用户确认"diff 模式"就是它）、VS Code 打开 / 在资源管理器中显示（Host `features/openin/`）。
> - 对话：Claude 提问和计划审阅能回答了（新条目 `question`、状态「等你回答」）；文件路径能点、右侧快速查看、本轮改动的文件；`/` 命令菜单、上下文压缩行和「压缩」按钮、重试和各类提示、后台命令、工具进度和图片、建议的下一句（**默认关**，每轮多一次模型请求）。
> - 文件标记：独立窗口（标题栏「标记」、Ctrl+Shift+M），`@ 标记的文件`、拖进输入框，迁移 9；agent 可用 MCP `list_file_marks` 读。
> - 标题栏：标记 / 便签 / Focus（图标）在标题行；看板·画布切换和「+ 新任务」在下一行；设置在左栏底部。
> - 顺带修了：Claude 会话的权限模式（只做计划 / 自动接受编辑 / 全部允许）以前要中途切换一次才生效。
> - 五条线在工作树 `G:\PROJECT\AgentMonitorOverlay-s12-{review,questions,chatfiles,marks,cli}` 里并行开发，分支 `studio/s12-*` 保留。阶段 11 的四个工作树也还在，等用户同意再删。
> - 用户数据迁移前备份在 `.data/backup-before-stage12-20261014/`。
> - 撤销某一轮的文件改动：用户 2026-10-14 决定**不做**（平时很少用）。
> - 等用户的：跨窗口真实拖动标记要手动试一次（用户 2026-10-14 开始验收阶段 12）；Codex 的提问只在 Codex 计划协作模式下出现，Studio 没开这个模式。
> - 之后追加 S12-F：Review 提速（diff 一次 git 调用、读过的留着、预读、高亮挪进 Web Worker）和 Fork 样式的文件列表（整条路径、彩色状态方块、文件类型图标，平铺为默认）。详见 `plans/stage-12.md` 进度表。
> - 再追加 S12-G：Codex 的异步提问（`request_user_input_async`，模型目录 `send_user_message_async` 打开）显示成卡片，回答作为下一条消息；崩溃隔离（Host 兜底不退出、会话内错误提示、外壳自动重启 Host、窗口崩溃自动重载、界面错误边界）。**不要在用户使用时重启开发版**：`host:stop` 会停掉正在跑的会话。
> - 又追加 S12-H（决策卡放进会话、对话上方）和 S12-I（设置分页；模型页里 Claude 订阅可选「令牌」或「本机 Claude Code 的登录」，后者要先确认风险，每个会话记住开始时的方式）。
> - 再追加 S12-J 到 S12-N（用户 2026-10-14 的九条反馈）：Claude 额度按 /api/oauth/usage 查（只有本机登录能查，setup-token 没权限）并显示重置倒计时；型号顺序和默认；显示具体型号名；提问卡改弹窗；通用浮动提示 `lib/toast.tsx`；已归档任务入口；速率按 DSH 的方式；Claude 改用 Claude Code 自己的系统提示词（Studio 专属提示词按用户要求撤回，两边都用各自 CLI 的常规方式）；批注气泡。
> - S12-O：Claude 会话改成和终端一样加载 CLAUDE.md、settings、hooks、命令和 skills（`settingSources` 三项都开）；工程里没有 CLAUDE.md 但有 AGENTS.md 时，把 AGENTS.md 加到系统提示词后面（`project-instructions.ts`）。

> **2026-10-13 深夜更新：阶段 11 的六项都做完并合进 `studio/main`，等用户验收。** 计划、用户的决定和每项的做法、取舍都在 `plans/stage-11.md`；截图在 `screenshots/stage-11/`。
> - 画布：引用卡片、每个任务可选是否上画布（**行为变化**：看板里建的专题任务不再自动出现在画布上）、从画布进出返回画布、空分组删不掉的 bug（原因是画布里有已归档任务的卡片）。
> - 对话：粘贴/拖入图片和文件、`@` 分组（任务/会话/最近文件/找文件）、Ctrl+P 找项目文件。
> - 便签小窗：全局快捷键 Ctrl+Shift+F12，多页、可贴图。Git Review：独立窗口，逐行批注发给会话（迁移 8）。速度 tok/s 和上下文占用。
> - 四条线是在工作树 `G:\PROJECT\AgentMonitorOverlay-s11-{canvas,attach,scratchpad,gitreview}` 里由子 agent 并行开发的；分支 `studio/s11-*` 保留，工作树可以在用户验收后删除。
> - 用户数据迁移前备份在 `.data/backup-before-stage11-20261013/`。
> - 已知：高负载下 e2e 偶尔在关闭应用时超时（测试本身已通过），空闲时全量 60/60 通过。

> **2026-10-13 晚更新：阶段 10 的界面改版和反馈都做完了，模块化重构也做完并合回了 `studio/main`（`4826929`）。**
> - 阶段 10：组织结构 v2、编辑部风格界面、草稿任务页、改名、@ 任务、左栏置顶和折叠、订阅用量都已提交到 `studio/main`（最后是 `a847158`，新图标"取景框"）。剩下的见 `plans/stage-10.md`（S10-06 专题页、S10-08 留言实测、S10-09 草稿区）。
> - 重构：用户同意 `design/architecture-review-2026-10.md` 的 R1–R4，文末"实际做法"写了结果。**代码现在按功能分目录**：Host 在 `packages/host/src/features/<名字>/`（`service.ts`、`routes.ts`、`mcp.ts`），清单 `features/index.ts`；界面在 `packages/ui/src/<名字>/`（页面、`view.tsx`、样式），清单 `ui/src/features.ts`，样式顺序在 `main.tsx`。设置 → 功能 可以关掉扩展包、整体待办与调度。
> - 重构由用户同意直接合回（2026-10-13），用户之后自己验证，有问题再改。分支 `studio/stage-11-modules` 保留未删。
> - 图标源文件 `design/icon/viewfinder.svg`，改完运行 `node scripts/make-icons.mjs` 生成应用、窗口和 exe 图标。

## 1. 在哪、怎么跑

| 项目 | 内容 |
|---|---|
| 开发目录 | `G:\PROJECT\AgentMonitorOverlay\studio`（主仓库，10-20 起；桌面快捷方式「AMO Source」指这里的 `start-studio.cmd`） |
| 分支 | `master`（10-17 起是 Studio 主线，已推送）；旧版在标签 `amo-legacy-final` |
| 旧 worktree | `G:\PROJECT\AgentMonitorOverlay-studio`：10-20 搬家前的开发目录，已分离（detached），留着当退路，里面的 `studio\.data` 是搬家前的数据。确认新目录没问题后可删（`git worktree remove`）。`-s17` worktree 10-20 也删了（`studio/s18-models-page` 已合并，分支保留） |
| 开发版 | `npm start`（先 build 再开窗口），数据在 `studio\.data`。Host 常驻在 47900 端口；改了 Host 代码要先 `npm run host:stop` 再 `npm start` |
| 帮用户重启开发版 | **先问用户**。`npm run build` → `npm run host:stop` → 结束 `electron.exe packages/app` 主进程（命令行不含 `--type=`）→ 备份 `.data\studio.db*` 到 `.data\backup-before-<名字>-<日期>` → 在 PowerShell 里先删掉匹配 `^(CLAUDE|ANTHROPIC_|AMO_STUDIO_|NO_COLOR$|FORCE_COLOR$|COLOR$|TERM$)` 的环境变量（Claude Code 工具 shell 带的，Studio 会传给维护终端）→ `Start-Process node_modules\electron\dist\electron.exe packages/app`（工作目录 `studio`）→ 用 `.data/host-token` 在 node 脚本里查 `GET /api/state` 核对任务和会话数（不打印令牌）。只改界面时让用户按 Ctrl+R 即可 |
| 验证 | `npm run verify`（typecheck + vitest + build）；端到端 `npx playwright test -c e2e/playwright.config.ts`（约 11 分钟，先确保 build 过） |
| Portable | **不要每次都打包**，只在用户确认的发布节点打（LOOP_RULES 第 6 节） |

## 2. 规则（摘要，全文见 `docs/LOOP_RULES.md`）

- 不碰旧 AMO 的运行时和 `broker/data/`；不改主目录文件；不改 `~/.codex/config.toml`、`~/.claude/` 设置、用户已有的凭据条目（Studio 只写自己的：`claude-subscription`，和用户在 设置 → 模型 加渠道时的 `channel-<id>` / `channel-<id>-access`）。
- 测试只在 `%TEMP%\amo-studio-sandbox\` 和临时目录；端口只用 47900–47999；测试窗口不抢焦点、不开终端/浏览器、不碰剪贴板。
- Git 在 master 或 `studio/*` 分支上提交；推送要用户说；不 reset --hard、不删分支。
- 密钥不打印、不写日志/文件/命令行。
- **真实模型额度**（`budget.json`，用 `spikes/lib.mjs` 的 `countTurn(note, provider)` 先计数再调用）：DeepSeek 29/1000、GLM 28/5000、**GPT 订阅 6/50、Claude 订阅 0/50**（后两项是用户 2026-10-13 批准的，只用来验证这两种模型在 Studio 里能用）。平时测试用 mock。
- 工具坑：heredoc 里的 Python 会吃掉 `\n`、`\v` 等转义 → 有转义的改动用 Edit/Write 或 scratchpad 里的 `.py` 文件；Windows 文件名不分大小写（`Transcript.tsx` 和 `transcript.ts` 会撞）；跑完 e2e 用 `git checkout -- studio/screenshots/stage-*` 丢掉无意的截图变化；清理 `%TEMP%\amo-studio-test-*`、`amo-studio-e2e-*`。

## 3. 这次会话做完的事（都已提交到 studio/main）

详见 `plans/stage-9-chat.md` 和 `spikes/RESULTS.md` 的 s9-00 … s9-06。

1. **浅色主题、设置弹窗、公共空间、机器人图标**（`3f939fe`、`61bf28a`）。
2. **对话体验对齐 DSH**（`a614071`）：按"轮"组织；工作过程（思考、工具）折叠成"已完成，用时 …"；组标题按类别汇总、运行中流光；思考行；工具行展开为终端 / diff / 输入输出卡片；页脚（复制、时间、用量）；运行指示；圆角输入框和会话统计；回到底部；设置 → 工作步骤展示（简洁/标准/详细/完全展开，默认标准）。
   - Host 侧：`turn` 条目（时间、状态、用量）、`reasoning` 条目、更丰富的 `tool` 条目（kind、输入、退出码、耗时、diff）、命令输出流式、Windows 上按命令识别读/搜/列。Codex app-server 加了 `show_raw_agent_reasoning=true`，每个 turn 带 `summary: "auto"`。
   - 代码：`packages/ui/src/chat/`（`turns.ts` 纯逻辑 + 测试、`Transcript.tsx`、`ProcessRows.tsx`、`SessionOptionsBar.tsx`、`OptionsPicker.tsx`）、`styles/chat.css`、`packages/host/src/runtime/items.ts`。
3. **GPT 订阅与 Claude 订阅两个模型配置**（`682c9b7`）：`codex-default` 改名"GPT 订阅"（用户自己的 Codex 登录）；新增 `claude-subscription`（`claude setup-token` 生成的令牌，设置 → 模型凭据里保存，只作为 `CLAUDE_CODE_OAUTH_TOKEN` 传给子进程）。
4. **型号 / 思考强度 / 权限 + 常用预设**（`2ad82c3`）：新建任务、新建会话可选；会话里点输入框左下角切换（Claude 立即生效，Codex 下一轮）；设置 → 常用预设，一键切换。列表来自各 CLI：Codex `model/list`、Claude Code `supportedModels()`、GLM 内置列表。会话表新增 `options` 列（迁移 6）。
5. **帮我审批 + Windows 沙箱修好**（`c70d51b`）：
   - 用户 Codex 配置是 `[windows] sandbox = "unelevated"`；沙箱里命令失败的原因是 Codex 用了 WindowsApps 里的应用商店版 `pwsh.exe`。Studio 启动的 app-server 的 PATH 去掉了 WindowsApps，改用 Windows PowerShell 5，沙箱正常。
   - Codex 权限：逐条询问（**默认**，不进沙箱 + untrusted）/ 帮我审批（= CLI 的 Approve for me：on-request + workspace-write + `approvals_reviewer: auto_review`）/ 需要时询问 / 完全访问 / 工作区可写 / 只读。批准默认一律回到人（`approvalsReviewer: "user"`），只有"帮我审批"交给审查 agent；审查结果显示为"自动审批"行。
   - Claude 权限：每次询问 / 自动接受编辑 / 只做计划 / 全部允许。

## 4. 还没做完 / 等用户的

| 事项 | 状态 |
|---|---|
| Claude 订阅的真实测试 | 等用户运行 `claude setup-token` 并在 设置 → 模型凭据 保存令牌。之后跑 `node spikes/s9-01-subscriptions.mjs claude`（计 claude 1 次），它还会检查令牌有没有泄露进 agent 的命令环境（期望 `TOKEN-HIDDEN`）；保存令牌后 Claude 订阅的型号列表会来自 Claude Code 本身 |
| NEEDS_YOU 里 5 项"必须等你" | 合并 master（S8-07）、切换日常工具与删除旧 AMO（S3-10）、是否开放派发（S5-10）、第一个扩展包（S6-09）、调度权限与频率（S7-09）。用户说暂时没空处理，不要催 |
| 用户暂缓的 | 扩展包 `.amo/packs/` 的实际用法（做到时再说）；清理旧 AMO 在工程里部署的 Hook（用户先体验新版） |
| DSH 对齐里没做的 | 轮次导航轨道、从某一轮分支对话（图片附件、文件链接、上下文压缩已在阶段 11/12 做了） |
| 可选 | "彻底退出 Host"按钮（Portable）、`npm run dev:studio` 一键热更新脚本 |

## 5. 已知问题

- `packages/host/src/runtime/codex/server-manager.test.ts` 的"停止并释放端口 / 崩溃后同端口重启"在完整并行跑时偶发失败（端口释放慢），单独跑通过。记录在 `plans/maintenance.md`，不是功能问题。
- 端到端里 Claude 的 mock 配置没法向 Claude Code 要型号列表（会超时），所以测试模式给 mock 配了内置列表（`packages/host/src/bin.ts`）。
- 去掉 WindowsApps 后，Studio 里 agent 的命令用不到应用商店版的 `pwsh`、`python3`、`winget`（本机 `python`、`node`、`git` 不受影响）。
- 用户自己的 Codex CLI 可能也会遇到"应用商店版 PowerShell 在沙箱里起不来"的问题；没有改用户的 `~/.codex`。

## 6. 重要文件

| 文件 | 内容 |
|---|---|
| `docs/LOOP_RULES.md` | 红线、额度、关卡 |
| `docs/STATUS.md` / `docs/NEEDS_YOU.md` | 状态、等用户的事项 |
| `plans/stage-9-chat.md` | 本次会话的计划与追加记录 |
| `spikes/RESULTS.md` | 所有实测结论（s9-00…s9-06 是本次的） |
| `plans/maintenance.md` | 遗留小问题与暂缓事项 |
| `design/architecture.md`、`README.md` | 架构、用户指南 |
