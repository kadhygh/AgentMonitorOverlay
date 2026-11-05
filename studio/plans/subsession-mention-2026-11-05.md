# @ 子会话：新流程（2026-11-05）

分支 `studio/subsession-mention`（worktree `.claude/worktrees/subsession-mention`）。界面草图：`plans/subsession-mention.html`（双击打开）。

用户原话（11-05）：
> 子会话在开始任务的界面 at不出来。
> 子会话 一般都是由ai来开，所以我觉得 结果回到这个会话不需要我们配置可以删掉。
> 然后子会话设置面板 每种模型可能都要有自己的设置方式。另外子会话我现在倾向于这样 at出来之后 选择子会话和对应的模型，做简单说明，但是选模型时，要能看到和模型配置思考强度 还有相关的比如fast 之类的设置选项的选择支持。 而且针对模型，能看到我们已经编辑好的提示词，还允许我们补充一些针对这轮的模型的提示词。 成功at之后， 聊天框里也要有 子会话-模型名-思考强度 这种展示。

## 0. 第 1 件已做：新建任务页 @ 不出子会话

- 原因：`useComposerMentions` 只在有「当前会话」时给「开子会话…」（`current.kind !== "sub" && current.taskId`），新建任务页传的是 `current: null`。另外草稿的 `cleanRefs` 只认带 id 的项目、任务、会话，子会话的设定存进草稿后，离开页面再回来就丢了。
- 改法（提交 `63d82354`）：hook 加 `subsession` 参数给没有会话的输入框用，新建任务页传 `true`（任务的第一个会话是主会话，能开子会话）；`SubSessionDialog` 的第一个模型改成 `defaultPick`（新建任务页用草稿选的模型，会话里用会话的模型）；`cleanRefs` 留住子会话设定。快捷栏（Ctrl+N 那一行）没加：一行的输入框放不下，而且后面的新弹窗更大。
- 验证：typecheck、build、UI attach/newtask 单测 36 条、e2e `newtask.spec.ts` 9 条（新增一条）和 `attachments.spec.ts` 的开子会话一条；截图 `screenshots/studio/newtask-subsession-dialog.png`。

## 1. 现状

| 部分 | 文件 | 现在怎么做 |
|---|---|---|
| @ 列表 | `ui/src/attach/mentions.ts` `mentionGroups` | 「AMO 扩展功能」下有「开子会话…」 |
| 弹窗 | `ui/src/attach/SubSessionDialog.tsx` | 选模型（`ModelRow`）、思考强度（`EffortBars`）、权限（默认/只读/可写/完全放开）、勾选「结果回到这个对话」；显示设置里写的说明；预览一行 `session_start 带 …`。记住上次的模型、权限、report（localStorage `amo.subsessionSetup`） |
| 输入框里 | `useMentions.tsx` `finishSubsession`、`MentionBackdrop` | 放进 `@子会话N`，文字上色（textarea 文字透明，背后一层同样的文字上色，所以两层的字必须一模一样） |
| 发出去的消息 | `mentions.ts` `withMentionRefs` / `subSessionArgs` | 消息末尾追加一段「子会话的开法（要开时用 AMO 的 session_start…）：- @子会话1：session_start 带 model: "…"，effort: "…"，permission: "…"，report: true。人对这个模型的说明：…」。**设定只活在这段文字里**，主模型照着抄参数，Host 不知道 |
| 对话里显示 | `chat/Transcript.tsx` 约 340–360 行，`splitMentionRefs` | `@子会话1` 上色，悬停看说明；下面一行「AMO：已附上提到的…说明」（只有子会话时这行写成「任务、会话说明」，不准确） |
| 设置 → 子会话 | `ui/src/settings/SubsessionPage.tsx` | 每个渠道一排型号按钮，点开写一段说明（`SubsessionNote {profileId, model, note}`，最多 30 段、每段 1000 字）。只有文字，没有别的设置 |
| 说明给谁看 | `host/src/features/guide/role.ts` 约 109 行 | 主模型的身份说明（amo_whoami）里列「人写的模型用法」；@ 了某个模型时消息里也带上那一段 |
| Host 开会话 | `host/src/features/sessions/mcp.ts` `session_start`；`sessions/service.ts` `startPeer` | 参数 `text, model, title, report, workspace, permission, effort, forPerson`。**没有 fast**。effort 不带就用 设置 → 模型 的默认 |

## 2. 各模型能设什么（核实过的）

Studio 现在的三种 CLI。思考强度的可选值都是运行时问 CLI 拿到的（`ModelOption.efforts`），界面照列表画，不写死。

| | 思考强度 | Fast | 权限（session_start 的三档对应） | 来源 |
|---|---|---|---|---|
| Claude（Claude Code） | 每个型号自己的 `supportedEffortLevels`（SDK `supportedModels()`，`runtime/claude/probe.ts`）。文档：Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Opus 5 / Opus 4.8 / Opus 4.7 / Fable 是 low–max 五档；Opus 4.6、Sonnet 4.6 没有 xhigh；5.5 系默认 medium（文档这段是摘要读取，没逐字核对） | **Studio 还没接**。SDK 0.3.304 的型号信息有 `supportsFastMode`，设置项 `fastMode`（`applyFlagSettings`）。文档：只有 Opus 5.5、Opus 5、Opus 4.8 有；**订阅账号只能走 usage credits（额外用量），不算订阅额度**，没开额外用量会报「Fast mode requires usage credits」；Opus 5.5 $8/$40 每百万 token | 只读 = plan，可写 = auto（帮我审批），完全放开 = bypassPermissions | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`；https://code.claude.com/docs/en/fast-mode、/model-config |
| Codex | `model/list` 的 `supportedReasoningEfforts`（`runtime/codex/account.ts`）；文档说可选值随型号变（low…max/ultra） | **已接**：型号的 `serviceTiers` 里有名为 Fast 的档（id `priority`）就有，会话选项 `options.fast`，Codex 自己的说明是「2x speed, increased usage」；`session_start` 没有这个参数 | read-only / workspace-write / full-auto | `runtime/codex/codex-runtime.ts` `serviceTier`；https://developers.openai.com/codex/config-reference |
| DSH（DeepSeek、Dxx-DS 等） | ACP 配置项 `reasoning_effort` 的可选值（`runtime/dsh/dsh-runtime.ts`） | 没有 | read-only / workspace-write / full-access | `runtime/dsh/` |

Codex 还有 `model_reasoning_summary`、`model_verbosity`，Studio 里任何地方都没有，这次也不加。

## 3. 新流程

1. 输入框里打 `@`，「AMO 扩展功能」下选「开子会话…」（新建任务页、会话输入框都有）。
2. 弹窗「开子会话」，从上到下：
   - **模型**：同现在的模型行（常用型号 + 全部型号）。
   - **这个模型的选项**：随模型换。Claude：思考强度条（按型号的列表），型号支持时有「Fast（按额外用量计费）」开关；Codex：思考强度条，型号有 Fast 档时有「Fast（2 倍速度，用量更多）」开关；DSH：只有思考强度。都从 设置 → 子会话 里这个型号的默认开始。权限收进「更多」一行（默认/只读/可写/完全放开），平时不用动。
   - **你写的模型用法**：设置 → 子会话 里这个型号（或整个渠道）的那段，只读，折成两行，旁边「去设置里改」。没写过就显示「还没写，去设置里写」。
   - **这一轮补充**：多行输入框，可以不写。例子：「这轮只改 ui 包，不动 host；改完跑 newtask 的 e2e」。
   - 底部预览输入框里会出现的标签，「放进输入框」。
   - 删掉「结果回到这个对话」。
3. 输入框里出现 **`@子会话·Opus 5.5·high`**（没选强度时写「默认强度」，开了 Fast 加「·Fast」；同一条消息里第二个同样的设定后面加 2）。还是整段上色，悬停看全部设定。
4. 发出去后，对话里这条消息显示同样的标签；下面一行改成「AMO：已附上子会话设定」。

## 4. 数据怎么传

两种做法：

- **A 全写进消息（现在的做法加长）**：这一轮补充也写进消息末尾那段，让主模型开会话时原样放进 `session_start` 的 `text`。不改 Host。缺点：补充的话要主模型一字一字抄，长了会被改写、漏掉；Fast 也没有参数可抄。
- **B 设定交给 Host（推荐）**：
  - 发消息时，界面把这条消息里的子会话设定一起交给 Host：`POST /api/sessions/:id/messages` 和 `POST /api/tasks` 的 `firstSession` 加 `subsessions: [{ name, profileId, model, effort?, fast?, permission?, extra? }]`。Host 记在发消息的会话名下（kv `subsession-setup:<sessionId>`，登记进 `store/kv-keys.ts`，会话删了一起删；同名的后来覆盖先前的）。
  - 消息末尾那段变短：「- @子会话·Opus 5.5·high：要开时用 session_start 带 setup: "子会话·Opus 5.5·high"（模型、强度、Fast、权限和人补充的话 Host 会自己带上）」，再加人写的模型用法（给主模型看怎么交代）。
  - `session_start` 加参数 `setup`（这个会话收到过的设定名）和 `fast`（boolean，只对有 Fast 的型号有效，Claude 和 Codex 都接）。带了 `setup`：模型、强度、Fast、权限都从设定来，主模型同时写的同名参数以设定为准（人定的优先），`text` 后面接上一段「【人补充的话】…」原样给子会话。设定名不存在时报错，列出这个会话有的设定。
  - Claude 的 Fast 要在 Claude runtime 里接上：启动时 `settings` 叠加 `{ fastMode: true }`，型号不支持时不带。没有额外用量时 Claude Code 会拒绝：把它的提示原样显示在子会话里。

  缺点：多一处存储、要改 Host 和 MCP 工具说明；好处是补充的话一字不差到子会话、Fast 能真正生效、主模型抄错参数也没关系。

**`report`**：界面上不再让人配，弹窗、设定、消息里都不出现。`session_start` 的 `report` 参数保留给 AI 用，带不带由主模型按工具说明自己定（它要结果就带）。以前存下的 `report` 读到就忽略；旧消息照样能显示。

## 5. 设置 → 子会话 按模型分

每个渠道下面还是一排型号按钮，点开一个型号，展开的一块不只是说明：

- **默认选项**：思考强度、Fast（型号有才显示）、权限，和弹窗里的控件一样，按这个型号的 CLI 列出来；「整个渠道」那块只有说明和权限（不同型号强度列表不同）。
- **模型用法**：现在的说明文本框，不变。

存法：`SubsessionNote` 加可选的 `effort?`、`fast?`、`permission?`（旧数据照常能读），`PUT /api/settings` 的校验跟着加。

这些默认值用在：@ 弹窗选到这个型号时的初始值。要不要也用在 AI 不带参数直接 `session_start` 的时候，见问题 3。

## 6. 改动边界

改：`ui/src/attach/`（`SubSessionDialog`、`mentions.ts`、`useMentions.tsx`、`attach.css`）、`ui/src/settings/SubsessionPage.tsx`、`ui/src/chat/Transcript.tsx`（标签和提示行）、`ui/src/task/Thread.tsx` 和 `newtask/`（发消息时带设定）、`protocol`（`SubsessionNote`、发消息和建任务的请求）、`host/src/features/sessions/`（`session_start` 的 `setup`/`fast`、设定的存取）、`host/src/runtime/claude/`（Fast）、`host/src/features/guide/`（工具说明里的一句）、`store/kv-keys.ts`。

不改：远程设备上的新建任务（`RemoteDraft`，模型是那台电脑的）、快捷栏、`session_send`/`session_archive`、设置 → 模型 的默认值、Codex 的 summary/verbosity。

测试：mentions/draft 单测；host 的 `startPeer` 单测（setup、fast、优先级、找不到设定）；e2e：会话里和新建任务页各走一遍新弹窗，设置页改默认值，截图放 `screenshots/studio/`。

## 7. 要用户定的问题

1. **数据怎么传**：A 全写进消息 / **B 设定交给 Host（推荐）**。B 才能保证补充的话原样到子会话、Fast 生效。
2. **「简单说明」和「这一轮补充的提示词」是不是一个框**：**合成一个「这一轮补充」（推荐）**，原样交给子会话 / 分两个：一句「这次让它干什么」给主模型看 + 一段补充给子会话。
3. **设置里每个型号的默认选项，AI 自己 `session_start` 不带参数时用不用**：**用（推荐）**：设置里定了就处处算数，AI 不用每次猜强度 / 不用：只是 @ 弹窗的初始值，AI 不带参数时照旧用 设置 → 模型 的默认。
4. **Claude 的 Fast**：**做，开关旁边写明「按额外用量计费，订阅额度不包含」（推荐）** / 先不做，只给 Codex 的 Fast。
5. **输入框里的标签写法**：**`@子会话·Opus 5.5·high`（推荐，直接是文字，复制、撤销都正常）** / 保持 `@子会话1`，在输入框上方另放一个可点的小卡片显示「子会话 · Opus 5.5 · high」（点开能改，但要多做一块）。
6. **权限**：**收进弹窗的「更多」，默认用设置里的（推荐）** / 弹窗里去掉权限，只在设置里定。
