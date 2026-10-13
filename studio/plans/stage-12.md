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
| S12-B 提问和计划确认 | 进行中（工作树 `AgentMonitorOverlay-s12-*`） |
| S12-C 对话里的文件 | 进行中（工作树 `AgentMonitorOverlay-s12-*`） |
| S12-D 文件标记 | 进行中（工作树 `AgentMonitorOverlay-s12-*`） |
| 标题栏调整 | ✅ `989e2f6`：标题行只留品牌、需要你、便签、Focus（图标 + 状态点）和窗口按钮；看板 / 画布切换和「+ 新任务」挪到下面一行（在左栏右侧，只占内容区宽度）；设置移到左栏底部「Host 运行中」下面 |
| S12-E CLI 功能补全 | 等 S12-B 合并后开始 |
