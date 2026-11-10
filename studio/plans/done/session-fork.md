# 会话分支：精确到每轮 + 分支弹窗

状态：做完（2026-11-10；弹窗用户选了原型 `session-fork-dialog.html` 里的 C 版：先简后详，设置收起）。没验证：从压缩之前的轮次分支。

## 用户定的（2026-11-10）

- 分支精确到每一轮：每轮回复下面「复制」旁边加一个分支图标，点了出弹窗，轮次默认就是这一轮。
- 会话头上原来的「分支」按钮收进「⋯」菜单，点它等于从最新一轮分支（打开同一个弹窗）。
- 弹窗里能选：从哪一轮；方式（子会话 / 平级会话）；标题；模型（只限同一渠道）、思考强度、Fast、审批方式；MCP 能追加的就做。
- 平级会话 = 同一个任务里和原会话并列的会话，归档互不影响。子会话 = 现在的分支，挂在原会话下面，一起归档。
- 跨渠道（Claude 分成 GPT）不做，只留同渠道。
- Claude：这次改动以前的轮次只能从最新一轮分支（以前没记每轮对应的消息）。
- DeepSeek（DSH）不支持分支（它的 ACP 只有 close / list / resume），按钮灰掉、说明原因就行，不做「带摘要开新会话」。

## 做法

- 截断点：
  - Codex：`thread/fork` 的 `lastTurnId`（含这一轮，后面的不要），就是 Studio 每轮 turn 条目上的 `turnId`。
  - Claude：SDK `forkSession(id, { upToMessageId })`（含这条消息）。每轮结束时把这一轮最后一条 transcript 消息的 uuid 记在 turn 条目的 `forkPoint` 上。没有 `forkPoint` 的老轮次，只有最新一轮可以分（复制整个 transcript）。
- 新会话的对话记录：以前分支出来的会话在 Studio 里是空的（只有模型那边记得）。现在把原会话截到那一轮为止的条目复制进新会话，看到的和模型记得的一致。
- 平级会话：`kind: "main"`、没有 `parentId`；`forkOf { sessionId, turn }` 记从哪个会话第几轮分出（子会话也记），会话列表里注一句。
- 模型、强度、Fast、审批：新会话的 `options` 从原会话的复制，再按弹窗改；渠道不变（Claude 本机登录只能用订阅，和以前一样）。
- MCP：Claude 会话能在原会话的基础上开或关（新会话起新进程，按它自己的 `options.mcp`）；Codex 的 MCP 跟着 Codex 后台进程，分支时不改。
- 接口：`POST /api/sessions/:id/fork`，body `{ turnId?, as?: "sub" | "peer", title?, options?: { model, effort, fast, permission, mcp } }`，都可省（省了 = 最新一轮、子会话、默认标题、和原会话一样）。
