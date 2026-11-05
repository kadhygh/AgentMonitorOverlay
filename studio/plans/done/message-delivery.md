# 消息投递统一（11 月梳理第 3 步）

> 状态：做完（2026-11-04 合进 master `6a231509`，分支 `studio/message-delivery`，Studio 0.9.36）。还剩一件：读老 `sessions.peer-queue` 的迁移代码（`features/sessions/inbox.ts`）过一两个版本后删（用户定的第 5 条），2026-11-06 还在。改之前的逐项现状表、步骤表、验证记录 2026-11-06 删掉了，原文见 git 历史（提交 f46907f2 之前的版本）。

整轮梳理见 `plans/done/cleanup-2026-11.md`，立即发送 / 没送到的来历见 `plans/done/send-now.md`。

## 为什么

11-03 审查：这一轮唯一会**悄悄丢消息**的地方。丢的多半是没人盯着的那类（中转回复、值守、传话、session_start 的回报），丢了界面上也看不出来。

改之前（11-04 读代码确认）：DSH 忙时来的消息只放在内存队列里，不带 `delivery`，一轮出错时悄悄丢掉，停止时也丢掉，没有立即发送、重新发送和停止兜底；Codex 停止没反应时没有兜底。机器往会话里发的消息（中转回复、传话、邮件转发、值守、session_start 的回报、session_send）和人发的走同一条 `sessions.sendMessage`，只有 session_send 落盘排队；中转回复是 `void sendMessage().catch(console.log)`，回复在服务器上已经标成取走，送不进去就只剩 host.log 一行。三个 runtime 的重启收尾、归档、可写检查、「忙」的状态集合各写一份，而且互相不一致（比如 DSH 重启时把没做完的工具标成 `declined`，Claude 重启不改 turn 行）。

## 用户定的（2026-11-04）

1. DSH 停止时排队的消息：照现在，接着作为下一轮发出，三家一致。
2. 转进对话的留言、子会话的汇报进收件箱，等这一轮结束再送：同意。
3. 人点停止后，收件箱里等着的**先不送**（`SessionInbox.pause / resume`）：会话里加一行说明；等人发下一条消息时一起送进去（人那条先开一轮，等着的跟着排进 / 插进同一轮），或者人点它旁边的「立即发送」。停止来自本机或远程 B 的 `sessions.interrupt`；暂停只记在内存里，Host 重启后照常送。
4. `awaiting-review`：从「忙」里去掉，`BUSY_STATUSES` 删了，都用 `inTurn`（状态本身还在 protocol 里，界面照旧认它）。
5. 读老 `sessions.peer-queue` 的迁移代码：过一两个版本后删。

## 规则

1. **人发起的**消息（本机界面、远程 B、画布回答、git / HTML 批注「发到对话」、codex-async 的回答）照现在的语义：忙时插话或排队，带 `waiting` / `unsent`，可以立即发送、重新发送。三个 runtime 一样，DSH 补齐。
2. **agent 或系统发起的**（中转回复和中转说明、值守接着做、传话 task_message、邮件转发、session_send、session_start 的回报）进**会话收件箱**（`features/sessions/inbox.ts`）：
   - 马上在会话里出现一行 user 消息，`delivery: "held"`，界面写「◐ 等这一轮结束后送进去」，带「立即发送」（人想现在就塞进去时用：和人发的一样走插话 / 排队再立即发送）。
   - 会话空下来（不在一轮里、没在等人、没交给终端、没归档）时按顺序送进去：第一条开一轮，同时空着的几条紧跟着进同一轮（Claude 排在 CLI、Codex 插话、DSH 排到下一轮）。人点了停止时先不送（用户定的第 3 条）。
   - 落盘：消息本身就是这行 item（`delivery: held`），另有 kv `sessions.inbox` 记哪些会话有待送的，Host 重启后接着送。旧的 `sessions.peer-queue` 启动时搬进收件箱。
   - 送不进去（渠道没了、Key 没了、进程起不来…）：这行变成「! 没送到」+「重新发送」，下面加一行说明原因；不再丢，也不只写 host.log。
   - 会话归档了：还在等的变成「没送到」。
   - 远程副本（runtime `remote`）不走收件箱：它的 item 是 A 那边的，照原来直接发。
3. **DSH 跟上 Claude / Codex**：排队的标 `waiting`；立即发送 = `session/cancel` 让这一轮让位，排队的作为下一轮发出；Ctrl+Enter 同理；重新发送；停止时排队的接着发（用户定的第 1 条，同 11-02 对 Claude / Codex 定的，`plans/done/send-now.md` 第 1 条）；一轮出错、进程退出、归档、Host 重启时排队的变成「没送到」。
4. **统一时选对用户更安全的**（公共部分在 `RuntimeBase`，`runtime/runtime.ts`）：
   - 重启时没做完的工具标 `failed`（「失败」）而不是 `declined`（界面写「未执行」，可它可能已经跑了一半、改过文件）。
   - 重启时等着的审批标 `resolved-elsewhere`（Claude、Codex 已经这样），不写成「已拒绝」（人没拒绝过）。
   - 重启时还在跑的 turn 行一律改成 interrupted（Claude 以前不改，会一直显示在跑）。
   - 可写检查统一给中文说明，渠道没了用 `profileGone`。
   - 停止兜底三家都有：Claude 照旧（15 秒关进程）；DSH 15 秒没停下就关它的进程，排队的变「没送到」；Codex 的 app-server 是同一渠道共用的不能关，15 秒没停下就在 Studio 这边把这一轮记成已停止，插话变「没送到」。
   - 「在一轮里」= `running / awaiting-approval / awaiting-answer`（protocol `TURN_STATUSES` / `inTurn`），runtime、host-process、tasks 都用它（用户定的第 4 条）。

### 偏离任务说明的地方

- **DSH 停止时排队的消息**：任务说明写「变成没送到」。照 11-02 用户对 Claude / Codex 定的「停下后等待中的消息接着发出，不丢」做，`takeBack.ts` 也按这个不把 waiting 的放回输入框；用户 11-04 确认（第 1 条）。要改成「没送到」只改 DSH 的 `interrupt` 一处。
- **session_send「几条一起送」**：以前合成一条消息；现在每条是自己的一行（排着时就看得到），空下来时一起送进同一轮。

## 做的时候定下的细节

- 收件箱里的行挂在正在跑的那一轮上（`raw.turnId`）：界面按 turnId 分段，不挂的话会把这一轮从中间切开。和 Claude / DSH 的排队消息一样。
- 收件箱「送」= 对这行调 runtime 的 `resend`（Claude、Codex 原来的重新发送路径，DSH 新加），所以不会多出第二行；送的那一刻会话又忙了，就照人发的走排队 / 插话（带 waiting）。
- 送第二条不盲等：看到上一条起的那一轮就送。
- 「立即发送」在 held 的行上 = `resend(…, { now: true })`：Claude 先排进 CLI 再 send_now，Codex 插话再打断，DSH 排队再 cancel。
- 远程 B 看到的是 A 的行；B 点 held 行的「立即发送」走 `rt.sendNow` → A 的 `sessions.sendNow`，同样处理。
- 值守在老会话里接着做之前已经查过会话不忙，走收件箱时当场就送。
- task_message 的工具说明「queued while it works」改成「once its turn is over」。

## 没验证的（11-04 时）

- 真的 DSH（`dsh --profile acp`）、真的 Codex app-server、真的 Claude CLI：只用了 testkit 的假 agent。最该在真环境看的三处：
  - DSH 立即发送：`session/cancel` 之后真 DSH 是不是很快结束这一轮。
  - Codex 停止兜底：真卡住时 15 秒后把这一轮记成已停止，之后 app-server 再发来这一轮的事件会不会乱。
  - Claude 重启后 turn 改成 interrupted 的显示。
- 远程 B 在 held 行上点「立即发送」：代码走 `rt.sendNow` → A 的 `sessions.sendNow`，没有用例。
- 中转回复进会话只在 Studio 一侧测了，中转服务那边没动。
- 老的 `sessions.peer-queue` 迁移只有单测，没有拿真实的旧数据目录试。
