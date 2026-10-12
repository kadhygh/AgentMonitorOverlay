# S1-00 协议补测结论

环境：Codex CLI 0.161.0，app-server 走 WebSocket 加 capability token，模型路由 DeepSeek Flash（`spikes/lib.mjs` 的 `deepseekConfigArgs`）。沙盒工作区在 `%TEMP%\amo-studio-sandbox\` 下。原始记录在 `spikes/results/`。

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

- 采用**每个 Codex home 一个 app-server**，provider 按 thread 指定。模型 profile 落成"`modelProvider` + `config` 片段"，在 `thread/start` 时带上。
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

## d. 其他客户端发起的 fork

待测（S1-00d）。
