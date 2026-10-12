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
- 待 S1-00c 确认：server 重启后 `thread/resume` 不带 `config` 能否恢复这个 thread 的 provider；`codex --remote resume` 接入一个按 thread 指定 provider 的会话时，路由是否仍然正确。如果不能，Host 要在 resume 时重新带上 profile 的 config。

## c. 重启重连

待测（S1-00c）。

## d. 其他客户端发起的 fork

待测（S1-00d）。
