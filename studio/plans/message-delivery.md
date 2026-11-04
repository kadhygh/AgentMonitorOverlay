# 消息投递统一（11 月梳理第 3 步）

分支 `studio/message-delivery`，worktree `G:\PROJECT\AgentMonitorOverlay\.claude\worktrees\cleanup-delivery`（从 master 63413744 开）。2026-11-04 开始。整轮梳理见 `plans/cleanup-2026-11.md`，立即发送 / 没送到的来历见 `plans/send-now.md`。

## 为什么

11-03 审查：这一轮唯一会**悄悄丢消息**的地方。丢的多半是没人盯着的那类（中转回复、值守、传话、session_start 的回报），丢了界面上也看不出来。

## 现状（2026-11-04 读代码确认，行号是改之前的）

### 三个 runtime 收到「会话忙时来的消息」

| | Claude | Codex | DSH |
|---|---|---|---|
| 忙时发 | 进 CLI 的队列，下一次工具调用后或本轮结束读到；带 `delivery: waiting`，`command_lifecycle` 来了清掉 | `turn/steer` 插进当前这一轮，带 `waiting`，回显同一个 clientId 时清掉 | 只放在内存 `live.queue`，本轮结束后合成一条发；user item **不带** `delivery` |
| 立即发送 / Ctrl+Enter | 有（`send_now` 打断） | 有（`turn/interrupt` + afterTurn 接着发） | **没有**，`sendMessage` 不收 options，远程 B 传来的 `now` 被忽略 |
| 重新发送 | 有 | 有 | **没有** |
| 停止 | 等待中的接着发（用户 11-02 定） | 同左（afterTurn） | **丢掉**排队的，只留一行「排队的 N 条消息没有发出」（`interrupt`，约 358 行） |
| 一轮出错 | 进程异常结束：waiting → unsent | 进程断开：waiting → unsent | `live.queue.splice(0)` **悄悄丢掉**（`endTurn`，约 768 行） |
| 进程退出 / 归档 | waiting → unsent | 同左 | 排队的随 `live` 一起没了 |
| Host 重启 | waiting → unsent | 同左 | `settleAfterRestart` 不管 user item（本来也没标 waiting） |
| 停止没反应 | 15 秒后关进程，再 15 秒放弃 | **没有兜底**，app-server 不回就一直「正在工作」 | **没有兜底** |

### 「机器往会话里发消息」的入口（都调 `sessions.sendMessage`，和人发的走同一条路）

| 入口 | 谁发起 | 今天的行为 |
|---|---|---|
| `teamrelay/service.ts` `tell`（中转回复、中转发送失败 / 被拒的说明） | 系统 | `void sendMessage().catch(console.log)`；回复先 `takeSession` 在服务器上标成已取，送不进去就只剩 host.log 一行，**回复丢了**。注释说「queued while it works」，对 Codex 实际是 steer 进当前轮 |
| `relays/service.ts` `deliver`（task_message 传话） | agent | 直接发；忙时 Claude 排队 / Codex 插话 / DSH 排队（会丢） |
| `collab/service.ts` `forwardMail`（人点「转发」邮件） | 人点、内容是 agent 的 | 同上 |
| `duty/service.ts`（值守在老会话里接着做） | 系统 | 同上；值守先查了 `sessionMoving`，一般是空闲 |
| `sessions/service.ts` `checkReport`（session_start 的 report） | 系统 | 直接发，失败改成邮件 |
| `sessions/service.ts` `sendPeer`（session_send） | agent | **唯一落盘排队的**：kv `sessions.peer-queue`，会话不忙时合成一条发；排着时界面上看不到 |
| `canvasreview` 画布回答 | 人 | 直接发 |
| `gitreview` / `review` 批注「发到对话」 | 人 | 直接发 |
| `remote/comments.ts`、`remote/grants.ts`（B 发的消息、批注） | 人（B） | 直接发；带 `now` |
| `sessions/service.ts` codex-async 问题的回答 | 人 | 直接发 |

### 各 runtime 各写一份的

- 重启收尾：Claude `recoverAfterRestart`（工具 → failed，审批 → resolved-elsewhere，**没管 turn 行**）、Codex `settleLeftovers`（turn → interrupted，工具 → failed）、DSH `settleAfterRestart`（工具 → **declined**，审批 → **declined**，不管 waiting、流式）。
- 归档 / 取消归档：三份一样的 `archiveSubtree` + publish，再各自关进程。
- 可写检查：Claude / Codex 英文 `session X is read-only (archived)`，DSH 中文只查归档；`profileGone`（渠道删了的中文说明）只有 Codex 有。
- 「忙」的状态集合：protocol 的 `BUSY_STATUSES` 含 `awaiting-review`；`host-process.ts`、`tasks/service.ts`、三个 runtime 里手写的 `running / awaiting-approval / awaiting-answer`。（Host 里没有地方会把会话设成 `awaiting-review`。）

## 规则

1. **人发起的**消息（本机界面、远程 B、画布回答、git / HTML 批注「发到对话」、codex-async 的回答）照现在的语义：忙时插话或排队，带 `waiting` / `unsent`，可以立即发送、重新发送。三个 runtime 一样，DSH 补齐。
2. **agent 或系统发起的**（中转回复和中转说明、值守接着做、传话 task_message、邮件转发、session_send、session_start 的回报）进**会话收件箱**：
   - 马上在会话里出现一行 user 消息，`delivery: "held"`，界面写「◐ 等这一轮结束后送进去」，带「立即发送」（人想现在就塞进去时用：和人发的一样走插话 / 排队再立即发送）。
   - 会话空下来（不在一轮里、没在等人、没交给终端、没归档）时按顺序送进去：第一条开一轮，同时空着的几条紧跟着进同一轮（Claude 排在 CLI、Codex 插话、DSH 排到下一轮）。
   - 落盘：消息本身就是这行 item（`delivery: held`），另有 kv `sessions.inbox` 记哪些会话有待送的，Host 重启后接着送。旧的 `sessions.peer-queue` 启动时搬进收件箱。
   - 送不进去（渠道没了、Key 没了、进程起不来…）：这行变成「! 没送到」+「重新发送」，下面加一行说明原因；不再丢，也不只写 host.log。
   - 会话归档了：还在等的变成「没送到」。
   - 远程副本（runtime `remote`）不走收件箱：它的 item 是 A 那边的，照原来直接发。
3. **DSH 跟上 Claude / Codex**：排队的标 `waiting`；立即发送 = `session/cancel` 让这一轮让位，排队的作为下一轮发出；Ctrl+Enter 同理；重新发送；停止时排队的接着发（同 11-02 用户对 Claude / Codex 定的第 1 条，而不是任务说明里写的「变成没送到」——见下面「偏离」）；一轮出错、进程退出、归档、Host 重启时排队的变成「没送到」。
4. **统一时选对用户更安全的**：
   - 重启时没做完的工具标 `failed`（「失败」）而不是 `declined`（界面写「未执行」，可它可能已经跑了一半、改过文件）。
   - 重启时等着的审批标 `resolved-elsewhere`（Claude、Codex 已经这样），不写成「已拒绝」（人没拒绝过）。
   - 重启时还在跑的 turn 行一律改成 interrupted（Claude 以前不改，会一直显示在跑）。
   - 可写检查统一给中文说明，渠道没了用 `profileGone`。
   - 停止兜底三家都有：Claude 照旧（15 秒关进程）；DSH 15 秒没停下就关它的进程，排队的变「没送到」；Codex 的 app-server 是同一渠道共用的不能关，15 秒没停下就在 Studio 这边把这一轮记成已停止，插话变「没送到」。
   - 「在一轮里」= `running / awaiting-approval / awaiting-answer`（protocol `TURN_STATUSES` / `inTurn`）；「忙」= 再加 `awaiting-review`（`BUSY_STATUSES`）。runtime、host-process、tasks 都用这两个。

### 偏离任务说明的地方

- **DSH 停止时排队的消息**：任务说明写「变成没送到」。用户 11-02 对 Claude / Codex 定的是「照 CLI，停下后等待中的消息接着发出，不丢」（`plans/send-now.md` 第 1 条），`takeBack.ts` 也按这个不把 waiting 的放回输入框。DSH 照同一条做，三家一致；要改成「没送到」只改 `interrupt` 一处。列进「要用户定的」。
- **session_send「几条一起送」**：以前合成一条消息；现在每条是自己的一行（排着时就看得到），空下来时一起送进同一轮。

## 步骤

| 步 | 内容 | 状态 |
|---|---|---|
| 0 | 读代码、写这份方案 | ✓ |
| 1 | protocol `TURN_STATUSES` / `inTurn`；`RuntimeBase`：重启收尾 `settleLeftovers`、归档 `archiveTree`、`writable` + `profileGone`、停止兜底 `armStopGrace`；各 runtime 换上 | ✓ 8a5ebb0e |
| 2 | DSH：waiting / unsent / 立即发送 / Ctrl+Enter / 重新发送；停止、出错、退出、归档、重启的处理；停止兜底 | ✓ 8a5ebb0e（和第 1 步一起：DSH 直接用上 RuntimeBase 的新件） |
| 3 | 会话收件箱 `features/sessions/inbox.ts`（`delivery: held`、kv `sessions.inbox`、空闲时送、失败标没送到 + 说明、重启续送、`sessions.peer-queue` 迁移）；teamrelay、relays、collab、duty、checkReport、sendPeer 改走它；runtime `resend` 收 `held` 和 `now`；界面「等这一轮结束后送进去」+「立即发送」，停止时不把它放回输入框 | ✓ 2e56d5f3、7602fbc7 |
| 4 | CHANGELOG「下一版」三条、HANDOFF | ✓ |

### 做的时候定下的细节

- 收件箱里的行挂在正在跑的那一轮上（`raw.turnId`）：界面按 turnId 分段，不挂的话会把这一轮从中间切开。和 Claude / DSH 的排队消息一样。
- 收件箱「送」= 对这行调 runtime 的 `resend`（Claude、Codex 原来的重新发送路径，DSH 新加），所以不会多出第二行；送的那一刻会话又忙了，就照人发的走排队 / 插话（带 waiting）。
- 「立即发送」在 held 的行上 = `resend(…, { now: true })`：Claude 先排进 CLI 再 send_now，Codex 插话再打断，DSH 排队再 cancel。
- 远程 B 看到的是 A 的行；B 点 held 行的「立即发送」走 `rt.sendNow` → A 的 `sessions.sendNow`，同样处理。
- 人点了停止之后，收件箱里等着的会在会话空下来后送进去（和 11-02 定的「停下后等待中的消息接着发出」一致）。
- 值守在老会话里接着做之前已经查过会话不忙，走收件箱时当场就送；`awaiting-review` 现在没有地方会设，只在「忙」里占位。
- task_message 的工具说明「queued while it works」改成「once its turn is over」。

## 验证

做完跑的（2026-11-04，全部 BelowNormal，vitest `--maxWorkers=4`）：

- `npm run typecheck`：过。
- vitest host + ui + protocol 全量：138 个文件、934 条全过。中途两次没过，都查了：
  - `sessions/peer` 的「几条一起送」在满载下 5 秒超时。原因是收件箱送第二条前盲等 3 秒；改成看到上一条起的那一轮就送（7602fbc7），两条用例给 15 秒。
  - DSH「session_start with write…」在全量并行时超时过两次。master 的代码 A/B 跑过、单跑过、之后全量也过，判断是负载，记为偶发。
- 新加的用例：
  - dsh-runtime.integration：停止后排队的接着发；立即发送和 Ctrl+Enter；`[[fail-after]]` 出错 → 没送到 → 重新发送；`[[stuck]]` 停不下 → 15 秒关进程 → 没送到；Host 重启 → 没送到 → 重新发送。
  - sessions/peer「the session inbox」：重启后续送；`sessions.peer-queue` 迁移；送不进去 → 没送到 + 说明 → 重新发送；归档 → 没送到；held 行上的立即发送。
  - teamrelay：会话忙时回复等着，失败一次后重新发送。
- e2e（只跑相关的）：`dsh`、`claude`、`duty`、`teamrelay`、`relays`、`mailbox`、`handoff-mail` 全过。
  - dsh.spec 新加一步：会话等批准时转进一封留言，看到「◐ 等这一轮结束后送进去」和「立即发送」，批准后它作为下一轮送进去。截图在 `screenshots/studio/inbox-held.png`。
- 看截图时发现输入框底栏的「MCP 0」压在提示文字上，Claude 也一样（11-04 加的 MCP 标签）。改成选项条不缩、提示文字省略（`pickers.css`），重跑 dsh、claude 两个 spec 看过截图。

## 没验证的

- 真的 DSH（`dsh --profile acp`）、真的 Codex app-server、真的 Claude CLI：只用了 testkit 的假 agent。最该在真环境看的三处：
  - DSH 立即发送：`session/cancel` 之后真 DSH 是不是很快结束这一轮。
  - Codex 停止兜底：真卡住时 15 秒后把这一轮记成已停止，之后 app-server 再发来这一轮的事件会不会乱。
  - Claude 重启后 turn 改成 interrupted 的显示。
- 远程 B 在 held 行上点「立即发送」：代码走 `rt.sendNow` → A 的 `sessions.sendNow`，没有用例。
- 中转服务那边没动；中转回复进会话只在 Studio 一侧测了（teamrelay 单测 + e2e）。
- 全套 e2e 没跑（按要求只跑相关的）。
- 老的 `sessions.peer-queue` 迁移只有单测，没有拿真实的旧数据目录试。

## 用户定的（2026-11-04）

1. DSH 停止时排队的消息：照现在，接着作为下一轮发出，三家一致。
2. 转进对话的留言、子会话的汇报进收件箱，等这一轮结束再送：同意。
3. 人点停止后，收件箱里等着的**先不送**（改了，`SessionInbox.pause / resume`）：会话里加一行说明；等人发下一条消息时一起送进去（人那条先开一轮，等着的跟着排进 / 插进同一轮），或者人点它旁边的「立即发送」。停止来自本机或远程 B 的 `sessions.interrupt`；暂停只记在内存里，Host 重启后照常送。单测 peer.test「stopped by the person」。
4. `awaiting-review`：从「忙」里去掉，`BUSY_STATUSES` 删了，都用 `inTurn`（状态本身还在 protocol 里，界面照旧认它）。
5. 读老 `sessions.peer-queue` 的迁移代码：过一两个版本后删。
