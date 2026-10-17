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
| S16-D | 阶段 15 第二期：主控提案 → 确认 → 建任务上画布 | 做完 |
| S16-E | 阶段 15 第三期：传话 | 做完 |

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
- **S16-D**（10-17，阶段 15 第二期）
  - MCP `task_plan_propose`（只有主控或专题会话能提，不用每次批准：提案本身什么都不建）：summary + 最多 20 个任务（key、标题、项目 id 或名字、说明、第一句话、模型名或 id、dependsOn）；校验项目、模型（不认识时列出可选的）、依赖不成环。迁移 16 `task_plans`（JSON）；事件 `taskplan.upserted`；`GET /api/task-plans`、`POST /api/task-plans/:id/accept`（改过的任务 + run）、`/dismiss`（note）。功能目录 `features/taskplans/`。
  - 确认：专题画布顶部和主控的任务页上的提案条 →「查看」打开确认框（每个任务可以去掉、改名、换项目、换模型、改说明和第一句话，看得到依赖）→「放进待办」或「立刻开跑」（用第一句话开它的第一个会话）/「不采用…」（可写原因）。接受后建任务、写说明、放上专题画布（跨几个项目时每个项目一个分组）、连好依赖；结果作为留言回给主控（带新任务的 id），不采用也一样。Focus 把等确认的提案算作一件「事」，点它打开主控的任务页。
  - 主控的角色卡里列出可用的模型和自己在等的提案；amo_guide 的 lead 段改为用 task_plan_propose。
  - 测试：`taskplans.test.ts`（只认主控、校验、改过的接受、按项目分组、依赖、留言、不采用）、MCP 工具表、e2e `task-plans.spec.ts`（mock 模型真的调 MCP 提案 → Focus → 画布确认）；截图 `S16-D-plan`。
- **S16-E**（10-17，阶段 15 第三期：传话）
  - MCP `relay_send`（只有主控或专题会话；目标是自己专题里的任务，不在专题里时是自己项目里不在专题的任务）。迁移 17：`tasks.relay_auto`（「主控传话不用确认」）和 `relays`（JSON）；事件 `relay.upserted`；`GET /api/relays`、`POST /api/relays/:id/deliver`、`/dismiss`。功能目录 `features/relays/`。
  - 默认等人确认：目标任务页和主控任务页上的传话条、Focus 里（就地「发送 / 不发」，算一件「事」）。目标任务 ⋯ 里「主控传话不用确认」打开后直接送。送进目标任务最近的主会话（正在回复时排队，交给终端的不算），没有就用主控的模型开一个新会话。消息开头「【主控「X」传话】」，结尾告诉它怎么回复（mailbox_send）。送到、没送到、不发，都留言告诉主控。
  - amo_guide 的 lead 段和主控角色卡写了什么时候用 relay_send、什么时候用留言。
  - 测试：`relays.test.ts`（只认主控、范围、不发、送进新会话、不用确认时直接送进已有会话）、MCP 工具表、e2e `relays.spec.ts`（mock 模型真的调 relay_send → Focus 和任务页 → 发送 → 打开不用确认后直接送到）；截图 `S16-E-relay`。

- **S16-F**（10-17 下午，用户问「除了 Claude 别的能懂 AMO 吗」「普通任务后来引用到画布上能补充信息吗」）
  - Codex：`thread/start` 带 `developerInstructions` = 角色卡（`roleCardFor`：会话还没建，按任务 / 专题 / 项目算，会话一栏写「新会话」）。只在 Studio 自己起的 app-server（有 AMO MCP 身份）时带。MCP 服务说明那句改成「角色卡在会话开始时给你；没有或要看最新的，调 amo_whoami」。用户自己的 `~/.codex/config.toml` 没有 `developer_instructions`，不会被盖掉。
  - 角色变化：每个会话记下它最后知道的角色（kv `role-stamp:<会话>`：角色、专题、被哪些画布引用、任务说明）。Claude 在进程起来算服务说明时记，Codex 在开对话时记。之后经 `sessions.sendMessage` 发给它的消息（人发的、传话、留言、批注、Git Review）先比一下，有变化就在消息末尾附 `composeRoleUpdate` 的一段，发送成功后才记为已告知；子 agent、归档的会话不附。没记过的会话（10-17 之前开的、分支）第一次只记下、不附。
  - 界面：`splitRoleUpdate` 拆出来，用户消息里显示小标签「AMO 更新：已告诉它任务的变化」，悬停看全文；模型看到的是纯文本。
  - 角色卡多一行「也被引用在专题「X」的画布上：那里的主控、专题文档几篇」；传话的范围加上「引用在主控专题画布上的任务」。
  - 测试：单测 `features/guide/role.test.ts`（Codex 带角色卡、引用 / 进专题 / 主控 / 说明的提示只说一次、没记过的会话只记下、给引用的任务传话）、协议拆合；e2e `role-update.spec.ts`，截图 `screenshots/stage-16/S16-F-role-update.png`。
  - 看板（同一天）：列撑到页面底部（`.board` 在 `.main` 里 `flex: 1 0 auto`，列 `align-items: stretch`），卡片拖到列里任何位置都能放；`board.spec.ts` 改成拖到列底部。

- **S16-G**（10-17 下午，额度讨论之后。用户：迁移任务飞快消耗额度，是因为主-子 agent 吗）
  - 查到的（只读开发版库）：「迁移任务」主会话 66 轮跨两天，上下文从 51k 涨到 464k，一次没压缩（订阅 Opus / Sonnet 报的窗口是 100 万，CLI 接近窗口才压）；输入合计约 6000 万（缓存读约 5800 万），后期一句话的一轮约 45 万；隔了 1 小时以上再发，缓存多半过期（隔 2.5 小时那轮 28 万、隔 4 小时那轮 44 万没命中）。12 个子 agent 约 1900 次工具调用，用量 Studio 之前没记。用户的结论：以后大任务用 AMO 开多个任务，不用主-子 agent。
  - 自动压缩点（用户定 272k）：设置 → 模型「自动压缩点」，默认 `DEFAULT_AUTO_COMPACT_TOKENS` = 272000，可改（50k–1000k）或「交给 CLI 决定」（kv `settings:auto-compact-tokens`，`runtime/compact.ts`）。Claude：进程环境 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（CLI 说明：接近这个值和模型窗口中较小者时压缩；会覆盖 GLM 通道自带的 100 万）。Codex：thread/start、fork、resume 的 config 带 `model_auto_compact_token_limit`。会话启动或恢复时生效。
  - 子 agent 用量（Claude）：子 agent 的每次模型调用（assistant 消息带 message id 和 usage，同一调用按 id 只算一次）累加进子会话的一个「回合」条目，并写到主会话里那一行子 agent（`subagent.usage`）；会话底部多一项「子 agent X」（`sessionStats().subTokens`，不在左边的用量里——实测主会话回合的用量不含子 agent）。输入（上下文，几乎全部开销）是准的；输出偏少：CLI 在拿到最终输出数之前就把子 agent 的消息发出来，也不转发它的流（用 Mock 核对过），所以输出只记到每次调用开头的数。只回一句话、不调工具的子 agent 没有自己的消息，记不到。Codex 的子 agent 本来就有自己的回合用量。
  - 上下文提醒：上下文 ≥ 150k 时输入框上方一条（`chat/ContextHint.tsx`）：「上下文 180k · 每一步都要整个重读 · 到 272k 自动压缩 · 换阶段可开新会话」，「现在压缩」「知道了」（记在 localStorage，涨 50k 后再出）；Claude 会话距上次回复超过 1 小时时改说「缓存多半已过期，下一条要全价重读」。
  - DSH（DeepSeek Harness 0.1.6-alpha.2）怎么管上下文，供以后参考：到窗口 80% 压缩、只总结较早的部分并原样保留最近 16%；压缩前先把超大工具输出裁成头尾（不调模型）；超大输出放文件只留预览；溢出后压缩重试；同参数重复调用工具时提醒。Studio 的 DeepSeek 走 Codex 通道，用不上这些。接 DSH 当第三种运行时：它的 SDK 协议现在只有 initialize / session/prompt / shutdown 和事件，没有批准、提问、打断；ACP 有取消和选模型但说明里说不含交互功能——要先做试验。
  - 测试：单测 `runtime/compact.test.ts`（设置、Codex thread config、Claude 环境）、`wake.integration.test.ts`（子 agent 用量按调用只算一次、结束时回合收尾）、`claude-runtime.integration.test.ts`（真 SDK + Mock 的子 agent 用量）、`turns.test.ts`；e2e `context-hint.spec.ts`、`model-channels.spec.ts` 自动压缩点；Mock 加 `[[context: N]]`。截图 `S16-G-auto-compact`、`S16-G-context-hint`。

