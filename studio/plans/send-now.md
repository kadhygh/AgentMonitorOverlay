# 立即发送（Claude 和 Codex）

分支 `studio/send-now`，worktree `G:\PROJECT\AgentMonitorOverlay-send-now`。2026-11-02 开始。

## 要做什么

会话生成中时，发消息有两种方式：

| | 排队 / 插话（原来就有） | 立即发送（这次加） |
|---|---|---|
| 怎么发 | Enter、点发送 | 生成中按 Ctrl+Enter；或在一条「等待送达」的消息上点「立即发送」 |
| 什么时候到模型 | 下一次工具调用后，或这一轮结束后 | 马上：打断当前这一步，模型立刻读到 |

对齐 Claude Code CLI 的 Send now（`ctrl+enter`、`ctrl+x ctrl+s`）和 Codex TUI 的「press esc to interrupt and send immediately」。DSH 不做（它等这一轮结束才发）。

## 用户定的（2026-11-02）

1. **停止时有消息在等**：照 CLI（「esc to interrupt and send」），停下后等待中的消息接着发出，不丢。Codex 也一样（Codex TUI 也是这样）。
2. **兜底关进程后没送到的消息**：标「没送到」，人点「重新发送」，不自动补发（兜底那时 CLI 多半卡住了）。
3. **远程会话也支持**：B 控制 A 的会话时，立即发送、重新发送照样能用。
4. **生成中 Ctrl+Enter = 立即发送**；不在生成中时 Ctrl+Enter 还是普通发送。

## 调查结论（2026-11-02，假模型实测，脚本在 `%TEMP%\amo-sendnow-exp\`）

Claude（SDK 0.3.304 自带的 CLI 2.1.304）：

- 发进输入流的消息，CLI 先放进它自己的队列（等待送达），到下一次工具调用后被并进当前这一轮，或这一轮结束后作为下一轮。
- 带 `uuid` 的消息，CLI 发 `command_lifecycle` 帧：`queued` → `started`（送到模型）→ `completed` / `cancelled`。init 里有 `msg_lifecycle_v1`。
- `q.interrupt()`：查询**不会**结束（`claude-runtime.ts` 原来的注释过时了）。这一轮以 `error_during_execution` 结束，等待中的消息留下（`still_queued`），马上作为下一轮发出。
- 内部控制请求 `{subtype: "interrupt", send_now: true, message_uuid}`（`q.request`，SDK 的类型里没有；init 里有 `interrupt_send_now_v1`）：回答 `send_now: "stopped"`，这一轮像打断一样结束，那条消息立刻发出。CLI 不认识时当普通打断，效果一样。
- 用户消息带 `priority: "now"`（SDK 公开字段）：当前这一轮马上让位（工具调用被中止），这条立刻发出。
- 关掉进程（15 秒兜底）时，等待中的消息**丢了**：从没送到模型，Studio 却显示已发出。

Codex（codex-cli 0.165，app-server）：

- `turn/steer`：模型在写文字时马上读到；在跑命令时，命令跑完才读到。`clientUserMessageId` 会原样回到那条 `userMessage` 的 `clientId`。
- `turn/interrupt` 后，还没读到的插话**丢了**（app-server 不留，TUI 自己重发）。而 Studio 只在 `item/completed userMessage` 时才显示这条消息，所以人根本看不到它发过。

## 做法

协议：

- 用户消息加 `delivery?: "waiting" | "unsent"`：没有 = 已送到（或旧数据）；`waiting` = 等待送达；`unsent` = 没送到（进程没了）。
- `POST /api/sessions/:id/messages` 加 `now?: boolean`。
- `POST /api/sessions/:id/items/:itemId/send-now`：让这条等待中的消息立刻送到。
- `POST /api/sessions/:id/items/:itemId/resend`：把一条「没送到」的消息再发一次（同一条，不新增）。
- 运行时接口：`sendMessage(…, { now })`、`sendNow?(sessionId, itemId)`、`resend?(sessionId, itemId)`；远程命令 `rt.send` 带 `now`，新增 `rt.sendNow`、`rt.resend`。

Claude：

- 每条消息带 uuid（记在 live 上：uuid → 条目）。生成中发的标 `waiting`，`command_lifecycle` 的 `started` 来了就清掉；CLI 不报 `msg_lifecycle_v1` 时不标（不然会一直等待）。
- 立即发送（等待中的那条）：`q.request({subtype: "interrupt", send_now: true, message_uuid})`，没有 `request` 时退回 `q.interrupt()`。不走「停止」那套（不拒审批、不起 15 秒兜底）；让位的这一轮记成「中断」，不报「回合出错」。
- Ctrl+Enter：消息带 `priority: "now"` 发出，同样标让位。
- 进程结束（兜底关闭、异常、Host 重启）时，还在 `waiting` 的改成 `unsent`。

Codex：

- 插话带 `clientUserMessageId`，消息马上显示成 `waiting`；`item/completed userMessage` 带回同一个 `clientId` 时，不新增条目，清掉 `waiting`。
- 一轮结束（完成或中断）时还有没读到的插话：照第 1 条，作为下一轮 `turn/start` 发出（几条合成一条输入）。
- 立即发送：`turn/interrupt`，然后由上一条接着发出。Ctrl+Enter 在一轮进行中：先作为等待中的插话，再立即发送。
- app-server 退出时，没读到的改成 `unsent`。

界面：

- 等待中的消息：小字「等待送达」+「立即发送」；没送到的：「没送到」+「重新发送」。只读时不给按钮。
- 生成中提示：原来的那句后面加「 · Ctrl+Enter 立即发送」，去掉「生成中：」开头（不然输入框下面一行放不下），例如 Claude「工具调用后或本轮结束后读到 · Ctrl+Enter 立即发送」。DSH 不变。
- 「停止」把刚发的消息放回输入框（`takeBack.ts`）：等待中的那条不放回（它停下后照样会发出，放回会发两次）。

## 做的时候定下的细节

- Claude 立即发送要等 CLI 先收到这条（`command_lifecycle` 的 `queued`，`live.atCli`）：消息刚推进输入流就点，CLI 还不认识这个 uuid，`send_now` 会落空。最多等 3 秒，等不到就照样发请求。
- Codex 一轮结束后没读到的插话由 `afterTurn`（`turn/completed` 时）接着发：第一条 `turn/start`（同一行，带原来的 `clientId`），其余的插进这新的一轮；新的一轮已经又结束了就再来一次；`turn/start` 失败就把剩下的标「没送到」。`send` 里 steer 失败时先看这一条是不是已经被 `afterTurn` 接走了，接走了就不再自己发。
- 让位的那一轮在对话里显示成「已停止」（和打断一样），不报错。
- 停下后等待中的消息接着发：Claude 由 CLI 自己做（`still_queued`），Codex 由上面的 `afterTurn` 做。

## 分步

| 步 | 内容 | 状态 |
|---|---|---|
| 0 | 方案、worktree | ✓ |
| 1 | 协议 + Claude：uuid、送达状态、立即发送、Ctrl+Enter、没送到、重新发送；集成测试（假模型） | ✓ |
| 2 | Codex：插话马上显示、clientId 对上、没读到的接着发、立即发送、没送到、重新发送；假 app-server 补上「命令跑完才读插话、打断就丢」（`[[busy: ms]]`） | ✓ |
| 3 | 路由 + 远程（`rt.send` 的 `now`、`rt.sendNow`、`rt.resend`） | ✓（单测和类型检查过；两台电脑的远程没有端到端跑） |
| 4 | 界面：两个按钮、Ctrl+Enter、提示、takeBack；e2e 截图（`screenshots/send-now/`） | ✓ |
| 5 | CHANGELOG「下一版」、HANDOFF | ✓ |

## 约束

- `send_now` 是 CLI 的内部字段，CLI 升级可能变：只在 init 报了 `interrupt_send_now_v1` 时用，否则普通打断（效果相同，只是 CLI 不能选择把命令挪到后台）。
- 不改「停止」的行为（除了 Codex 的插话不再丢）。
- 重的命令用 BelowNormal、`--maxWorkers=6`。
