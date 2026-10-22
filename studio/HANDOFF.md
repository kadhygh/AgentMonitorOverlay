# 交接：继续开发 AMO Studio（2026-10-17）

给下一个会话看的起点。先读这份，再按需读下面列出的文件。

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
  - **任务页会话树能折叠**（10-22 用户要的）：下面挂着子 agent / 分支的会话，行右端「▾ N」/「▸ N」（N = 下面所有层的会话数），收起时里面有等你处理或出错的就变醒目色；默认展开，按会话记在 localStorage `amo.sessionTreeFolded`；选中折叠里的会话（对话里「查看」、Focus、搜索）自动展开到它。`useStoredIds` 从 `focus/pins.ts` 挪到 `lib/storedIds.ts` 共用。e2e `taskpage.spec.ts`。全量 e2e 139/140，便签那条单独重跑通过（失败时正好在重启开发版）。
  - **Focus 置顶收成一行**（10-22 用户要的）：平时只显示状态（进行中 / 等子 agent / 完成待审核 / 空闲 · 说明），只有等审批、等回答、计划待审阅时展开详情；去掉「取消置顶」大按钮和置顶里的「我知道了」（完成待审核点行去工作台看）。置顶的任务所有会话都不再出现在「进行中」；置顶显示的会话先挑等你的，再挑在跑的，再挑最新的（`pins.ts` 的 `pinnedSession`）。纯界面，Ctrl+R 生效。
  - **Focus 历史也能置顶**（10-22 用户要的）：每条历史右边同一个图钉（悬停出现，任务已置顶时常亮、再点取消），会话或任务已不在 / 已归档的不给。e2e `focus-history.spec.ts`。纯界面，Ctrl+R 生效。
  - **发了 Portable 0.9.0**（10-22 用户要的）：版本号 0.8.0 → 0.9.0（`8739625`）；verify 单测只有已知的 4 条不稳定（server-manager 端口 ×3、dsh 加载超时，单独重跑通过），全量 e2e 140/140；`release/AMO-Studio-0.9.0-portable.zip`（292 MB，解压 657 MB）。冒烟脚本跟着新建任务页改成点模型卡片（原来找 `<select>`），冒烟通过。没推送、没打 tag。
  - **「完成」列右键一键归档**（10-22 用户要的，发版之后做的，不在 0.9.0 里）：在「完成」列上右键 →「归档全部已完成（N）」（N = 当前范围看板上这一列的卡片）；在这一列的专题分组上（组头或组里的卡片）右键还多一项「归档「专题」这一组（n）」。不弹确认，逐个调 `POST /api/tasks/:id/archive`（任务和会话一起归档，「已归档」里能打开、恢复）。别的列没有这个菜单。`board/Board.tsx`（`onArchive`、`PopMenu`）、`board/view.tsx`；e2e `board.spec.ts`，截图 `S18-board-archive-done.png`。纯界面，Ctrl+R 生效。
  - **画布上归档任务的卡片不再消失**（10-22 用户报的：归档后卡片没了、只剩连线）：画布原来只按专题里未归档的任务找卡片。现在专题里已归档的任务照样画卡片（`CanvasPage.tsx` 的 `cardTaskById`；离开专题的任务仍不画），灰底虚线框、标题前「已归档」、元信息是「项目 · 多久前归档」（`cards.tsx`、`canvas.css` `.is-archived` / `.archived-mark`）；右键菜单只剩颜色、打开任务（只读）、分组、居中、从画布上拿掉；不能当连依赖的目标；侧栏详情是只读的简版（`CanvasSidebar.tsx`）。旧测试 `canvas-refs.spec.ts`、`search-archive.spec.ts` 原来断言卡片消失，已改；新 e2e 在 `canvas.spec.ts` 末尾，截图 `S18-canvas-archived-card.png`。纯界面，Ctrl+R 生效。
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
> - 便签小窗：全局快捷键 Ctrl+Alt+Space，多页、可贴图。Git Review：独立窗口，逐行批注发给会话（迁移 8）。速度 tok/s 和上下文占用。
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
| 帮用户重启开发版 | **先问用户**。`npm run build` → `npm run host:stop` → 结束 `electron.exe packages/app` 主进程（命令行不含 `--type=`）→ 备份 `.data\studio.db*` 到 `.data\backup-before-<名字>-<日期>` → `Start-Process node_modules\electron\dist\electron.exe packages/app`（工作目录 `studio`）→ 用 `.data/host-token` 在 node 脚本里查 `GET /api/state` 核对任务和会话数（不打印令牌）。只改界面时让用户按 Ctrl+R 即可 |
| 验证 | `npm run verify`（typecheck + vitest + build）；端到端 `npx playwright test -c e2e/playwright.config.ts`（约 11 分钟，先确保 build 过） |
| Portable | **不要每次都打包**，只在用户确认的发布节点打（LOOP_RULES 第 6 节） |

## 2. 规则（摘要，全文见 `LOOP_RULES.md`）

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
| `LOOP_RULES.md` | 红线、额度、关卡 |
| `STATUS.md` / `NEEDS_YOU.md` | 状态、等用户的事项 |
| `plans/stage-9-chat.md` | 本次会话的计划与追加记录 |
| `spikes/RESULTS.md` | 所有实测结论（s9-00…s9-06 是本次的） |
| `plans/maintenance.md` | 遗留小问题与暂缓事项 |
| `design/architecture.md`、`README.md` | 架构、用户指南 |
