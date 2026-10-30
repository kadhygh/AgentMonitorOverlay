# relay-in-sessions：会话里直接用 AMO 中转

## 起因

用户 10-29：想让会话（Studio 里的和终端里的）能直接通过 AMO 中转发聊天消息、发审批请求（策划的 AI 卡住或方案要程序把关时发会话找人确认），对方回复后最好自动回到对话里接着做。Claude、Codex、DSH 都要支持。

## 用户定的（2026-10-30）

1. **用你本人的账号发，带「AI 代发」标记**（中转已有的 `via: { kind: "ai", client }`，对方看到「AI 代发 · AMO Studio」）。账号用平台登录的（`account.json`，`AGENTS.md` 约束第 7 条）。
2. **团队里谁都能找，每次发之前都先问你**，自动审批模式下也问（发给真人的）。
3. **对方很久不回：先不提醒**，卡片上显示「等 X 回复 · 已等 2 小时」。
4. **第一版只做「AI 找人确认」**（会话：正文、问题和选项、附文件、等回复、追问、标记完成），不做普通聊天。
5. **一次取所有新回复**（`relay inbox`）**只取这个对话发出的**：发的时候带一个对话标记，取的时候按标记筛。Studio 里由 Host 按「哪个会话发的」自动送回。
- 终端里的会话先不做（第 4 节原打算 4，留着）。
- 10-30 已做：中转「复制新回复」（只复制你或你的 AI 上次发言之后的内容）。
- 10-30 晚加：设置 → 功能 → 中转「AI 找人确认时直接发出，不用先问我」（`teamAutoSend`，默认关；开着时第 2 条的「每次先问」不再适用，只管中转，不管 Studio 内部的传话）。

## 现状（10-30 查的）

- Studio 会话的 AMO MCP 里 `relay_send` 是 **Studio 内部的「传话」**（主控给同专题别的任务的会话传话，`host/features/relays`），和 AMO 中转无关，名字撞了。传话的确认流程正好能借鉴：AI 调工具 → 记一条待确认 → 人在主窗口或 Focus 里同意 → 送进目标会话（`sessions.sendMessage`，正在跑就排到这一轮后面）→ 结果作为留言回来。
- 中转服务的会话 API 都在 `relay/src/api.ts`（`ask`、`send`、`session`、`messages`、`wait`）；`messages(…, { ai: true })` 会把会话记成「AI 已取回」（`pickedAt`）。`Via` 在服务端被 `checkVia` 只留 `kind` 和 `client`，存在每条消息的 `via` JSON 里。
- Host 已经用平台的账号连着团队服务器（远程会话，`host/features/remote`：`readAccount`、设备 id 在 `device.json`）。
- 中转自己的命令行和 MCP（`relay/src/bin.ts`、`mcp.ts`）：`relay_queue` 列出回到我这边的会话，再逐个 `relay_session_get`。

## 做法

进度（10-30）：第 1–4 步都做完了，验证见 `HANDOFF.md` 同日那条。实际做法和下面一致；工具名定为 `team_*`。10-30 已上线：中转服务部署了，Studio 0.9.12 在测试通道。

### 第 1 步：中转服务和命令行（`packages/relay`）

- `Via` 加可选的 `conv`（对话标记，≤ 80 字）：`checkVia` 保留它；会话的 `RequestState` 加 `conv`＝提问方最近一条带标记的 AI 消息的 `conv`（换了对话接着问，就归新的对话）。只是多存一个字段，老客户端不受影响。**改了服务代码，部署时中转会重启几秒。**
- 命令行 `relay inbox --conv <标记>`、MCP `relay_inbox`：一次取回这个对话发出、已经回到我这边、由 AI 处理的所有会话，每个只给上次发言之后的新内容（和「复制新回复」同一个函数，挪到 `relay/src/usage.ts`），并记成「AI 已取回」。`relay ask` / `send` 加 `--conv`；MCP 服务进程启动时自己生成一个标记，发和取都自动带上（一个 AI 对话一个 MCP 进程）。用法说明（`usagePrompt`）写上。
- 测试：store / server 单测（`conv` 存取、按标记筛、取过就不再给）。

### 第 2 步：Studio 会话里的中转工具（`host`，新功能目录 `features/teamrelay`）

- `relay_send` 改名 `task_message`（说明写清是给 Studio 里另一个任务的会话传话），guide、role、测试、e2e 跟着改。
- 新工具（`autoApprove: true`，因为确认由 Studio 自己做，见下）：
  - `team_members`：团队成员（名字、昵称、角色、在线）；
  - `team_ask`：发会话找人确认（to、title、body、questions、可选的本机文件路径）。**不直接发**：记一条待确认的「中转发送」，人在主窗口或 Focus 里同意才发；回复 AI「等你确认后发出，回复会自动回到这个会话」，AI 结束这一轮。没同意 → 一条消息告诉会话。
  - `team_followup`：在会话里追问（正文 + 可选的新一轮问题），同样先确认；`team_done`：标记完成（不用确认）；
  - `team_session`：读一个会话全文；`team_sessions`：这个 Studio 会话发出的中转会话和状态。
- 发的时候 `via = { kind: "ai", client: "AMO Studio", conv: "studio:<设备 id>:<会话 id>" }`。
- 没在平台登录：工具报「在 AMO 平台里登录后才能用中转」。

### 第 3 步：回复自动回到会话（`host`）

- Host 用平台账号连中转（复用 remote 读到的账号）：`wait` 长轮询（不带 ai，不改「已取回」）醒来，再扫一遍会话列表；启动时和每 60 秒也扫一次。
- 找出 `conv` 是本机前缀（`studio:<设备 id>:`）、回到我这边、由 AI 处理、还没取回的会话：取新内容（`messages(…, { ai: true })`，记成已取回），作为一条消息发进那个 Studio 会话（`sessions.sendMessage`：空闲就开新一轮，正在跑就排在后面；同一会话同时来几条，合成一条）。开头写「【中转回复】X 回复了你发的会话「…」」，末尾写怎么接着做（追问用 `team_followup`，敲定了用 `team_done`）。
- 那个 Studio 会话没了或归档了：不取，中转里照常显示「回复已到」，人自己复制。
- 测试：Host 单测用假的中转（或 testkit 起一个真中转服务）：发 → 对方回复 → 会话收到一条消息、`pickedAt` 有值；会话正在跑时排队。

### 第 4 步：界面（`ui`）

- 待确认的「中转发送」：主窗口和 Focus 里像传话那样出现（「需要你」），能看全文、改不了、同意 / 不发。
- 会话页和任务卡上：「等 程序老赵 回复（中转）· 已等 2 小时」，点开看这个会话的中转记录（发给谁、状态、跳到中转）。
- e2e：本机临时中转服务、两个账号；Studio 里一个假模型调 `team_ask` → 确认 → 另一个账号在中转里回复 → Studio 会话收到并开新一轮。截图看一遍。

## 以后（不在第一版）

- 普通聊天（私聊、话题）；超时提醒；终端里的会话（按文件夹配 MCP，见下）；能找哪些人的名单。
- 终端里的会话（指定文件夹，不做全局）：Studio 设置里「在文件夹里启用 AMO MCP」，替用户执行 `claude mcp add --scope local …`；配置里只写一个转接命令，令牌运行时从数据目录读。回复不能自动塞回终端会话；终端里的 AI 用 `relay inbox` 取。
