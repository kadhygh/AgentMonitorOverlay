# 协议驱动 Session 技术验证

日期：2026-10-12。状态：验证完成，尚未进入设计和实现。

## 背景与目的

AMO 下一轮计划从“hook 监控外部 CLI”转向“协议驱动 session + 看板/画布工作台”。现有 hook 方案的主要问题是 side chat、resume、new、subagent 都会产生难以归属的新 session，单线管理方式无法表达它们的关系。

协议驱动的主要顾虑是：所有 session 统一由 AMO 管理以后，是否还能像现在一样随手使用原版 CLI。本次验证只回答一个问题：**协议托管的 session 能否与原版 CLI 互通，且能拿到 fork / subagent 的结构化关系。** 同时确认 DeepSeek、GLM 这类弱模型能否走同一条协议路径。

验证代码只在 session scratchpad 中运行，没有修改 AMO 运行代码，也没有提交。

## 环境

| 项目 | 版本 / 配置 |
|---|---|
| Codex CLI | 0.161.0，`codex app-server --listen ws://127.0.0.1:<port> --ws-auth capability-token` |
| Claude Code | 2.1.296；`@anthropic-ai/claude-agent-sdk` 0.3.296 |
| Node.js | 24.13.0 |
| Codex 路由 | AMO 现有 DeepSeek Flash provider 参数（`deepseek-profile-v41-flash-flash-all`），Key 从 Windows Credential Manager 读入进程环境 |
| Claude 路由 | AMO 现有 `glm-5.3` preset 环境变量，Key 同上 |

## 结果

| 检查项 | Codex app-server（DeepSeek） | Claude Agent SDK（GLM） |
|---|---|---|
| 弱模型走协议 | 通过 | 通过 |
| 协议创建的 session 由原版 CLI 继续 | 通过：`codex exec resume <id>` 答出暗号 | 通过：`claude -p --resume <id>` 答出暗号 |
| CLI 写入后协议侧继续 | 通过：重新 `thread/resume` 后看到 CLI 写入的轮次 | 通过：`resume` 同一 ID 并接上上下文 |
| 第二客户端实时观察 | 通过：B 执行 `thread/resume` 后收到 A 发起的完整事件流 | 无对应机制，单进程驱动 |
| 原版 TUI 接入共享 server | 通过，见下文 | 未测（候选：`claude --bg` + `claude attach`） |
| fork 关系 | 通过：`thread/fork` 返回 `forkedFromId`，`thread/read` 可读；父 thread 不受影响 | 通过：`resume + forkSession` 或 `forkSession()` 生成新 ID；父 session 不受影响 |
| 列表接口带关系 | 不带：`thread/list` 不返回 `forkedFromId` | 不带：`listSessions` 没有父子字段 |
| subagent 关系 | 通过：父 thread 出现 `subAgentActivity`，带 `agentThreadId`；子 agent 事件在同一连接推送；`thread/loaded/list` 含子 thread | 通过：开启 `forwardSubagentText` 后，子对话消息带 `parent_tool_use_id`，可对应父消息中的 `Agent` tool_use |
| 两个独立进程同时写同一 session | 失败：已加载的 server 看不到 CLI 写入的轮次，模型上下文分叉 | 失败：CLI 写入的轮次成为孤立分支，后续历史读取不到 |

### 原版 Codex TUI 接入 AMO 的 server

AMO 进程启动 WebSocket app-server 并创建 thread 后，用户执行：

```powershell
$env:AMO_SPIKE_TOKEN='<capability token>'
codex --remote ws://127.0.0.1:<port> --remote-auth-token-env AMO_SPIKE_TOKEN resume <threadId>
```

实际表现：

- TUI 打开即显示 AMO 侧此前写入的历史轮次。
- 用户在 TUI 中的发言和回复，AMO 客户端实时收到结构化事件（userMessage、agentMessage、turn/completed 等）。
- AMO 侧发起的 turn 在 TUI 中实时显示，与用户发言交替排列；之后用户在 TUI 中继续对话，模型上下文包含 AMO 插入的轮次。
- 模型路由由 server 决定，TUI 底栏显示 `DeepSeek Flash · V4.1 Flash low`，TUI 端无需任何 provider 配置。
- server 停止后 TUI 显示 `Reconnecting to server…` 并持续重连。

## 结论

1. **统一管理与直接使用 CLI 可以兼得。** Codex 与 Claude 的协议 session 都和 CLI 共用同一套存储，可以双向接力。
2. **Codex 可以做到真正的共享。** AMO 持有 app-server，原版 TUI 通过 `--remote` 接入，两边是同一 server 的客户端，没有写入冲突，AMO 能拿到完整结构化事件。这正好解决“既要统一管理，又要用原版 CLI”的顾虑。
3. **独立进程并发写入会静默丢数据，两家都不报错。** 凡是不经过同一 server 的写入（例如 Claude，或 Codex 用户在外部直接 `codex resume`），AMO 必须实施单写者规则：session 在别处打开时，AMO 侧只读。
4. **父子关系必须由 AMO 自己记录。** 关系只在创建时（fork 响应、`subAgentActivity`、`parent_tool_use_id`）可得，列表接口不返回。AMO 需要在创建或观察到这些事件时，写入自己的 session 树。
5. **弱模型可以走同一路径。** DeepSeek 通过 Codex provider 参数接入 app-server，GLM 通过环境变量接入 Agent SDK，无需额外适配层。

## 对设计的影响

- Session 宿主进程需要常驻（Node host），不能随 AMO 界面窗口开关；TUI 断线会自动重连，宿主重启后应恢复原端口和 token，或提供重新接入入口。
- Codex 优先采用“AMO 持有 app-server，TUI 可选接入”的模式；Claude 先采用“SDK 驱动 + 需要时用 `claude --resume` 交接”，交接期间 AMO 侧只读，`claude --bg` / `attach` 另行验证。
- AMO 数据模型以 session 树为核心：需求卡 → 主 thread → fork / side chat / subagent，关系由 AMO 记录。
- `thread/list` 默认按当前 provider 过滤，DeepSeek 等非默认 provider 的 thread 需要显式传 `modelProviders`。
- WebSocket app-server 只监听 localhost，使用 capability token；token 不应写入命令行或日志，TUI 通过环境变量读取。

## 顺带发现：现有 DeepSeek Codex 路由在 0.161 下无法加载

`broker/lib/codex-launch-config.js` 生成的 `-c agents.default_subagent_model=...` 与 `-c agents.default_subagent_reasoning_effort=...`，在 Codex 0.161 中被解析为 agent 角色定义，配置加载失败：

```text
error loading default config after config error: invalid type: string "deepseek-flash", expected struct AgentRoleToml
in `agents`
```

验证脚本去掉这两项后正常运行。AMO 现有 Managed Codex 的 DeepSeek 启动大概率受影响，需要单独修复。

## 尚未验证

- Claude 后台 session（`claude --bg`、`claude attach`）能否作为 Claude 侧的共享接入方式。
- Codex TUI 中执行 `/fork`、side chat 时，AMO 侧收到的事件形态。
- 宿主重启后，TUI 自动重连能否恢复到同一 thread。
- 审批请求（命令执行、文件修改）在 AMO 与 TUI 同时在线时由哪一方响应。
