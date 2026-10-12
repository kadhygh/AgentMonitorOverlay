# 阶段 4 · Claude 与只读 MCP

分支：`studio/stage-4`（从 `studio/main` 创建）。目标、验收和关卡见 `ROADMAP.md`：Claude（包括 GLM 路由）会话进入同一棵会话树；agent 可以读取工作台。

依据：ROADMAP 阶段 4；`design/interaction-notes.md` 的"在终端打开"（Claude：工作台只读、提示条、"立即收回"）；阶段 1～3 的实际结果（会话树、写入状态、`canvasOutline` 已是纯函数）；`spikes/RESULTS.md` 里 Codex 部分的做法。

## 已确定的做法

| 项目 | 做法 | 说明 |
|---|---|---|
| Claude 运行时 | Host 里新增 `ClaudeRuntime`，用 Claude Agent SDK `@anthropic-ai/claude-agent-sdk` 0.3.296（与本机 `claude` 2.1.296 同版本） | 与 `CodexRuntime` 并列，HostService 按会话的 `runtime` 分派 |
| 不碰用户的 `~/.claude` | 受管的 Claude 会话一律设置 `CLAUDE_CONFIG_DIR` 指向 Studio 数据目录下的 `claude-home`（测试指向沙箱）；会话记录、设置都在那里 | 红线 2；"在终端打开"时终端也带同一个 `CLAUDE_CONFIG_DIR`，才能 `--resume` 到同一会话 |
| 模型 | Claude 运行时的模型配置都显式指定 provider：GLM 走 Anthropic 兼容接口（`ANTHROPIC_BASE_URL` + 密钥只进子进程环境变量）；测试用 testkit 新增的 mock Anthropic 接口 | loop 不调用 Claude 订阅；订阅登录的配置可以保留给你自己用，loop 不运行它 |
| GLM 密钥 | 和 DeepSeek 一样从 Windows 凭据管理器只读获取（`AgentMonitorOverlay/model-provider/<id>`），具体 id 在 S4-00 确认 | 红线 2、9 |
| 审批 | SDK 的 `canUseTool` 回调转成工作台的审批卡片（与 Codex 同一种 `approval` 条目），批准或拒绝后回调返回 | 不做自动审批 |
| 分支与子 agent | 分支用 SDK 的 fork（`forkSession`）；子 agent 按 `parent_tool_use_id` 归到父会话下，显示方式与 Codex 子 agent 一致 | 会话树沿用阶段 1 的结构 |
| 交接到终端 | "在终端打开"启动 `claude --resume <id>`（带同一 `CLAUDE_CONFIG_DIR` 和模型环境变量），工作台变为只读并显示提示条；终端退出后自动收回，或点"立即收回" | interaction-notes；测试里用 RecordingTerminalLauncher，不真开终端 |
| 只读 MCP | Host 提供 AMO MCP（只读）：看板、任务、会话树摘要、项目上下文、`canvas.read`（直接用 `canvasOutline`）；传输方式在 S4-06 选定（优先本机 HTTP，带 token） | 写操作在阶段 5 |
| MCP 注入 | Host 启动受管会话时自动带上 AMO MCP：Codex 在 app-server 启动参数里配置，Claude 通过 SDK 的 `mcpServers` | 不改用户的全局配置 |
| 额度 | 日常开发与 e2e 全部用 mock；S4-00 预研和阶段末冒烟用 GLM，预计不超过 40 次 | 预算见文末 |

## 任务

### S4-00 预研：Claude Agent SDK 在 Windows 上的行为 · done（结论见 `spikes/RESULTS.md` 第 h 节）
- 依赖：无
- 内容：在沙箱里（`%TEMP%\\amo-studio-sandbox\\`，`CLAUDE_CONFIG_DIR` 指向沙箱）用 GLM 跑最小脚本，确认：SDK 版本与它调用的 Claude Code 可执行文件；流式事件的种类；`resume`、`forkSession`；子 agent 事件里的 `parent_tool_use_id`；`canUseTool` 能否挂起等待人工决定；`interrupt`；会话记录存放位置；`claude --resume` 在同一 `CLAUDE_CONFIG_DIR` 下能否接上；`claude --bg` 和 `attach` 是否可用作共享。确认 GLM 凭据 id（只列条目名，不读值到输出）。
- 验收：结论写进 `spikes/RESULTS.md` 新的一节；GLM 用量记入 `budget.json`。

### S4-01 mock Anthropic 接口 · done
- 依赖：S4-00
- 内容：testkit 增加 mock Anthropic Messages 接口（流式 SSE），支持和 mock Responses 相同的指令：`[[shell: cmd]]`（发起工具调用，触发审批）、`[[slow]]`、`[[markdown]]`、`[[spawn: name: msg]]`（子 agent）。
- 验收：单元测试；用 SDK 对着 mock 跑通一轮。

### S4-02 ClaudeRuntime：创建、发送、中断、恢复 · done
- 依赖：S4-01
- 注意（S4-01 发现）：始终显式传 `permissionMode: "default"`（CLI 默认是 `auto`，等于自动审批）；一个 `query()` 里可能有多个 `result`（后台子 agent 结束后父会话会自动再跑一轮）。
- 内容：`ClaudeRuntime` 实现与 `CodexRuntime` 相同的接口：新建会话、发送消息、生成中发的消息排队到下一轮（预研确认 SDK 不会插进当前回合，界面上写"排队"）、打断（`interrupt()` 之后的异常按"已打断"处理）、Host 重启后恢复；事件转成统一的会话条目（用户消息、回复流式增量、工具卡片、审批）。
- 验收：Host 单元测试 + 集成测试（mock）。

### S4-03 审批、分支与子 agent · done
- 依赖：S4-02
- 注意（S4-01 发现）：`Agent` 调用的参数里如果带 `mode`（如 `bypassPermissions`），`canUseTool` 要去掉它再放行，子 agent 才不会绕过审批；后台子 agent（`run_in_background`）结束时父会话会多出一轮。
- 内容：`canUseTool` 转成审批卡片；分支（从某条回复分支用 `forkSession(id, { upToMessageId })`，不调模型）进入会话树；子 agent 按 `parent_tool_use_id` 归组显示为摘要——它没有独立 session id，"查看"展开父会话里那段内容。
- 验收：集成测试覆盖批准、拒绝、分支、子 agent。

### S4-04 模型配置与新建会话 · done
- 依赖：S4-02
- 内容：模型配置里加入 Claude 运行时的配置（GLM、mock）；新建任务和新会话时可以选到；会话标题栏显示运行时和模型。
- 验收：e2e：用 mock 的 Claude 配置新建任务、对话、批准。

### S4-05 交接到终端（只读）与收回 · done
- 依赖：S4-03
- 内容：Claude 会话"在终端打开"后，工作台只读并显示提示条和"立即收回"；终端进程退出后自动收回；收回后工作台读取终端期间新增的内容。
- 验收：e2e（RecordingTerminalLauncher 模拟终端进程的启动和退出）。

### S4-06 AMO MCP（只读） · done
- 依赖：无
- 内容：Host 提供 MCP 服务：`board.list`、`task.get`、`session.tree`（摘要，不含全文）、`project.context`（工作区路径、名称）、`canvas.read`（大纲 + JSON）。传输方式与鉴权在实现前定下，写进计划。
- 定下的做法：挂在 Host 自己的 HTTP 服务上，路径 `/mcp`，Streamable HTTP 无状态模式（每个请求一个 MCP 服务），和 REST 接口用同一个 Host 令牌（`Authorization: Bearer`）。工具名用下划线：`board_list`、`task_get`、`session_tree`、`project_context`、`canvas_read`（部分客户端不接受带点的工具名），都标为只读。
- 验收：单元测试；用 MCP 客户端读取各工具。

### S4-07 受管会话自动注入 MCP · done
- 依赖：S4-06、S4-02
- 内容：Codex 和 Claude 的受管会话启动时都带上 AMO MCP；agent 在会话里能调用 `canvas.read` 等工具。
- 验收：e2e（mock 模型发起 MCP 工具调用，回复里能看到读到的画布大纲）。

### S4-08 GLM 真实冒烟 · todo
- 依赖：S4-02～S4-07
- 内容：用 GLM 在沙箱工作区跑一次完整流程：新建 Claude 会话、执行需要审批的命令、分支、调用 `canvas.read`；截图。
- 追加（S4-07）：再用 DeepSeek Flash 跑一个带 MCP 的 Codex 回合，确认模型目录关掉 `tool_search` 后 DeepSeek 能正常调用 MCP 工具（约 3 次 DeepSeek）。
- 验收：结果写进日志；GLM 用量记入 `budget.json`。

### S4-09 阶段验收与收尾 · todo
- 依赖：S4-00～S4-08
- 内容：完整 e2e 与截图；`LOOP_RULES` 第 6 节收尾；"请你过目"附截图与试用方式。
- 验收：ROADMAP 阶段 4 的验收通过。

## 预算预估

DeepSeek 0 次；GLM 约 40 次（S4-00 预研约 25 次，S4-08 冒烟约 15 次）。
