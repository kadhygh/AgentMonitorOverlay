# 计划窗口：Claude 的计划在自己的窗口里审

> 状态：做完（2026-11-09）。手机和远程设备、和上一版对比放在 `plans/later/plan-review-window-later.md`。

## 用户说的（2026-11-09）

> Claude 的计划现在是聊天内一大章文字，且不能标注批注。改成聊天内显示一个按钮，可以随时开启查看；计划是个独立弹窗，可以标批注，也是复制批注回复。现在的计划感觉是要看完后在聊天输入位置回复，这个也很奇怪，计划应该有自己的输入框，且开启关闭后输入内容要能保留。

我提了做法，用户定：「按你建议的做，独立窗口，其他两项先放 later」。

## 定下的

- **对话里**：计划只占一行「Claude 的计划：标题 · 状态 ·［查看计划］」，旧版本、已批准的也能随时打开看。改过的写「已要求修改（带 N 条批注）」和修改意见的文字。
- **输入框上面的条**：只剩「计划待审：标题［打开计划］［批准并开始］」。输入框不再收修改意见，提示改成去计划窗口写。
- **计划窗口**：独立窗口，每个会话一个，再打开就把它提到前面（换到要看的那一版）。上面是计划正文，选中文字写批注（和回复的批注同一套：高亮、点高亮改、`批注N` 编号）；下面是这一版的批注列表、自己的输入框和「复制批注 / 先不批准 / 要修改 / 批准并开始」。
- **要修改**：输入框的文字加上批注（和输入框引用批注的格式一样，`composeAnnotationRefs`）一起作为 revise 的 feedback 发回；只有批注、没写字也行。发出后批注算已发送。
- **保留**：输入框的文字按计划那一版存在 localStorage（`amo-plan-draft:<itemId>`），关了窗口再开还在，发出去才清；批注本来就存在 Host。
- **新版本**：窗口开着时 Claude 交来新的一版，窗口自动换到它；标题栏有版本下拉（第 N 版）。
- **远程会话、浏览器里打开的工作台**（没有 `window.amo.openPlan`）：还是整张计划卡加输入框收修改意见，照旧。

## 做法和原因

- 计划的批注就是会话批注（`Annotation.itemId` 指向那条 plan-review question），不另做一套：Host 只多认一种能批注的条目（`review/service.ts`），编号、事件、存储都复用。它们只跟着「要修改」走：`annotations/send`（批注单独发）不带它们，任务页的批注栏也不显示，免得同一条批注从两处发。
- revise 的 `QuestionReply` 多一个可选的 `annotations`（批注 id），Host 在 `answerQuestion` 里拼进 feedback，runtime 不用改；Claude 拿到的是一段普通的拒绝理由。
- 窗口用 Electron 的独立窗口（`app/src/plan-window.ts`，和画布小窗一个做法），不用对话上的弹层：用户要能边看计划边看对话，也要能关了再开。
- 批注的选区读取依赖 `data-item-type="agent"` 的容器和 Markdown 的 `data-src-*`，计划窗口把计划正文包成同样的结构，`readSelection`、`useAnnotationHighlights` 不用改。

## 验证

- Host：`questions-route.test.ts` 里给计划写批注、超出范围被拒、批注不单独发、revise 带批注拼进 feedback 并标已发送。
- UI：`plan/plans.test.ts`（版本、显示哪一版）。
- e2e：`e2e/studio/questions.spec.ts` 的计划审阅：对话里一行、条上两个按钮、窗口里写批注和文字、关了再开还在、要修改后 Claude 收到文字和批注、新一版自动换过去、在窗口里批准。截图 `screenshots/stage-12/S12-B-plan-*.png`。
