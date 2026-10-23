# AMO Studio

AMO 的下一代：由人主导、agent 也能参与的项目推进工作台。看板管任务，画布看全局，每个任务下面是若干个和模型的会话（Codex 或 Claude），你在工作台里对话、审阅、批注，需要时一键交给原版终端。

- 愿景与架构：[../docs/next-gen-vision-architecture-2026-10.md](../docs/next-gen-vision-architecture-2026-10.md)；实际实现：[design/architecture.md](design/architecture.md)
- 已确认的交互：[design/interaction-notes.md](design/interaction-notes.md)

旧 AMO（`broker/`、`overlay/`）已于 2026-10-23 删除，代码在标签 `amo-legacy-final` 里。

## 安装与首次启动（Portable）

1. 拿到 `AMO-Studio-<版本>-portable.zip`（开发者用 `npm run package:portable` 生成在 `studio/release/`）。
2. 解压到一个可写的文件夹，双击 `AMO Studio.exe`。不需要安装，也不写注册表。
3. 第一次打开会出现**首次设置**：
   - **数据目录**：默认是 exe 旁边的 `data` 文件夹（整个文件夹拷走，数据就带走了）；也可以选别处。选择记在 exe 旁边的 `amo-studio.json`。
   - **环境检查**：本机的 `codex`（`npm i -g @openai/codex`），以及 Windows 凭据管理器里 DeepSeek / GLM 的凭据（只检查有没有，不显示密钥）。缺的不影响打开，对应的模型暂时不能用。
4. 点"开始使用"，Studio 会重启一次，之后直接进入工作台。

开发时在 `studio` 下 `npm start`（数据在 `studio/.data`）；`npm run host:stop` 停止后台的 Host。

换一台机器用开发版：装好 Node（24 LTS）和 Git，`git clone`（`master`）后双击 `studio/start-studio.cmd`。它会在依赖缺失或 `package-lock.json` 变了时 `npm ci`，再构建并打开 Studio；`start-studio.cmd -Install` 强制重装依赖，`start-studio.cmd -Stop` 停掉 Host。Codex 模型还要 `npm i -g @openai/codex`；Claude 订阅令牌和各通道的 Key 在 设置 → 模型 里填。

## 随 Studio 一起的两个小程序

- **AMO 便签**（`packages/notes`）：独立进程，托盘图标，全局快捷键（默认 Ctrl+Alt+Space）。Studio 启动时会把它带起来；单独启动 `npm run notes`。设置在它自己的托盘菜单里。
- **AMO Reviewer**（`packages/reviewer`）：Git Review 和查看器，不需要 Studio，任何工具或模型都能用：`amo-review <文件夹> --reviewer [--mode file --file 路径 --line 行号]`，或 `npm run reviewer -- <文件夹>`。批注用「复制注释 / 复制并关闭」，贴到需要的地方。

## 日常怎么用

| 想做的事 | 在哪里 |
|---|---|
| 登记一个工程 | 左栏"+ 登记工作区" |
| 开始一件事 | 顶栏"+ 新任务"：一句话、选工作区（或"跨工作区"）、选模型。工作区有扩展包模板时可以选"流程模板" |
| 和模型对话 | 任务页中间；生成中可以继续发（Codex 插进当前回合，Claude 在下一次工具调用后或本轮结束后读到） |
| 批准命令 / 文件修改 | 对话里的审批卡片；Focus 悬浮窗也能直接批准 |
| 审阅长回复 | 回复按 markdown 渲染，右上角上下跳转；选中文字右键"批注"，攒够后"发回会话" |
| 换个模型再试 / 另开思路 | "分支"（fork），或左栏"+ 新会话"选别的模型；有启动预设时可以"按预设"预填 |
| 用原版 CLI | 对话顶部"在终端打开"：Codex 用 `codex --remote` 共享同一个会话；Claude 交给终端期间工作台只读，关掉终端自动收回 |
| 看全局 | 顶栏"画布"：分组（可绑定工作区，显示空闲/忙碌）、依赖箭头、便签；侧栏有整体待办和 agent 视角 |
| 记还没成任务的事 | 画布侧栏"整体待办"：之后可以"转为任务"，或"让调度看一次"由调度 agent 提出开工提案（看板上方批准后才开工） |
| 现在有什么要我处理 | 顶栏"需要你"，或桌面角落的 Focus 悬浮窗（顶栏"Focus 开/关"） |
| agent 之间交接 | 任务页右栏：进度和交接摘要、留言（由你决定是否转进对话）、待决策 |
| 工程自己的规范和流程 | 工程里的 `.amo/packs/<名字>/pack.json`，见 [design/pack-format.md](design/pack-format.md)；示例在 [examples/packs/demo/](examples/packs/demo/)；选中工作区后顶栏"扩展包" |

**左栏排序**：项目和专题的条目可以拖到目标行上方或下方；选中一行后也可用 `Alt + ↑/↓` 调整。置顶项仍在前面，置顶组和普通组分别排序。拖动「项目」「专题」的标题还可以交换两个模块的上下位置。顺序保存在本机，刷新或重新打开同一 Studio 实例后沿用，改名后位置不变。

**从其他工具打开 Review**：AMO Studio 开着时，别的 harness 或脚本可以让它打开某个文件夹的 Git Review（文件夹还不是项目时自动登记）。

```
studio\amo-review.cmd G:\PROJECT\game                          未提交的改动
studio\amo-review.cmd G:\PROJECT\game --base main              工作区对比 main（含未提交的改动，可以写批注）
studio\amo-review.cmd G:\PROJECT\game --commit HEAD~1          某个提交（只读）
studio\amo-review.cmd G:\PROJECT\game --range main...agent     agent 分支离开 main 以来的改动（只读；A..B 是 B 对比 A）
studio\amo-review.cmd G:\PROJECT\game --mode file --file src\Drop.cs --line 24 --end-line 36
                                                            当前文件全文，定位第 24–36 行（不要求 Git 或文件有改动）
   可选：--file 路径（先选中这个文件，提交和范围也支持）、--session 会话id（「发给会话」默认发到这里；id 在会话栏点 # 复制）、--json
```

退出码 0 请求已接收、1 被拒绝（会说原因）、2 Studio 没在运行。也可以直接调 Host：`POST <host.json 的 url>/api/review/open`，头 `Authorization: Bearer <数据目录里 host-token 的内容>`。正文用 `path`（项目目录）或 `workspaceId` 选项目，其他字段见下表。开发版的数据目录是 `studio/.data`，Portable 版用 `--data` 指给它。

| 字段 | 含义 |
|---|---|
| `mode` | `changes`（默认）看 Git 改动；`file` 看当前文件全文 |
| `file` | 项目内的绝对路径或相对路径；全文模式必填，改动模式省略时看整个项目 |
| `line`, `endLine` | 全文模式的起止行（从 1 开始），结束行不能早于起始行 |
| `base` | 工作区对比这个 ref；也可与 `commit` 一起比较两个提交 |
| `commit` | 指定提交的改动，只读 |
| `range` | `A..B` 或 `A...B`，只读；不能与 `base` / `commit` 混用 |
| `sessionId` | 批注的默认接收会话 |

全文模式不带 `base` / `commit` / `range`。指定文件在比较范围内没有改动时返回 404，查看当前内容可改用全文模式。文件删除后的差异仍能在改动模式查看。重复打开会重新读取已保存的内容；成功响应表示已向窗口发送打开请求，不代表人已审阅。

**在 AMO 对话中让模型打开**：受管会话自带 MCP 工具 `review_open`。例如“打开 src/Drop.cs 的 reviewer，定位到 24–36 行”对应 `{ "mode": "file", "file": "src/Drop.cs", "line": 24, "endLine": 36 }`；“改完后让我看这个文件的差异”对应 `{ "file": "src/Drop.cs" }`。默认使用发起会话的项目，批注默认发回该会话；跨项目可传 `workspaceId`，无需模型提供会话 id 或读取 Host token。随项目保存的 skill 在 [skills/amo-review/SKILL.md](skills/amo-review/SKILL.md)，供后续接入 skill 加载器或外部 harness 使用。

**agent 能做什么（AMO MCP）**：受管的会话自动带上 AMO MCP。读：看板、任务、会话树、工程、画布、扩展包。写：只能写自己任务的进度、交接、清单，给别的会话留言，向你提问；画布写入每次都要你批准；调度会话只能提案。agent 不能移动看板列，也不能自己开会话。

**回答 agent 的问题**：Claude、GPT/Codex、DSH 通过 AMO `decision_request` 提问时，共用对话上的问题弹窗，可以收起或关闭，之后从上方的待决策提示重新打开；选项和未提交的文字会保留。来源标记为「跨工具请求 · AMO MCP」，并标「非阻断 · 留言返回」：当前回合可以继续做其他事，答案作为留言返回。Claude/Codex 的原生同步提问标「阻断式 · 等待回答」；Codex 原生异步提问标「非阻断 · 下一条消息返回」。MCP 表单标来源为跨工具请求，但其本身仍是阻断式，两者分别标识。DSH 当前接入的 ACP 没有原生问答通道，需要提问时使用 AMO MCP；Focus 保留选项快捷回答和「在工作台回答」。

## 和旧 AMO 的对应关系

| 旧 AMO | Studio |
|---|---|
| 工程内 Hook + Managed Launch/Resume，Hook 驱动任务卡片 | 不再往工程里部署 Hook。会话直接通过 Codex app-server / Claude Agent SDK 托管，状态实时进工作台 |
| 任务卡片（按 Hook 状态） | **任务**（看板列由你调整）+ 任务下的多个**会话**（运行状态自动更新） |
| Obsidian Reply Note + 批注 + "返回窗口" | 工作台里直接渲染回复、定位批注、汇总发回，不需要 Obsidian |
| Obsidian Canvas / Task Canvas | 工作台的**画布**（无限画布，按结构化数据保存，agent 也能读） |
| Focus Panel | **Focus 悬浮窗**：只列需要你处理的会话、待决策和调度提案 |
| Scratchpad（三页） | 任务页右栏的**草稿区**（一份全局的） |
| DeepSeek / GLM 路由 | 模型配置：Codex · DeepSeek Flash、Claude · GLM-5.3，以及你自己的订阅 Codex · GPT 订阅、Claude · Claude 订阅，新建任务或会话时选；DSH · DeepSeek 用你本机的 DeepSeek Harness 源码跑（设置 → 模型 里填源码位置） |
| Workspace Center 部署、Git exclude | 不需要：Studio 不往工程里写文件（扩展包是你自己放的） |
| Grok Build、ChatGPT 桌面端 Target | 暂不支持 |
| 鼠标侧键 / 全局快捷键 | 暂未实现 |

## 常见问题

- **数据在哪里？** Portable 版在首次设置选的目录（默认 exe 旁边的 `data/`）；里面有数据库、日志、Studio 自己的 Claude/Codex 配置。Studio 不改你的 `~/.codex/config.toml` 和 `~/.claude`。
- **换电脑**：把整个 `AMO Studio` 文件夹拷过去即可；新机器上要有 codex 和对应的凭据。
- **Host 是什么？** 后台常驻的服务，管会话和数据；关掉窗口它还在，会话不会断。开发时用 `npm run host:stop` 停掉。
- **密钥放哪？** Windows 凭据管理器。Studio 只读取，并且只传给模型进程，不写日志、不出现在命令行；agent 运行的命令读不到这些密钥。
- **GPT 订阅** 用你本机 Codex 的登录和默认模型，不用另外设置。**Claude 订阅** 要一个长期令牌：在终端运行 `claude setup-token`，登录后把打印出的令牌粘贴到 设置 → 模型凭据。这是 Studio 唯一会写入凭据管理器的一项，你可以随时在那里删除。
- **型号、思考强度、权限**：新建任务或会话时选；会话里点输入框左下角的「型号 · 强度 · 权限」随时切换（Claude 立即生效，Codex 下一轮生效）。常用组合在 设置 → 常用预设 里保存，之后一键切换。
- **命令权限**：Codex 会话里，agent 要运行的命令（除了少数已知安全的只读命令）都会先弹批准卡片；命令不在 Windows 沙箱里运行（你的 Codex 配置用的 unelevated 沙箱会让命令全部失败）。

## 开发者文件导航

| 文件 | 用途 |
|---|---|
| [STATUS.md](docs/STATUS.md) | 当前进度。两分钟读完 |
| [NEEDS_YOU.md](docs/NEEDS_YOU.md) | 需要用户处理的事项，用户直接在文件里回复 |
| [ROADMAP.md](docs/ROADMAP.md) | 全部阶段的目标、验收标准与关卡 |
| [LOOP_RULES.md](docs/LOOP_RULES.md) | 自动迭代（`/loop`）的规则与红线 |
| [plans/](plans/) | 每个阶段的详细任务清单 |
| [LOOP_LOG.md](docs/LOOP_LOG.md) | 每轮迭代的记录 |
| [spikes/RESULTS.md](spikes/RESULTS.md) | 预研结论（协议行为、打包等） |
| [budget.json](budget.json) | 真实模型调用预算与已用量 |

常用命令：`npm run verify`（类型检查、单测、构建）、`npm run e2e`（端到端，测试窗口在屏幕外、不抢焦点）、`npm run package:portable`、`npm run smoke:portable`。
