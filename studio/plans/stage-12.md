# 阶段 12：Review 补强、对话里的提问和文件、文件标记（2026-10-14）

起因：用户验收 Git Review 后提出 6 项（2026-10-14）：

1. Review 里代码按语言变色（C# 等常见格式）。
2. 左侧文件名显示不全，重新设计；文件列表的宽度可以拖动。
3. 除了现在的模式，加一个 diff 模式。
4. 文件上加按钮，用编辑器打开，先支持 VS Code。
5. 在 mining 项目里让 Claude 提一个四选一的问题，Studio 里只看到 "AskUserQuestion"，看不到内容。查一下对话里还缺什么（点文件快速查看、用编辑器打开、在资源管理器里显示、问答的整体支持等），参考 DSH。
6. 文件标记：把某个文件标记下来并写说明，之后可以 @ 或拖进对话框，告诉 AI 说的是这个文件。做成像 Reviewer 那样可以快速打开的独立窗口。

按 LOOP_RULES 用保守默认推进；只有不可逆的事（合并 master、推送、发布）等用户。

## 调查：对话里缺什么（需求 5）

查了用户数据里那次提问、Host 两个运行时的代码，对照 DSH 0.2.1 的 `ui-user-questions`、`ui-plan`、`ui-deliverables`、`ui-open-in-app`、`ui-sidebar-documentpreview`。

| 缺口 | 现状 | DSH 的做法 |
|---|---|---|
| **Claude 的提问（AskUserQuestion）** | 走 `canUseTool`，被当成普通权限卡片，只显示工具名；点"允许"后模型收到 "The user did not answer the questions."（mining 那次就是这样） | 提问卡片占住输入框的位置：分页、选项（单选点了就进下一题、多选）、"其他"自由填写、跳过、提交；结束后工具行可以重新打开只读的问答 |
| **Claude 的计划确认（ExitPlanMode）** | 会话选"只做计划"时，计划写完要用户确认，同样只显示工具名，计划正文埋在工具输入的 JSON 里 | 计划审阅卡片：标题、摘要、"查看完整计划"、"批准" / "要修改" |
| **Codex 的提问（`item/tool/requestUserInput`）** | Host 完全没处理，Codex 会一直等 | 同提问卡片 |
| **MCP 服务的表单（`mcpServer/elicitation/request`）** | 只给"允许/拒绝"，表单字段直接回空 | — |
| **文件引用不能点** | 回答里的路径、工具行里读写的文件、diff 卡片的文件头、@ 文件 chip 都不能点；Markdown 链接只认 http | 回答里的行内代码路径、本轮改动的文件都能点，在右侧栏预览 |
| **快速查看文件** | 没有 | 右侧栏文档预览（代码高亮、Markdown、图片），可以刷新 |
| **用编辑器打开 / 在资源管理器中显示** | 没有 | 会话顶栏"用…打开"（记住上次的应用），预览里"打开"按钮和"在文件夹中显示" |
| **本轮改动的文件** | 没有 | 一轮结束后的"改动的文件"卡片（增删行数），点开看这一轮的 diff |
| **回答里的代码块高亮** | 没有 | Shiki 高亮 |

这次不做：DSH 提问卡片的倒计时和草稿跨刷新保存、上下文压缩行、从某一轮分支对话、`present` 交付卡片。

## 各项做法

### S12-0 公共底座（主会话，先提交到 studio/main）

- 语法高亮 `ui/src/lib/highlight.ts`：Shiki 4.4.3 精简内核 + JavaScript 正则引擎（不用 WASM）+ CSS 变量主题，颜色是 `--shiki-*` 设计令牌（浅色、深色各一套）。按扩展名选语言：C#、TS/JS、JSON、Python、C/C++、Java、Go、Rust、Lua、Shell/PowerShell、YAML、Markdown、HTML、CSS、XML、SQL、ShaderLab、HLSL、GLSL、TOML、INI 等；常用的几种一开始就加载，其余第一次用到时再加载。思路参考 DSH `ui-primitives/src/markdown/highlight.ts`（MIT）。
- Host 新功能 `features/openin/`：
  - `GET /api/open-in/apps`：本机能用的编辑器（先只有 VS Code：App Paths 注册表、`%LOCALAPPDATA%\Programs\Microsoft VS Code`、`%ProgramFiles%`、PATH 里的 `code`）。
  - `POST /api/open-in { path, workspaceId?, line?, column?, app }`：`app` 是 `vscode`（`Code.exe --goto 文件:行:列`）、`explorer`（`explorer /select,`）或 `default`（系统默认程序）。相对路径按项目文件夹解析；文件必须存在。用 execFile，不经过 shell。测试模式下只记录不启动。
  - `GET /api/fs/text?path=&workspaceId=`：读文本文件给预览用（上限 2 MB，二进制返回提示）。
- 界面工具 `ui/src/lib/openin.ts`：`openInEditor`、`revealInExplorer`、`readTextFile`。

### S12-A Review 补强（需求 1–4，线 `studio/s12-review`）

- **代码变色**：diff 的每一行按文件扩展名高亮，保留增删的底色；整份文件一起高亮，跨行的注释、字符串颜色正确。
- **文件列表**：默认改成树（文件夹可折叠，只有一个子文件夹的链条合并成一行，像 VS Code）；文件名始终完整显示，太长时从中间省略、保留扩展名，悬停显示完整路径；可以切换成"平铺"（文件名在上、所在文件夹在下）。列表宽度可以拖动（180–600 px），记在本机。
- **diff 模式**：理解为**左右对照**。现在的两种视图都是单栏；加"单栏 / 左右对照"开关，可以和"只看改动 / 完整文件"组合。左右对照时左边旧版、右边新版，两边同步滚动，删除行的批注加在左边、其他加在右边。
- **用编辑器打开**：文件头加"VS Code 打开"（打开到当前选中的行）和"在资源管理器中显示"；文件列表右键也有。本机找不到 VS Code 时按钮不显示，只留资源管理器。

### S12-B 对话里的提问和计划确认（需求 5 的一半，线 `studio/s12-questions`）

- 新条目类型 `question`（问题、选项、多选、答案、状态），Host 和界面都按它处理：
  - Claude `AskUserQuestion`：`canUseTool` 里不再出权限卡片，改成提问；回答后以 `updatedInput.answers`（按问题文字作键，多选用逗号连接）和 `annotations.notes`（"其他"的文字）放行。
  - Codex `item/tool/requestUserInput`：同样的提问，回答按题目 id 回传；`isOther` 时可以自由填写，`isSecret` 时用密码框。
  - Claude `ExitPlanMode`：计划审阅卡片，显示完整计划（Markdown），"批准并开始"（放行，并把会话的权限从"只做计划"换成"每次询问"）和"要修改"（拒绝，把输入框里的话作为修改意见发回去）。
- 提问卡片占住输入框的位置：分页（多题时）、选项带说明、单选点了直接进下一题、多选、"其他"输入框、跳过某题、提交；也可以关掉卡片，用工具行重新打开。回答后对话里显示一条紧凑的"已回答"记录，点开看每题的答案。
- Codex MCP 表单：按 schema 显示字段（文字、数字、开关、单选、多选），提交 `content`。
- mock 模型加 `[[ask]]`、`[[plan]]` 指令，用于测试和截图。

### S12-C 对话里的文件（需求 5 的另一半，线 `studio/s12-chatfiles`）

- **能点的文件**：回答里像路径的行内代码和 Markdown 本地链接（含 `文件:行号`）、工具行里读写的文件、diff 卡片的文件头、@ 文件 chip、拖入的文件 chip。路径按会话的工作目录解析，文件不存在时不变成链接。
- **快速查看**：点击在任务页右侧打开文件预览（不离开对话）：代码高亮、行号、跳到指定行；Markdown 可以切换渲染 / 源码；图片直接显示；顶上有"VS Code 打开"、"在资源管理器中显示"、"复制路径"。Ctrl+点击直接用 VS Code 打开。
- **右键菜单**：文件链接上右键 = 快速查看 / VS Code 打开 / 在资源管理器中显示 / 复制路径。
- **本轮改动的文件**：一轮结束后，回答下方列出这一轮改过的文件（来自改文件的工具条目，含增删行数）；点文件看它在这一轮的 diff，"在 Review 里看"打开 Review 窗口。
- **会话顶栏**：工作目录旁加"VS Code 打开文件夹"和"在资源管理器中显示"。
- 回答里的代码块用 S12-0 的高亮。

### S12-D 文件标记（需求 6，线 `studio/s12-marks`）

- 一条标记 = 文件（或文件夹）的路径、所属项目、可选的行号范围、说明、时间。存在 Host（迁移 9，表 `file_marks`，只有这条线可以加迁移）。
- **标记窗口**（独立窗口，像 Review）：`#marks?workspace=…`，按项目分组，可以搜索路径和说明；可以从资源管理器拖文件进来、点"+ 标记文件"用找文件弹窗选、粘贴路径；说明可以直接改；每条都能快速查看、VS Code 打开、在资源管理器中显示、删除。
- **交给 AI**：从标记窗口把一条标记拖进对话输入框，插入一个文件引用 chip（带说明）；`@` 菜单加"标记的文件"分组。发送时写成「引用文件：路径（说明：……）」。
- **入口**：工作台顶栏按钮和快捷键 `Ctrl+Shift+M`（窗口内快捷键，不是全局的）；任务页、会话栏；Review 窗口和找文件弹窗里"标记这个文件"。
- 决定：标记跟着项目走；项目外的文件归到"其他"。删除项目时一并删除它的标记。

### S12-E CLI 功能补全（用户 2026-10-14 追加：「除了提问以外，还有其他的 cli 功能没能处理，调查一轮然后补完」；线 `studio/s12-cli`，等 S12-B 合并后开始，因为改的是同一批运行时文件）

调查方法：把 Codex app-server 协议里的全部通知、请求和条目类型，以及 Claude Agent SDK 0.3.296 的全部消息类型，逐一对照 Host 运行时的处理。

| 缺口 | Claude | Codex | 做法 |
|---|---|---|---|
| **`/` 命令** | SDK `supportedCommands()` 和 `commands_changed`（内置命令、自定义命令、skills），把 `/xxx` 当作 prompt 发出；输出来自 `local_command_output` | 没有命令行：`/compact` → `thread/compact/start`，`/review` → `review/start`，skills → `skills/list` 加输入类型 `skill` | 输入框打 `/` 弹出命令菜单（分组：Studio 自己的 / 运行时的 / skills），带说明；命令输出显示为一条记录。参考 DSH `ui-commands` |
| **上下文压缩** | `compact_boundary`、`status: compacting` | `thread/compacted`、`contextCompaction` 条目 | 对话里一行「上下文已压缩（之前 … tok）」；压缩进行中的状态；输入框下方的上下文占用旁加「压缩」按钮 |
| **提示类消息** | `api_retry`、`model_refusal_*`、`permission_denied`、`notification`、`informational` | `model/rerouted`、`configWarning`、`deprecationNotice`、`guardianWarning`、`mcpServer/startupStatus/updated`（MCP 启动失败）、`error` 的 willRetry | 运行中状态行显示「正在重试 2/10」；其余变成 notice 行（同类合并，不刷屏） |
| **后台命令** | `task_started` / `task_progress` / `task_updated` / `background_tasks_changed`（后台 Bash），`stop_task` | `process/*`、`command/exec/outputDelta` | 会话里列出正在后台运行的命令，能看输出、能停止 |
| **工具进度** | `tool_progress`（已运行时长）、`tool_use_summary` | `item/mcpToolCall/progress`、`item/commandExecution/terminalInteraction`（命令在等输入）、`item/fileChange/outputDelta` | 工具行显示进度文字；命令等待输入时提示 |
| **图片结果** | Read 图片时的 image 结果块 | `imageView`、`imageGeneration` 条目 | 工具行里显示图片 |
| **Codex review 模式** | — | `enteredReviewMode` / `exitedReviewMode` 条目 | 显示审查开始 / 结论（与 `/review` 一起做） |
| **其他条目** | `hook_started` / `hook_response` | `hook/*`、`hookPrompt`、`collabAgentToolCall`、`sleep`、`turn/diff/updated` | hook 只在失败或拦截时显示；其余条目给一个通用的工具行，不再静默丢掉 |
| **建议的下一句** | `prompt_suggestion` | — | 回答结束后在输入框上方显示可点的建议（可在设置里关） |

这次不做：撤销某一轮的文件改动（Claude `rewind_files`、Codex `thread/rollback`，涉及文件回滚，另行讨论）；实时语音（`thread/realtime/*`）；账号登录类通知。

## 怎么并行

- 先在 `studio/main` 上做 **S12-0**，提交后再分四条线，每条线一个 git 工作树和分支（`studio/s12-review`、`studio/s12-questions`、`studio/s12-chatfiles`、`studio/s12-marks`），由各自的 agent 开发。
- 共用文件的约定同阶段 11：`protocol/src/api.ts`、`features/index.ts`、`ui/src/features.ts`、`main.tsx` 只追加；只有 S12-D 加迁移（编号 9）；新窗口各写一个独立文件，`main.ts` 里只加启动调用。
- 各线只跑和自己相关的测试，**不要清理别的工作树或临时目录**；合并后由主会话跑全量测试。
- 都用 mock 模型测试，不调真实模型。

## 进度

| 项 | 状态 |
|---|---|
| S12-0 公共底座 | ✅ `d319e28`：`lib/highlight.ts`（Shiki 4.4.3，C#/TS/JSON 先加载，其余按需）、`styles/code.css`、Host `features/openin/`（VS Code 通过安装目录里 `bin/code.cmd` 指向的 CLI 脚本启动，`--goto 文件:行:列`；资源管理器 `/select,`；默认程序）、`/api/fs/text`、`/api/fs/raw`、界面 `lib/openin.ts` |
| S12-A Review 补强 | ✅ 已合并（`81251a2`）。目录树（单子文件夹合并、可折叠）/ 平铺，文件名中间省略保留扩展名；列表宽度可拖（180–600，双击恢复 280）；按扩展名高亮（新旧两份全文各高亮一次再按行号对回，超过 5000 行不高亮）；「单栏 / 左右对照」与「只看改动 / 完整文件」组合，设置记在本机；文件头「VS Code 打开」（当前行）和「在资源管理器中显示」，文件右键同样两项，已删除的文件不可用。决定：j/k 按目录树顺序走全部文件（进入折叠的文件夹时自动展开）；折叠状态不记；左右对照里长行换行以保持对齐；点击行即设为当前行 |
| S12-B 提问和计划确认 | ✅ 已合并（`73b7031` 等）。新条目 `question`（来源：Claude 提问 / Codex 提问 / MCP 表单 / 计划审阅）和会话状态「等你回答」（看板、会话列表、Focus、需要你都认）；接口 `POST /api/sessions/:id/questions/:itemId/answer`。Claude 提问：以 `updatedInput.answers`（按问题文字，多选用「, 」连接）放行，已用真实 CLI + mock 模型端到端验证；计划审阅：「批准并开始」把会话权限改为每次询问再放行，「要修改」带着输入框的话拒绝，另有「先不批准」（留在计划模式）。Codex `request_user_input` 按题目 id 回答，但只在 Codex 的计划协作模式下可用，Studio 没开这个模式，所以只有 Host 单元测试覆盖；MCP 表单按 schema 显示字段。提问卡片占住输入框：分页、单选点了进下一题、多选、其他、密码框、跳过、不回答、最小化；对话里留「已回答」记录可展开。**顺带修了一个旧 bug**：Studio 给 Claude 设了 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`，这时启动参数里的权限模式不生效，「只做计划」「自动接受编辑」「全部允许」都要中途切换一次才生效；现在第一条消息前先设一次 |
| S12-C 对话里的文件 | ✅ 已合并（`46164d1`）。新 Host 接口 `POST /api/fs/exists`（只把存在的文件变成链接）；回答里的行内代码路径和本地 Markdown 链接、读/改文件的工具行、diff 卡片文件头、消息和输入框里的文件 chip 都能点；右侧快速查看（高亮、行号、标出指定行、Markdown 渲染/源码、图片、宽度可拖），Ctrl+点击直接 VS Code，右键菜单；一轮结束后「改动的文件」卡片，点开看本轮 diff，可切到当前文件，git 项目可「在 Review 里看」；会话顶栏工作目录旁「VS Code」「资源管理器」；回答里的代码块高亮。决定：只扫行内代码和链接，不扫普通文字；搜索行、命令输出里的路径、文件夹不做链接；预览打开时占右栏（批注栏隐藏）；工具行里的文件名现在打开预览，展开工具行改为点标题 |
| S12-D 文件标记 | ✅ 已合并（`cc5f07f`）。迁移 9 表 `file_marks`；Host `features/marks/`（增删改、同路径同行号去重、按最内层项目归类、项目外归「其他」、项目删除时一并删、`marks.changed` 事件），MCP 工具 `list_file_marks`（agent 可读用户的标记）；独立窗口 `#marks`（所有项目一个窗口，当前项目在前；搜索；从资源管理器拖入、「+ 标记文件」、粘贴路径；说明自动保存、行号范围；快速查看、VS Code、资源管理器、删除；文件不存在时变灰）；`@` 菜单「标记的文件」分组；从标记窗口拖进输入框成为带说明的 chip，发出时写成「- 路径:行（说明：…）」，对话记录读回；入口：标题栏「标记」、Ctrl+Shift+M（窗口内）、任务页和会话栏、找文件弹窗「标记这个文件（Ctrl+M）」；合并后主会话补了快速查看和 Review 文件头的「标记」按钮（`d6a33cf`）。没做：两个窗口之间真实拖动只测了两半（Playwright 做不了系统级拖动），需要你手动试一次；标记排序没有界面 |
| 标题栏调整 | ✅ `989e2f6`：标题行只留品牌、需要你、便签、Focus（图标 + 状态点）和窗口按钮；看板 / 画布切换和「+ 新任务」挪到下面一行（在左栏右侧，只占内容区宽度）；设置移到左栏底部「Host 运行中」下面 |
| S12-E CLI 功能补全 | ✅ 已合并（`3923e7a`、`2231892`）。用真实 Claude Code（SDK 0.3.296 自带）和 codex-cli 0.162.1 接 mock 模型逐项核对（`spikes/s12-e-*.mjs`）。**`/` 命令**：Host `features/cli/`；Studio 自己的 `/compact`、`/review`（打开 Review）；Claude 的命令来自 `supportedCommands()` 和 `commands_changed`（含 skills），`/cost`、`/context` 的输出显示为「/name 的输出」记录；会在背后改掉会话的命令（/clear、/model、/resume、/login 等）不列出、输入时提示；Codex 的审查叫 `/code-review`（`review/start`），skills 用 `skill` 输入。**压缩**：新条目 `compaction`（之前约 N tok / 正在压缩 / 失败原因），上下文旁「压缩」按钮（Codex 运行中不可压缩）。**提示**：重试只显示在运行状态行；拒答、权限被拒、通知、模型被切换、配置警告、MCP 启动失败成为提示行，同一轮重复的合并成 ×N；Codex 的 deprecationNotice 讲的是 Studio 自己的调用方式，只进 Host 日志。**后台命令**（Claude）：输入框上方「后台运行」列表，看输出尾部、停止；Codex 没有可用的接口，没做。**工具进度和图片**：工具行显示进度文字和已运行时长；Claude 读图片、Codex 看图/生成图显示缩略图。**其余条目**：Codex 审查模式、hook（只显示失败或拦截）、collab、sleep 等都有通用行，不再静默丢掉；顺带修了 Codex 审查轮次导致会话一直「运行中」。**建议的下一句**：主会话合并后改为**默认关**（每轮多一次模型请求），设置 → 界面里打开 |
| S12-F Review 提速和 Fork 样式列表 | ✅ 用户 2026-10-14 验收后追加：「打开文件改动会读取一下」「文件列表改成 Fork 这种样式，add 之类的状态有不同颜色的图标」。**测出来的慢点**：Host 每打开一个文件要 300–400ms，真正的 `git diff` 只占约 65ms，其余是每次重新读分支状态（7 个 git 进程、4 轮）和查是否未跟踪；窗口里高亮新旧两份全文，1800 行的 C# 要 100–160ms 一份、3500 行 600ms，期间窗口卡住。**改法**：diff 接口接收列表已知的基准提交 `?base=` 和 `?untracked=`，只跑一次 git（实测 286ms → 70ms）；读状态的 git 调用并行成两轮，列表的未跟踪扫描和读状态同时跑，未跟踪文件 8 个一批并行读；窗口里读过的 diff 留着（最多 60 个，刷新时清空），选中文件后预读后面 3 个和前一个，指针停在哪个文件上就预读哪个；高亮挪进 Web Worker（`lib/highlight.worker.ts`、`lib/highlight-client.ts`，Vite 用 ES 模块 worker），选中的文件优先，预读的文件顺便上色；只有一边有改动时另一边借用颜色不再高亮第二遍；「正在读取…」0.3 秒后才出现。**列表**：平铺改为默认，整条路径一行（目录淡色、窄时先缩目录、留「…」），按完整路径排序（不分大小写，同 Fork）；状态改成彩色方块（+ 新增绿、M 修改黄、− 删除红、R 改名蓝，未跟踪是绿色空心 +）；文件类型图标（`files/filekind.ts`、`FileTypeIcon.tsx`：C#、TS、JS、MD、JSON、PowerShell、dll/pdb、Unity 资源、图片、文本等）；行高 24px；默认列表宽度 340。以前记住的「目录树」是旧默认值，这次统一改回平铺，之后选的会记住。没做：对话里的快速查看和标记窗口的预览还在窗口里同步高亮，大文件打开时同样会卡一下 |
| S12-G Codex 异步提问和崩溃隔离 | ✅ 用户 2026-10-14 实测后反馈：「gpt 说触发了交互卡片但本机看不到」「deepseek 直接让程序崩溃了」「对话导致程序崩溃这个问题很大，有办法只提示报错吗」。**查明**：DeepSeek 那次是我为测新代码重启了开发版（07:55:59），正好杀掉了 07:55:52 开始的那一轮，不是对话引起的；GPT 用的是 Codex 0.162 的 `request_user_input_async`（不阻塞：问题作为带 `delivery:"async"` 和 `questions` 的 agentMessage 发出，模型立刻拿到 `{"accepted":true}` 接着说），Studio 当成了普通文字。这个工具由模型目录的 `experimental_supported_tools: ["send_user_message_async"]` 打开，OpenAI 给 GPT-6 系列开了，Studio 自带的 DeepSeek 目录和 mock 目录没开。**异步提问**：新来源 `codex-async`；显示为提问卡片（「Codex 在问你 · 回答会作为你的下一条消息」），回答由 sessions 服务作为下一条消息发出（「问题」：选项）；这一轮结束时问题还开着则会话为「等你回答」；直接打字发消息也算回答；Host 重启不取消这种问题；DeepSeek 目录也打开了 `send_user_message_async`。**崩溃隔离**：Host 进程加 `uncaughtException` / `unhandledRejection` 兜底，记日志（带堆栈）后继续运行，窗口弹出「Host 内部出错」提示（新事件 `host.error`）；Codex / Claude 处理某条消息出错时，在那个会话里加一行提示（同一种消息只提示一次），Codex 的服务端请求出错时回一个 JSON-RPC 错误（不让那一轮一直等）；外壳每 3 秒探一次 Host，连续两次不响应就在同一端口重启它（10 分钟内最多 5 次），窗口自动重连并提示；窗口页面进程崩溃时自动重新载入（一分钟内最多 3 次）；界面加错误边界：一条记录、一轮、一个页面、整个窗口分别兜住，出错的部分显示原因和重试，不再整窗白屏。**重启残留**：Codex 会话在线程已不运行时，把上一个 Host 留下的「运行中」那一轮改为已中断（流式文字、运行中的工具、压缩一并收尾），并加一行说明。测试：fake app-server 加 `[[ask-async]]`、`[[bad-item]]`，mock 模型加 `[[ask-async]]`（真实 codex-cli 端到端通过）；新 e2e `resilience.spec.ts`（异步提问卡片；杀掉 Host 后自动重启、提示、继续工作）。没做：渲染出错的自动化测试（需要在产品代码里留故障注入口，没加） |
| S12-H 决策卡放进会话 | ✅ `a7b9840`。用户：「deepseek 用了 amo 决策卡，显示的位置有些问题，最好在 session 里，对话的上面，而且换行之类的文字排布也有问题」。会话自己的待决策（AMO MCP `decision_request`）固定在这个会话的对话上方（对话滚动时不动），选项改成带编号的整行按钮，长句在框里换行；右栏只提示同一任务里**其他**会话的待决策，「去回答」切到那个会话。截图 `S12-H-decision-in-session.png` |
| S12-I 设置分页和 Claude 登录方式 | ✅ 用户 2026-10-14：「setting 根据功能拆分成不同的界面，需要一个模型界面，claude 可以在里面设置是用 token 还是用本机配置。切换成本机配置时，弹出个 2 级弹窗提示风险」。**设置分页**：左边分类（界面 / 模型 / 公共目录 / 功能 / 便签，↑↓ 切换），右边一页；同一窗口里下次打开回到上次的页。**模型页**：Claude 订阅的登录方式（令牌，推荐 / 本机 Claude Code 的登录），令牌方式显示原来的令牌行，本机方式显示是否找到本机登录（Windows 上只看 `.credentials.json` 在不在，不读内容）和目录；下面是其他模型的 Key 和常用预设。选本机登录先弹二级确认（列出：共用账号和额度、一起掉线、对话记录写进 `~/.claude/projects` 并出现在 `claude --resume` 里、不加载那里的 settings/hooks/CLAUDE.md/MCP、只适合本机自用不能打包给别人、只影响之后新开的会话），Esc 只关确认框；改回令牌不用确认。**Host**：设置 `claudeLogin`（kv `settings:claude-login`，默认 token）和 `claudeLocal`（目录、是否已登录）；`claudeEnv` 本机方式不要令牌、不设 `CLAUDE_CONFIG_DIR`（让 CLI 像终端里一样自己找 `~/.claude` 和 `~/.claude.json`；用户自己设了 `CLAUDE_CONFIG_DIR` 才传下去），并加 `strictMcpConfig`；只对 Claude 订阅生效（GLM 等永远用 Studio 自己的目录）。**每个会话记住开始时的方式**（kv `claude.login:<id>`），因为对话记录在那个目录里：切换后旧会话照旧续聊、分支跟着父会话，本机方式的会话不能分支到别的模型。测试：`claude-env` 单测；集成测试用真实 Claude Agent SDK 和临时「本机目录」（带假的 OAuth 登录）跑通对话、切回令牌后续聊、分支；e2e 新增一条（确认框的取消 / Esc / 确认，之后没有令牌也能开 Claude 会话，记录写在那个目录）。截图 `S12-I-*.png` |
| S12-J 额度、型号顺序和默认、型号名 | ✅ 用户 2026-10-14：「claude 额度不准，一直显示 100%，参考 ccswitch 的查询方式；5 小时剩余、周剩余和距离重置的时间也显示（钟表图标 + 1h 34m）；是不是 token 的使用方式导致的」「设置里允许拖拽模型顺序、标记默认；思考强度和权限也要能设默认」「选中了具体模型就写具体一点（opus 5.5、sol 6.1），现在一直显示 GPT / Claude」。**查明**：`rate_limit_event` 只在接近上限时带 `utilization`，界面把没有的当成 0，所以总是「剩 100%」；Claude Code 的 /usage 和 CC Switch 用的是 `GET /api/oauth/usage`，需要 `user:profile` 权限，setup-token 只有推理权限（实测 403 oauth_scope_insufficient），所以确实和令牌方式有关。**额度**：本机登录方式下只读 `.credentials.json` 的 accessToken 去查（不续期、不写），得到 5 小时 / 每周（有的话还有 Opus / Sonnet 每周）的百分比和重置时间，30 秒内复用；令牌方式如实说明查不到百分比，只显示 Claude 告诉的重置时间；每个窗口加钟表图标和倒计时（`34m`、`1h 34m`、`3d 2h 5m`，30 秒刷新）。**型号顺序和默认**：设置 → 模型 → 型号顺序和默认，按配置拖动排序（也可 Alt ↑↓）、设默认型号、默认思考强度、默认权限（kv `settings:model-prefs`）；Host 在 choices 上套用（所有选择器跟着变），新开会话没选的项按它填好；改动后界面清掉 choices 缓存重读。**型号名**：标题、输入框下方、会话列表都写会话实际用的型号（默认型号也写名字；Claude Code 的「默认（Opus 5.5）」显示为 Opus 5.5）。测试：model-prefs 单测、claude 集成测试（用量接口）、mock 加 `/api/oauth/usage`、e2e（设置里排序和默认、新会话用上；本机登录看到 63% / 1h 3xm） |
| S12-K 提问卡弹窗、通用提示 | ✅ 用户 2026-10-14：「question card 会将对话的一部分框占据住，改成次级弹窗」「question、card 内容转回对话会在最上面出一个细条提示，会改变窗口位置，应该做成通用信息 tips，类似的都这样弹出」。提问卡改成浮在对话区上的弹窗（背后变暗，对话和输入框位置不变），收起后是底部一条；新的 `lib/toast.tsx`（`showToast` + 每个窗口一个 `<Toaster/>`）：顶部居中浮出，不推动页面，普通提示 4 秒、错误 8 秒自动消失，悬停暂停；任务页、Git Review、文件标记、Host 出错提示改用它，画布的两条提示也浮起来 |
| S12-L 已归档任务入口 | ✅ 用户问「已经归档的任务在哪里查看」：原来哪里都看不到。看板最后一列底部加「已归档 N」，列出当前范围的已归档任务（新的在前，多时可筛选），点开只读，任务页「恢复任务」放回看板 |
| S12-M 速率和专属提示词 | ✅ 用户：「token 速率统计有点奇怪，是用的和 dsh 同样方式吗」「会加入我们专属的提示词或者 skill 吗？比如 mcp 怎么使用，或者选项弹窗展示 question 选项」。**速率**：原来是整轮输出 ÷（整轮用时 − 工具用时），算进了等首个 token 和等人确认的时间，并行工具还会重复减；改成和 DSH 一样按每次模型调用累计「首个输出到结束」的时间和输出 token（Claude：stream 事件；Codex：首个 reasoning / 消息输出到它报的 tokenUsage），记在 turn 的 `decode` 上；旧的轮次不显示速度。**提示词**：查明 Studio 的 Claude 会话一直用 SDK 默认系统提示词（只有一行「You are a Claude agent…」），不是 Claude Code 的（约 5.8k 字）；改用 `claude_code` preset（和终端里一样）。Studio 自己的提示词做过又撤回：用户决定「每个 session 就用自己 CLI 的常规方式，提问卡也先不做说明，先用一段确认体验」，所以 Claude 只用 Claude Code 的、Codex 只用 Codex 的。实测（CLI 2.1.296）：`settingSources: []`（Studio 现在）不加载任何 CLAUDE.md；`["project"]` 加载项目 CLAUDE.md；CLI 默认（不传）还加载用户自己的 CLAUDE.md；三种都不读 AGENTS.md。是否改成加载，待用户决定 |
| S12-N 批注气泡 | ✅ 用户：「批注功能调整一轮，参考 gpt app，选中之后弹出一个小气泡框进行编辑」。选中回复里的文字后旁边出现「批注 / 引用」小条，「批注」变成就地编辑的气泡（Ctrl+Enter 保存、Esc 取消），点高亮段落打开同一个气泡修改或删除；右键菜单的「添加批注」也打开气泡；右栏保留列表和「汇总发回会话」；气泡在对话的滚动区里，跟着文字滚动 |
