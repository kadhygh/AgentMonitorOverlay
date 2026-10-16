# 阶段 16：小修、重构、画布标记与右键、主控编排（2026-10-17）

起因：用户 2026-10-17 的六条反馈。第 2 条（主控 + 子 agent 跑重任务体验不好）就是阶段 15 计划里没做的三期，这次一起推进；设计仍按 `plans/stage-15.md`。

## 用户的反馈（原意）

1. 之前拆过一轮结构，看要不要再推进一轮。
2. 主控 + 子 agent 跑重任务体验不太行：只能和主控交流，很多内容要出多份 token。巨型任务设主控没问题，但主控应该用 AMO 功能拉起分 task，在画布上表现，用户再分别进各个任务。
3. 画布上每个任务可以加说明，直接显示在任务卡片上，LLM 也能调接口写。任务和便签都能标记颜色（红黄绿蓝等几个基础色），标记后卡片外框带一层颜色，用来标状态或程度。
   另：子 agent 拉起审批，Focus 有提示；点了之后子 agent 继续了，但 Focus 上的提示没消失。
4. Focus 里有些不用切回来看：加「我知道了」，主要给「完成待审核」用，点了视作审核完成。
5. 设置 →「项目与目录」的默认项目，本意是设一个路径：点「选择文件夹」时从这个路径开始选。
6. 画布右键多加些功能，参考 Obsidian Canvas 的操作习惯。

## 用户的决定（2026-10-17）

- 重构：两个 runtime 加 store 和几个大的界面文件一起拆（用户选了较大的范围）。行为不变，靠现有测试兜底。
- 任务说明是**任务自己的字段**：画布卡片（含引用卡片）显示，任务页能看能改，用户和 agent（MCP）都能写。
- 默认项目**换成默认路径**：去掉「选默认项目」，改成填一个文件夹路径，选文件夹的对话框从这里开始。
- 主控建任务**保持「提案 → 用户确认」**（阶段 15 的决定 3、4 不变）。

## 查明的情况

- Focus 提示不消失：`claude-runtime.ts` 的 canUseTool 不管有没有进行中的一轮都把会话设成「等你批准」；批准后只在 `live.running` 时把状态改回来。子 agent 在后台（主控这轮已结束）发起审批时，批准后会话一直停在「等你批准」，直到用户发下一条消息。（10-16 10:27、10:31 两次，数据库里两条审批都是 accepted。）
- 「完成待审核」= 主窗口没看过的已结束回复（`lib/sessionSeen.ts`，本机 localStorage），Host 不会设 `awaiting-review`。
- 画布没有右键菜单，也不能多选；卡片、便签、分组没有颜色；任务没有说明字段。
- 大文件：`claude-runtime.ts` 1860 行、`codex-runtime.ts` 1605 行、`store.ts` 789 行；界面 `Thread.tsx` 715、`ReviewApp.tsx` 662、`TaskPage.tsx` 660、`FocusApp.tsx` 549、`CanvasPage.tsx` 508。其余都在 500 行以内。

## 分期

| 编号 | 内容 | 状态 |
|---|---|---|
| S16-A | 小修：Focus 状态不恢复；Focus「我知道了」；默认路径 | 做完 |
| S16-R | 重构：runtime、store、大界面文件按职责拆分，行为不变 | 做完 |
| S16-B | 画布：任务说明（迁移 + MCP）、颜色标记（卡片 / 便签 / 引用 / 分组，MCP 也能标）、右键菜单 | 做完 |
| S16-C | 阶段 15 第一期：服务说明、`amo_guide`、`amo_whoami`、主控标记、专题文档 | 做完 |
| S16-D | 阶段 15 第二期：主控提案 → 确认 → 建任务上画布 | |
| S16-E | 阶段 15 第三期：传话 | |

### 画布右键（参照 Obsidian Canvas）

- 空白处：新便签、新任务（在这个专题）、引用任务、新分组、全部显示（缩放到全部内容）、重置缩放。
- 任务卡 / 引用卡：颜色（无 / 红 / 黄 / 绿 / 蓝）、编辑说明、打开任务、从这里连依赖、移出分组、从画布移除、缩放到这里。
- 便签：颜色、编辑、转为任务、复制一份、删除。
- 分组：颜色、改名、解散（保留里面的卡片）、删除分组和里面的便签。
- 连线：反向、删除。
- 多选（框选、Shift 点选）和对齐 / 均匀分布：先不做，单个对象的菜单用一段时间再看。

## 进度

（做完一项记一项：做法、取舍、测试。）

- **S16-A**（10-17）
  - Focus 状态：`claude-runtime.ts` 加 `afterWait`，批准 / 拒绝 / 回答 / CLI 中止之后：这轮还在跑或还有别的在等，按原来的规则；否则从「等你批准 / 等你回答」回到空闲。测试 `wake.integration.test.ts`「an agent in the background asks between turns」。要重启 Host 才生效。
  - 「我知道了」：Focus 里「完成待审核」的条目展开后多一个按钮，记为看过（`noteSeen`）并收起，条目离开列表，不切主窗口。e2e `focus.spec.ts`。
  - 默认路径：去掉 10-15 的「默认项目」（新建任务回到改之前：从哪个项目进来就选哪个，否则不指定）；设置 → 项目与目录「默认路径」（localStorage `amo.defaultFolder`），添加项目 / 新建任务里「选择文件夹」从这里开始（`amo:pick-directory` 收一个起点，文件夹不存在时忽略）。测试模式下对话框不弹，`__amoPickDirectory` 记起点、给答案。e2e `newtask.spec.ts`。要重启 Electron 主进程才生效（preload 和主进程改了）。

- **S16-R**（10-17，行为不变）
  - `runtime.ts` 加 `RuntimeCore`（RuntimeBase 的存储辅助函数绑定后交给各部分）和 `makeCore()`。
  - Claude（1860 → 661 行）：`claude-runtime.ts` 只留操作和进程生命周期；`messages.ts`（CLI 消息 → 条目）、`turns.ts`（回合、工具卡、后台命令、提示、重试）、`subagents.ts`、`asks.ts`（审批和提问）、`wake-control.ts`（loop / 额度）、`usage-tracker.ts`、`transcripts.ts`、`probe.ts`（只为问型号 / 命令起的进程）、`live.ts`、`commands.ts`、`tool-use.ts`、`core.ts`。
  - Codex（1605 → 511 行）：改为继承 RuntimeBase（删掉自己那份一样的辅助函数）；`events.ts`（app-server 通知 → 条目）、`asks.ts`、`describe.ts`、`account.ts`、`state.ts`。
  - store（789 → 478 行）：`rows.ts`（行映射）、`documents.ts`（各功能的 JSON 文档表，`DocumentStore` 基类，Store 继承，调用方不变）。
  - 界面：`Thread.tsx` 715 → 606（`ThreadParts.tsx`、`annotationMarks.ts`）；`TaskPage.tsx` 660 → 549（`SessionHead.tsx`）；`FocusApp.tsx` 577 → 317（`FocusEntry.tsx`、`FocusSettings.tsx`、`windowShape.ts`）；`ReviewApp.tsx` 662 → 562（`ReviewHead.tsx`）。`CanvasPage.tsx` 在 S16-B 里拆（`cards.tsx`、`CanvasMenu.tsx`）。
  - 公开导出不变（claude / codex runtime 转导出搬走的函数）。测试只改了一处：`wake.integration.test.ts` 改从 `asks` 调 `askPerson`。
  - 测试：单测 600/603（server-manager 端口测试 3 条在开发版占着 47940 端口时失败，原版代码同样失败，空闲时通过），完整 e2e 见下。
- **S16-B**（10-17）
  - 任务说明：迁移 14 `tasks.description`；`PATCH /api/tasks/:id { description }`（最长 2000 字，空即删除）；画布卡片显示两行（有说明的卡片高 102，连线按这个高度算），引用卡片显示被引用任务的说明；任务页标题下显示、⋯ 菜单「添加 / 编辑说明…」；画布侧栏任务详情里显示并可编辑。对话框 `task/DescriptionDialog.tsx`（Ctrl+Enter 保存）。
  - 颜色标记：`CanvasColor = red | yellow | green | blue`，存在画布 JSON 的卡片 / 便签 / 分组上（不需要迁移），`validateCanvas` 拒绝未知颜色；外框变色，分组标题栏带一层色。
  - MCP：`task_describe`（自己的任务，或同专题的任务）和 `canvas_color`（自己专题画布上的任务卡 / 引用卡 / 便签 / 分组，none 取消），都不用每次批准（文字和标记，只在自己的专题里）；`canvas_read` 的大纲带上说明（`说明：…`）和颜色（`【红】`），JSON 里便签变成 `{ id, text, color }`。
  - 右键菜单（`canvas/CanvasMenu.tsx`）：空白处（新便签 / 新分组在点击处、引用任务、在专题里新建任务、全部显示、复位缩放）；任务卡（颜色、添加 / 编辑说明、打开、连依赖：选它之后的任务、移出分组、居中、从画布拿掉）；引用卡（颜色、说明、打开、移出分组、居中、删除引用）；便签（颜色、编辑、复制一份、移出分组、删除）；分组（颜色、改名、居中、解散、删除分组和里面的便签 / 引用）；连线（加了一条透明的粗线接右键：反过来、删除依赖）。缩放条加「全部」。
  - 没做：便签「转为任务」（新建任务页还不能带入文字，留到主控提案那期一起做）；多选和对齐（计划里说先不做）。
- **S16-C**（10-17，阶段 15 第一期）
  - 主控标记：迁移 15 `tasks.lead`；新建任务「设为主控」，任务页标题旁「主控」，⋯ 里「设为主控 / 取消主控」；看板卡片和画布卡片上的「主控」。一个专题 / 项目可以有多个主控。
  - 专题文档：迁移 15 `topic_docs`；`/api/topics/:id/docs`、`/api/topic-docs/:id`；事件 `topicdoc.upserted / removed`；画布侧栏「文档」页（列表、Markdown 查看、编辑、删除）。功能目录 `features/topicdocs/`。
  - agent 懂 AMO（`features/guide/`）：MCP 服务说明改写（AMO 的实体、主控和执行的分工、先调 amo_whoami）；`amo_whoami`（角色卡：主控 / 执行 / 专题会话 / 分支、任务和说明、项目、专题和它的主控、专题文档、文件标记数、这个角色该做和不该做的）；`amo_guide`（overview / tasks / topics / canvas / collab / lead / files）；`topic_docs`（读）和 `topic_doc_write`（只有专题的主控或专题会话能写，不用每次批准）。Claude 会话的 MCP 服务说明后面直接带上自己的角色卡（`ClaudeRuntimeOptions.mcpInstructions`，进程启动时的样子，之后的变化靠 amo_whoami）；Codex 的服务说明是通用的，靠 amo_whoami。没改任何 CLI 的系统提示词。
  - 主控的职责写在角色卡和 amo_guide 的 lead 段：拆成平级任务、排画布、写说明和专题文档，活交给各任务的会话，不把重活放进自己的子 agent（用户 10-17 的反馈）。拆任务的提案工具在 S16-D。
  - 测试：MCP（角色卡、指南、主控写文档、非主控被拒）、topicdocs 接口和主控标记、e2e `lead-docs.spec.ts`；截图 `S16-C-lead`、`S16-C-topic-docs`。

