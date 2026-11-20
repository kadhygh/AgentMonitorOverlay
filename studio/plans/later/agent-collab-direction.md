# AMO 后续方向：agent 协作层、任务管家、协作信道

> 状态：以后推进（2026-11-13 只是聊，用户说「先不推进」；2026-11-15 整理成这份，供另一个会话接着谈后续开发）。没写代码，也没定第一刀。2026-11-20：方向 1 的 session 卡 / topic 卡就是白板（`plans/whiteboard.md`，11-19 用户定中间层先只试它）；「全景」那一半的方案挪到了 `plans/later/userlayer/`。

## 背景

用户 11-13 正在迭代单个会话的增强面板，让人能更好地审批会话。聊 DSH 0.2.2-rc.2 的 AgentTeam（agent 集群）时，用户提出：AMO 已经能让 A 模型拉起 B 模型干活，下一步瓶颈在 agent 和 agent 之间、人和多个 agent 之间的协作。用户说的三个方向（按用户的顺序）：

1. **搭更稳定的 AMO 架构层，方便 agent 之间协作。** 例：会话里子会话发给主会话的内容要有更稳定的接收，给人看时折叠在「agent 交互」栏里；给 project、topic 甚至 session 扩展信息组件，协作时用，也避免压缩上下文后忘事。
2. **1 搭好、跑起来之后，在 AMO 内部对接任务管家 agent。** 以后聊天走「管家 + 全景」的模式，提高人和 agent、agent 和 agent 之间的协作效率。
3. **增加更多 relay（中转）功能，做成协作信道。** 让不同设备和 AI 之间交互更快。

下面每个方向写：现在有什么、我（Claude）的建议、要注意的旧决定。建议都还没和用户确认。

## 共同的底子：一种「agent 消息」

三个方向都要在 agent 之间传话。建议先定一种统一的消息，后面三处共用：

- 带上**谁发的、发给谁、哪一类**（回报 / 提问 / 交接 / 结果）、**回应哪一条**。
- 本机子会话的回报、另一台设备上 AI 发来的话、同事的 AI 来要确认，格式都一样，只是走的路不同（本机收件箱 / 中转）。
- 模型拿到时能分清「这是 agent 说的，不是人说的」；人看时按类型折叠。

## 方向 1：agent 协作层

**现在有的：**

- 会话收件箱 `host/src/features/sessions/inbox.ts`（2026-11-04，`plans/done/message-delivery.md`）：中转回复、值守、`task_message` 传话、转来的信、`session_send`、`session_start` 的回报，都先存成「等这一轮结束后送进去」的一行，会话空下来再送；Host 重启接着送；送不进去标「没送到」，可以重新发送；人停下的会话先压着，等人的下一条消息一起送。投递的可靠性已经有大半。
- `session_start(report: true)`：子会话每轮结束把最后的回复送回开它的会话（`sessions/service.ts` `startPeer`、`watchReports`）。
- 缺的：这些消息进对话时还是**普通文字**，没有类型、来源、回应关系；界面上和人的消息混在一起；子会话之间不能互相发（`session_send` 只许发给自己开的会话）。

**建议：**

- 在收件箱的行上加类型和来源，界面按类型折叠进「agent 交互」栏。这一栏可以放进用户正在做的增强面板，审批和 agent 交互在一处看。
- **信息组件**：每层只放一张小而结构化的卡，避免又一堆没人看的文档（已有任务说明、进度备注、交接、专题文档、书签）：
  - session 卡：目标、当前状态、已定的事、待办；
  - topic 卡：决定、开放问题；
  - project 卡：约定、关键路径。
  - agent 通过 MCP 写，人能改；**压缩上下文后自动送回模型**（比如放进 `amo_whoami` 的角色卡）。防遗忘靠「一定会被读回」，光有地方写不够。
- 第一刀建议：消息加类型 + 「agent 交互」栏 + session 卡。

## 方向 2：任务管家 + 全景

**要注意的旧决定：** 10-30 用户定过「先不要常驻的看板员，它要反复读全部内容，太烧 token」（`plans/later/canvas-workflow.md`）。管家和这条有冲突，开工前要先和用户对齐。

**建议：**

- 管家**按需叫起，不常驻**；读方向 1 的卡和 agent 消息，不读原始对话。这样成本低、判断也准。所以它要排在 1 后面。
- 管家说的每件事标出处（哪张卡、哪条消息）；要动别的任务，照现在 `task_message` 的规矩先经人确认。
- 「全景」是给人看的那一面，可以从现在的 Focus 和看板长出来。

## 方向 3：relay 协作信道

**现在有的：** 中转进会话（`plans/done/relay-in-sessions.md`，AI 找人确认）、远程会话（`plans/done/remote-session.md`，从另一台设备开、看、控制会话）。

**建议：** 跨设备的 AI 消息就是方向 1 的同一种消息走中转，界面上也进「agent 交互」栏，不另做一套交互。

**要守的旧决定：**

- 只在局域网、只连自己的设备；远程默认关闭，按账号开，没登录就开不了。
- 发给真人前先问用户（除非用户在 设置 → 功能 → 中转 打开了自动发送 `teamAutoSend`）。

## 同日谈过的：协作模板（没定）

用户的想法：AMO 提供模型协作模板和接口，让 AI 能理解和配置；开新会话时勾选一个协作模式，以后就不用每次 @子会话。

我设想的样子：

- 模板 = 名字和说明 + 角色（每个角色是一份子会话设定：模型、强度、Fast、权限，加职责说明，复用 `SubsessionSetup`，见 `plans/done/subsession-mention-2026-11-05.md`）+ 分工规则（一段文字）+ 硬限制（只能开模板里的角色、同时最多几个、子会话能不能再开下一层，由 Host 在 `session_start` 里强制执行）。范围和提示词模板一样分全局 / 项目。
- 新建任务页和会话输入框旁边选模板，整个会话都按它走，会话上显示标签；协作说明附在第一条消息里，也写进角色卡；开子会话用角色名（`session_start(setup: "审查")`）。
- AI 用 `collab_template_list` / `collab_template_save` 读写，照 `prompt_template_save` 的做法；`amo_guide` 加一节。

**没答的问题：**

1. 选了模板后整个会话一直生效、能中途换或关（我推荐），还是只管当前那条消息？
2. 模板里的模型是硬限制（我推荐，好控制额度），还是建议？
3. AI 保存模板：照提示词模板「保存不用批、删除要批」（我推荐），还是保存也要批？
4. 单独开一页「协作模板」（我推荐），还是并进提示词模板当一种类型？

它在方向 1 之后最自然：分工规则本质上是约定 agent 之间怎么发方向 1 的那种消息。

## DSH 可以借的几条（11-12 读 DSH 0.2.2-rc.2 源码，没实测）

DSH 的 AgentTeam = 具名、多层的子代理 + 整棵树共用一块任务板。值得借的是规矩，不是框架。我们拉起别的模型的能力比它强：我们的子会话是完整会话，能续聊、人能看能插手；DSH 拉起 Claude Code / Codex 只是一次性委派。

| # | 做法 | 我们现在 | 成本 |
|---|---|---|---|
| 1 | 委派说明里加一句「只剩等结果时结束本轮，不要 sleep 或轮询」。DSH 实测：两个 DeepSeek 型号各 150 次请求，有这句 300 次里 sleep 0 次，没有 29 次；一个长会话没这句时为等子代理 sleep 七次、约 25 分钟（DSH `.agents/notes/implemented/bug-fix/2026-10-21-subagent-end-turn-guidance.zh.md`） | `session_start` 的说明里没有（`team_ask` 有） | 改一行 |
| 2 | 子会话层数和并发上限（DSH `maxDepth` 默认 1） | 代码里没找到上限 | 小 |
| 3 | 子会话能用哪些模型由人定，会话开始时固定名单（DSH `subagent-model-selection`） | AI 想开哪个模型都行，只限制权限不能比自己宽 | 中偏小 |
| 4 | 同一棵树里的会话互相发消息，中断仍只许祖先（DSH 整树通信） | 只能发给自己开的会话 | 中 |
| 5 | 开子会话时带上父会话已有的上下文（DSH `subagent_fork`） | AI 开的子会话都从空白开始；分支只有人能开 | 中（DeepSeek 走 ACP 不能分支） |

另外两条设计原则，做任务板或管家时可以照搬：

- 任务板改动不叫醒任何人；要谁干活，就明确发一条消息给谁（DSH `simplification/2026-10-29-inbox-only-agent-wait`）。
- 历史记录不授予权限；身份只用一套（子代理的 Session id），不另建 Team 名册（DSH `architecture/2026-10-15-agent-teams-as-subagents`）。

## 建议的顺序

1. 方向 1 的最小一刀：agent 消息加类型 + 「agent 交互」栏 + session 卡；顺手做上表 1、2、3。
2. 协作模板。
3. 方向 3 或方向 2，看当时哪边更痛。

## 相关

- `plans/done/message-delivery.md`：会话收件箱
- `plans/done/subsession-mention-2026-11-05.md`：@ 子会话和子会话设定
- `plans/done/prompt-templates.md`：提示词模板（AI 读写模板的先例）
- `plans/later/canvas-workflow.md`：画布工作流（「不常驻看板员」的决定）
- `plans/done/relay-in-sessions.md`、`plans/done/remote-session.md`：中转进会话、远程会话
- 代码：`host/src/features/sessions/inbox.ts`、`sessions/service.ts`（`startPeer`）、`sessions/mcp.ts`、`sessions/setups.ts`
- DSH 源码：`G:\PROJECT\deepseek-harness`（看 `origin/master`，本地检出还停在 0.2.1-rc.2）
