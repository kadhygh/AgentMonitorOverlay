# S1-00 协议补测结论

> **2026-10-13 更正**：a～d 的脚本用 `spawn("codex")` 拉起 app-server，在这台机器上解析到的是 Codex 桌面版自带的 `codex.exe` **0.144.1**，不是终端里的 npm 版 0.161.0。脚本已改为显式使用 npm 版，c、d 两节的关键结论在 S1-00f 用 0.161 复测。

环境：Codex CLI 0.161.0（实际为 0.144.1，见上方更正），app-server 走 WebSocket 加 capability token，模型路由 DeepSeek Flash（`spikes/lib.mjs` 的 `deepseekConfigArgs`）。沙盒工作区在 `%TEMP%\amo-studio-sandbox\` 下。原始记录在 `spikes/results/`。

## j. Codex 会话的调用者身份（2026-10-13，S5-00，mock 模型，不消耗额度）

脚本：`spikes/s5-00-codex-identity.mjs`；结果：`spikes/results/s5-00.json`。一个 app-server（mock 模型、沙箱 `CODEX_HOME`）上开多个会话，各自在 `thread/start` 的 `config` 里覆盖 AMO MCP 设置，再调用一个记录请求头的探针 MCP 工具。

| 做法 | 结果 |
|---|---|
| `config: { "mcp_servers.amo.http_headers": { "X-AMO-Session": … } }`（点号写法） | **有效**，探针收到这个会话自己的请求头，其余设置（url、令牌）保留 |
| `config: { "mcp_servers.amo.url": "…/mcp?session=…" }` | 有效 |
| `config: { mcp_servers: { amo: { http_headers: … } } }`（嵌套写法） | 报错 "invalid transport"：嵌套写法替换整张表，丢了 url |
| 会话已加载时，换一个连接 resume（带或不带 config） | 保留最初的身份，resume 带的 config 不生效 |
| app-server 重启后 resume，不带 config | **身份丢失**（没有请求头） |
| app-server 重启后 resume，带 config | 用新带的身份 |

另外两点：
- Codex 0.161 调用**没有 `readOnlyHint` 的 MCP 工具前，会发 `mcpServer/elicitation/request`** 征求批准（"Allow the amo MCP server to run tool …?"），回复 `{ action: "accept" | "decline", content, _meta }`；审批策略为 `never` 时直接拒绝。阶段 4 的工具都标了只读，所以没有出现。阶段 5 的写入工具会触发它，`CodexRuntime` 必须把它转成审批卡片，否则回合会一直等。
- 带 `readOnlyHint: true` 的工具在 `on-request` 下不征求批准。

结论（写进阶段 5 的做法）：
- 每个 Codex 会话在 `thread/start` 时带 `mcp_servers.amo.http_headers.X-AMO-Session-Token = <这个会话的随机令牌>`；Host 把令牌映射回会话。令牌经 WebSocket RPC 传递，不进命令行；agent 的命令环境里没有 MCP 服务令牌（阶段 4 已排除），伪造不了别的会话。
- `CodexRuntime` 重新订阅（app-server 重启、Host 接管）和 fork 时都要带上对应会话的身份配置；终端接入的 TUI 在已加载的会话上，身份保留。
- 没有身份的 MCP 调用（例如 Codex 自己派生的子 agent，或身份丢失时）只能用只读工具，写入工具拒绝并说明原因。

## i. MCP 注入（2026-10-13，S4-07，mock 模型，不消耗额度）

- **Codex**：app-server 启动时加 `-c mcp_servers.amo.url="<Host>/mcp"` 和 `-c mcp_servers.amo.bearer_token_env_var="AMO_STUDIO_MCP_TOKEN"`，令牌只放在 app-server 的环境变量里。用的是 MCP 专用令牌，只能打开 `/mcp`，打不开可写的 REST 接口（agent 执行的命令可能继承 app-server 的环境变量）。
- **Codex 0.161 默认把 MCP 工具藏在 `tool_search` 后面**：模型目录里 `supports_search_tool: true` 时，请求只带一个 Responses 托管工具 `{"type":"tool_search","execution":"client"}`，MCP 工具要等模型先搜索才给出。DeepSeek 兼容接口大概率不支持这种托管工具，所以我们自己维护的模型目录（DeepSeek Flash、mock）改成 `supports_search_tool: false`，MCP 工具直接作为普通函数提供。`codex-default` 用 Codex 内置目录，不受影响。DeepSeek 带 MCP 的真实请求在 S4-08 冒烟里验证。
- **Claude**：没有用 HTTP——SDK 把 `mcpServers` 配置交给 CLI 时可能出现在命令行上（令牌会暴露）。改用 SDK 的进程内服务 `createSdkMcpServer`，工具在 Host 进程里执行，CLI 通过 SDK 的内部通道调用，不需要令牌。这五个工具只读 Studio 自己的状态，用 `allowedTools` 预先放行，其余工具照常走 `canUseTool`。
- 交接到终端的 Claude（`claude --resume`）不带 AMO MCP（进程内服务只存在于 Host 的 SDK 进程）。
- S4-08 真实冒烟（`scripts/smoke-stage4.mjs`，结果 `spikes/results/s4-08-smoke.json`）：
  - GLM 通过 Claude 会话调用 `mcp__amo__canvas_read`，正确答出分组名；
  - DeepSeek Flash 通过 Codex 会话调用 MCP 工具（Codex 里的名字是 `amo.canvas_read`），正确答出分组名——关掉 `tool_search` 后 DeepSeek 可以直接调用 MCP 工具；
  - SDK 会对 `allowedTools` 打出警告 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`（这五个工具不再经过 `canUseTool`），这是有意为之。

## h. Claude Agent SDK 在 Windows 上的行为（2026-10-13，S4-00，GLM 12 次）

脚本：`spikes/s4-00-claude-sdk.mjs`（按参数选实验）；原始结果：`spikes/results/s4-00.json`。环境：SDK `@anthropic-ai/claude-agent-sdk` 0.3.296（自带 win32-x64 的 Claude Code 2.1.296，和本机 `claude` 2.1.296 同版本）；GLM 路由沿用旧 AMO 的 glm-5.3 预设（`ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic`、`ANTHROPIC_MODEL=glm-5.3[1m]`，密钥放 `ANTHROPIC_AUTH_TOKEN`，凭据 id `glm-5.2`）；`CLAUDE_CONFIG_DIR` 和工作区都在 `%TEMP%\amo-studio-sandbox\s4-00\`；`settingSources: []`。

| 项目 | 结果 |
|---|---|
| 基本一轮 | 正常。事件：`system:init`（含 `claude_code_version`、`model`、`tools`、`mcp_servers`）、`system:status`、`system:thinking_tokens`、`stream_event`（`message_start`/`content_block_delta`/…，需 `includePartialMessages`）、`assistant`（每个完成的内容块一条）、`result`。 |
| 会话记录位置 | `<CLAUDE_CONFIG_DIR>/projects/<cwd 转义>/`。每次实验前后检查 `~/.claude.json` 和 `~/.claude/settings.json` 的修改时间，都没变（红线 2）。 |
| 审批 | `echo` 这类只读命令会被自动放行，**不经过** `canUseTool`；`mkdir` 会调用 `canUseTool(toolName, input, ctx)`，回调挂起 3 秒期间回合一直等待，`allow` 后命令执行。`ctx` 里有 `toolUseID`、`title`、`description`、`displayName`、`suggestions`、`signal` 等，够做审批卡片。`deny` 后命令不执行，回复里说明被拒，`result.permission_denials` 列出这次调用。 |
| 恢复 | `resume: <sessionId>` 接着原会话，session id 不变，记得上文。 |
| 分支 | `resume` + `forkSession: true` 得到新 session id，带着原会话上下文回复。另有不调模型的 `forkSession(sessionId, { upToMessageId })` 函数，可以只复制到某条消息为止——适合"从这条回复分支"；但它在 Host 进程里运行，读的是**进程自己的** `CLAUDE_CONFIG_DIR`，不认 `options.env`。 |
| 子 agent | 工具名 `Agent`。子 agent 的消息带 `parent_tool_use_id`（等于父会话里那次 `Agent` 调用的 id），session id 和父会话相同；另有 `system:task_started` / `task_updated` / `task_notification` 事件。 |
| 打断 | `query.interrupt()` 后结果为 `error_during_execution`，随后迭代器**抛出异常**（`Claude Code returned an error result`）。 |
| 插话 | 流式输入里在生成中途推入第二条消息，**不会**插进当前回合：第一轮照常数到 40 结束，第二条作为下一轮处理（共两个 `result`）。 |
| 真实 CLI 接续 | 同一 `CLAUDE_CONFIG_DIR` 下 `claude -p --resume <id>` 接上 SDK 创建的会话，session id 相同，记得上文。 |
| 共享方式 | `claude --help` 里有 `--bg`（后台会话）、`claude attach <id>`、`agents`、`logs`、`stop`。未实测，S4-05 再评估能否用作共享。 |

结论（写进阶段 4 的做法）：
- SDK 版本锁定 0.3.296，与本机 CLI 同版本，交接到终端时会话格式一致。peer 依赖锁定：`zod` 4.6.6、`@anthropic-ai/sdk` 0.133.0、`@modelcontextprotocol/sdk` 1.32.1。
- Host 给 Claude 子进程的环境变量：继承的环境去掉所有 `ANTHROPIC_*` / `CLAUDE*`，再加上模型路由和 `CLAUDE_CONFIG_DIR`；Host 进程本身也设置同一个 `CLAUDE_CONFIG_DIR`，`forkSession` 等函数才能找到会话。
- 审批：`canUseTool` 挂起，转成工作台的审批卡片，和 Codex 走同一套界面。只读命令被 CLI 自动放行，这是 Claude Code 自身的行为，不算"自动审批"。
- 打断：调用 `interrupt()` 后出现的那次异常按"已打断"处理，不当作出错。
- 插话：Claude 会话里生成中发出的消息排到下一轮，界面上的按钮和提示要说明"排队"，不能写成"插话"。
- 分支：从某条回复分支时用 `forkSession(id, { upToMessageId })`，不调模型；在会话末尾分支也可以用 `resume` + `forkSession: true`。
- 子 agent：按 `parent_tool_use_id` 归到父会话里那次 `Agent` 调用下面，显示成一条摘要；它没有独立的 session id，所以"查看"展开的是父会话里的那段内容，而不是一个独立会话（与 Codex 子 agent 不同，S4-03 处理）。

S4-01 用 mock Anthropic 接口补充发现（不消耗额度）：
- **不传 `permissionMode` 时 CLI 默认是 `auto`**：由一个模型分类器代替人决定批不批，`canUseTool` 不会被调用（mock 收到了分类器的请求）。预研脚本显式传了 `"default"` 所以没暴露。**Host 必须始终显式传 `permissionMode: "default"`**，否则就是自动审批。
- `Agent` 工具默认在**后台**运行子 agent（工具结果是 "Async agent launched successfully"）；子 agent 结束后 CLI 通知父会话，父会话**自动再跑一轮**，同一个 `query()` 里会出现两个 `result`。Runtime 不能假设"一次发送对应一个 result"。
- `Agent` 工具的参数里有 `mode`（可取 `bypassPermissions`、`auto`、`dontAsk` 等）和 `run_in_background`。
  - S4-03 实测更正：`Agent` 调用本身**不经过** `canUseTool`；父会话为 "default" 时，子 agent 带 `bypassPermissions`/`auto`/`acceptEdits`/`dontAsk` 去执行 `mkdir`，**仍然**走 `canUseTool` 要人批准，没有绕过。
  - 作为保险，Host 仍用 `PreToolUse` 钩子（matcher `Agent|Task`）把 `mode` 去掉；集成测试验证带 `bypassPermissions` 的子 agent 执行命令前会出审批卡片。
- 这个版本的 CLI 会在请求的消息列表里追加 `role: "system"` 的消息（环境信息、剩余 token），用户消息里还有 `<system-reminder>` 文本块。
- 子 agent 的消息（S4-03）：
  - 前台子 agent 运行中，它的工具调用和结果会带着 `parent_tool_use_id` 流出来，但**最终文字回复不会流出来**，只在父会话那次 `Agent` 工具结果的 `tool_use_result.content` 里（`tool_use_result` 还有 `status`、`agentId`、用量等）；
  - 后台子 agent 的文字回复会流出来；
  - 前台和后台都会发 `task_started`/`task_notification`（带 `tool_use_id`）；
  - 完整记录可以用 `getSubagentMessages(sessionId, agentId)` 读，Studio 暂不需要。

## f. 用 npm 版 Codex 0.161 复测（2026-10-13，mock 模型，不消耗额度）

脚本：`spikes/s1-00f-recheck.mjs`，原始记录 `spikes/results/s1-00f.json`。a～d 的检查项改用本地 mock 模型（`packages/testkit` 的 `startMockModel`）在 0.161 上重跑，检查的是协议行为，与模型无关。

| 检查项 | 0.144.1（a～d 当时） | 0.161.0 |
|---|---|---|
| 审批广播给所有订阅者、先到先得、广播 `serverRequest/resolved` | 是 | 是 |
| 审批挂起后才订阅的客户端补收请求 | 是 | 是 |
| 一个 server 按 thread 指定多个 provider | 是 | 是 |
| `thread/list` 不带 `modelProviders` 只列默认 provider | 是 | 是 |
| 按 thread 传入的 provider 定义，重启后 resume 不带 config | 失败 | 失败（同样的报错） |
| provider 定义在 server 启动参数里，重启后 resume 不带 config | 成功 | 成功，并能继续对话 |
| fork 不带 `modelProvider` 时落到 server 默认 provider | 是 | 是 |
| 订阅父 thread 的客户端收到带 `forkedFromId` 的 `thread/started` | 是 | 是 |
| `thread/list` 列出 fork | **否** | **是** |
| 给模型的 shell 工具 | `shell_command { command }` | `exec_command { cmd }` |

结论：a～d 对设计的影响全部成立，S1-06 按原结论实现。差异只有两处：0.161 的 `thread/list` 会列出 fork（Host 仍以自己的会话树为准）；mock 模型已兼容两种 shell 工具格式。fake app-server 已按 0.161 的列表行为调整。

## g. 子 agent 在 0.161 上的事件（2026-10-13，S1-11c 发现，mock 模型）

真实 Codex 0.161 创建子 agent 时**不发 `thread/started`**，只在父 thread 上发 `subAgentActivity`（`kind: started/completed`，带 `agentThreadId` 和 `agentPath`，如 `/root/explorer`）；子 thread 的 turn 与 item 事件在同一连接上推送。子 agent 收到的任务是一条 `agent_message`（`Message Type: NEW_TASK`，任务名明文、内容加密）。Host 改为在收到 `subAgentActivity` 时建子会话；fake app-server 已对齐此行为。插话（`turn/steer`）的内容在下一次模型采样时才作为 userMessage 出现。

## a. 审批路由（2026-10-12，DeepSeek 2 次）

脚本：`spikes/s1-00a-approval.mjs [1|2]`。A 用 `approvalPolicy: "untrusted"`、`sandbox: "read-only"` 建 thread 并发起一轮对话，B 在 `turn/start` 之后 `thread/resume` 订阅同一 thread。两个客户端都不自动回应。

| 现象 | 变体 1：B 先 accept，A 1.5 秒后 decline | 变体 2：A 先 decline，B 1.5 秒后 accept |
|---|---|---|
| 谁收到 `item/commandExecution/requestApproval` | A 和 B 都收到，JSON-RPC id 相同、itemId 相同 | 同左 |
| 先回应之后 | 服务端向 A、B 都发 `serverRequest/resolved`（`{threadId, requestId}`） | 同左 |
| 晚到的回应 | 被忽略，没有报错，没有新的审批请求 | 同左 |
| 结果 | 命令执行了（`status: failed, exit 1`，因为只读沙盒挡住了写文件） | 命令被拒绝（`status: declined`，"exec command rejected by user"） |

结论：

1. 审批请求**广播给所有订阅了该 thread 的客户端**，以**先到的回应为准**，随后广播 `serverRequest/resolved`。不存在"只发给发起方"的情况。
2. 所以 AMO 和 `--remote` 接入的 TUI 同时在线时，任何一方都可以批准，另一方的界面需要靠 `serverRequest/resolved` 关掉待处理的审批卡片。
3. B 在 `turn/start` 之后才订阅，仍然收到了审批请求，因为请求在订阅之后才到。尚未验证：审批已经挂起之后才订阅的客户端，能否补收到这条请求。如果收不到，Host 需要自己保存待处理的审批，给晚连上的界面使用。
4. 顺带发现：**新建的 thread 在第一轮对话之前没有 rollout**，此时其他客户端 `thread/resume` 会报 `no rollout found`。Host 要么由自己这条连接发起第一轮，要么在第一轮开始后再让别的客户端订阅。

对 S1-06 的影响：

- 审批是"thread 级广播、先到先得"。Host 作为一个客户端收到审批后，转给界面等人决定；如果 TUI 先回应了，Host 收到 `serverRequest/resolved` 就把这条审批标记为"已在别处处理"。
- Host 不需要做审批互斥，服务端已经保证只有一个回应生效。
- 模型回复不可信：变体 1 里命令其实执行了，模型却回复 DENIED。界面以 item 状态为准，不以模型的文字为准。

## b. 单 server 多 provider（2026-10-12，DeepSeek 2 次）

脚本：`spikes/s1-00b-multi-provider.mjs`。app-server 启动时**不带任何 provider 参数**，`CODEX_HOME` 指向空的沙盒目录（没有 ChatGPT 登录，误路由只会失败，不会花 GPT 额度）。DeepSeek 的 Key 放在 server 进程的环境变量里。在同一个 server 上用两个不同的 provider id 各建一个 thread，`thread/start` 传：

```js
{ model: "deepseek-flash", modelProvider: "amo-ds-a",
  config: { model_providers: { "amo-ds-a": { name, base_url, wire_api: "responses", env_key: "DEEPSEEK_API_KEY" } },
            model_catalog_json: "<catalog>", model_reasoning_effort: "low" } }
```

| 现象 | 结果 |
|---|---|
| `thread/start` 响应 | `model`、`modelProvider`、`thread.modelProvider` 都是指定的值 |
| 两个 thread 并发各跑一轮 | 都 `completed`，分别答出 ALPHA-OK、BRAVO-OK |
| `thread/list` 带 `modelProviders` | 两个 thread 都列出，带各自的 `modelProvider` |
| `thread/list` 不带过滤 | 空列表（默认只列默认 provider） |
| `thread/read` | 返回正确的 `modelProvider` |

结论：

1. **一个 app-server 可以同时承载多个 provider**，provider 在 `thread/start` 的 `modelProvider` 加 `config.model_providers` 里按 thread 指定，不需要每个 provider 一个进程。
2. 各 provider 的 Key 仍然只能放在 server 进程的环境变量里（`env_key`），所以 Host 拉起 server 时要把所有已配置 provider 的 Key 都放进环境变量。
3. `thread/list` 必须带 `modelProviders`，否则看不到非默认 provider 的 thread（和阶段 0 的发现一致）。

对 S1-06 的影响：

- ~~采用每个 Codex home 一个 app-server~~，已被 d 节修正为"每个模型 profile 一个 app-server"。模型 profile 落成"`modelProvider` + `model` + `config` 片段"，在 `thread/start` 时带上。
- S1-00c 修正了这一点：provider **定义**必须放在 server 启动参数里，`thread/start` 只做选择，见 c 节。

## c. 重启重连（2026-10-12，DeepSeek 5 次，其中 1 次是第一版脚本中途失败）

脚本：`spikes/s1-00c-restart.mjs thread|server`。`CODEX_HOME` 用沙盒空目录。A1 建 thread 并跑一轮（记住暗号 KIWI-7），然后停掉 server，用**同一端口、同一 token** 重启。新客户端 A2 `thread/resume`，再发一轮：先执行一条需要审批的命令，再说出暗号。审批挂起后，客户端 B 才连上并 `thread/resume`。

| 现象 | mode thread：provider 定义放在 `thread/start` 的 `config` | mode server：provider 定义在 server 启动参数 `-c model_providers.<id>.*`，thread 只选 `modelProvider` |
|---|---|---|
| 重启时已连接的 A1 | 收到 WS 关闭 | 同左 |
| 重启后 `thread/resume` 不带 config | **失败**：`failed to load configuration: Model provider amo-ds-c not found` | 成功，`modelProvider` 正确 |
| `thread/resume` 带上原 config | 成功 | 不需要 |
| 重启后的这一轮 | 完成，答出 KIWI-7，命令执行 | 同左 |
| 审批挂起后才订阅的 B | **能补收到**这条审批请求（id 相同），B 的回应生效 | 同左 |
| B 订阅已加载的 thread 时不带 config | 成功（thread 已加载，不再读 provider 配置） | 成功 |

结论：

1. **按 thread 传入的 provider 定义不会持久化**。thread 记录里只有 provider id，重新加载时要在 server 配置里找到同名 provider，否则加载失败。
2. **provider 定义放在 server 启动参数里**（`-c model_providers.<id>.*` 和 `model_catalog_json`），thread 只用 `modelProvider` 和 `model` 选择，重启后 resume 不带任何 config 也能恢复路由，上下文完整。
3. 已加载的 thread，其他客户端（包括 `codex --remote` 接入的 TUI）resume 时不需要 config。未加载的 thread 由 TUI 直接 `--remote resume`，只有在 mode server 下才能成功，因为 TUI 无法传 config。
4. **挂起的审批会补发给后来订阅的客户端**，所以 Host 重启或界面重连后，可以从 server 拿回待处理的审批，不需要 Host 自己持久化挂起状态（Host 本身重启除外：Host 重启时 server 也可能一起重启，此时 turn 已中断）。
5. 同一端口加同一 token 重启后，客户端重新连接即可，不需要重新握手之外的任何步骤。

对 S1-06 的影响：

- **全部模型 profile 的 provider 定义在 app-server 启动时一次性传入**；新增或修改 profile 需要重启 server（或者再起一个 server）。`thread/start` 只带 `modelProvider`、`model`、`config.model_reasoning_effort` 等不影响加载的项。
- server 端口和 token 固定保存在数据目录，崩溃重启时沿用，客户端断线后自动重连并对已打开的 thread 重新 `thread/resume`。
- 界面重连后从 resume 补收挂起的审批即可。

## d. 其他客户端发起的 fork（2026-10-12，DeepSeek 计数 7 次，其中 2 次实际请求打到了 OpenAI 并 401，没有消耗任何额度）

脚本：`spikes/s1-00d-fork.mjs`（A fork，B 观察），`spikes/s1-00d-fork-provider.mjs`（fork 的 provider 继承）。`CODEX_HOME` 用沙盒空目录。

| 现象 | 结果 |
|---|---|
| A `thread/fork` 的响应 | `thread.forkedFromId` 指向父 thread；`thread.turns` 带上父 thread 的历史 |
| 订阅了父 thread 的 B | 收到 `thread/started`，其中 `thread.forkedFromId` 指向父 thread，另有 `parentThreadId`、`agentRole` 等字段 |
| B `thread/loaded/list` | 包含 fork 出来的 thread |
| B `thread/read` fork | 有 `forkedFromId` |
| B `thread/list`（带 `modelProviders`） | **不包含** fork 出来的 thread，fork 跑过一轮之后也不包含 |
| A 在 fork 上跑一轮，B 没有订阅 fork | B 只收到这个 thread 的 `thread/status/changed`，收不到 item 事件 |
| **fork 不指定 `modelProvider`** | **用的是 server 的默认 provider，不继承父 thread 的。** server 没设默认时落到 OpenAI：沙盒里没有登录，所以 401，没有消耗额度；换成用户真实的 `CODEX_HOME`，这一轮就会用掉 GPT 订阅 |
| fork 显式带 `modelProvider`、`model` | 继承正确，上下文完整（答出 PLUM-3） |
| server 启动时设了默认 `model_provider` | 不指定的 fork 落到这个默认 provider |

结论：

1. **fork 关系可以实时拿到**：任何客户端只要订阅了父 thread，就能从 `thread/started` 的 `thread.forkedFromId` 得知新 fork，不需要轮询。`thread/list` 不可靠（不列 fork），Host 要以自己记录的会话树为准。
2. **fork 不继承父 thread 的 provider，这是安全问题**。Host 自己发起的 fork 必须显式带 `modelProvider` 和 `model`；但 `--remote` 接入的 TUI 里执行 `/fork` 或打开 side chat 时，不会带这两个参数。
3. 观察 fork 内的事件需要单独 `thread/resume` 这个 fork。

对 S1-06 的影响（修正 b 节的结论）：

- **每个模型 profile 一个 app-server**，启动时把该 profile 设为 server 默认（`-c model_provider=... -c model=...`），同时把所有 provider 的定义都传进去。这样 TUI 里的 `/fork`、side chat、子 agent 默认都留在同一个 profile 上，不会意外落到 GPT。thread 按 provider 归到对应的 server。
- Host 发起的 fork 依然显式带 `modelProvider`、`model`，双重保险。
- Host 收到 `thread/started` 时检查新 thread 的 `modelProvider` 和父 thread 是否一致；不一致就在界面上标红提醒。
- 收到带 `forkedFromId` 的 `thread/started` 后，Host 立即写入会话树，并自动 `thread/resume` 订阅这个 fork。
- 子 agent 的 provider 是否也落到 server 默认，留到 S1-06 用 mock 模型验证。
