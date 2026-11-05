# @ 子会话：新流程（2026-11-05）

> 状态：做完（2026-11-05 合进 master，Studio 0.9.43）。没验证过的两点：真的 Claude Opus 开 Fast（只用 mock 验证了开关和设定），主模型拿到「子会话的设定」后会不会照着带 `setup`（要真模型跑一次）。进度流水 2026-11-06 删掉了，原文见 git 历史（提交 f46907f2 之前的版本）。

当时的界面草图 `plans/subsession-mention.html` 没进 git，worktree 删掉后已经找不到了。

用户原话（11-05）：
> 子会话在开始任务的界面 at不出来。
> 子会话 一般都是由ai来开，所以我觉得 结果回到这个会话不需要我们配置可以删掉。
> 然后子会话设置面板 每种模型可能都要有自己的设置方式。另外子会话我现在倾向于这样 at出来之后 选择子会话和对应的模型，做简单说明，但是选模型时，要能看到和模型配置思考强度 还有相关的比如fast 之类的设置选项的选择支持。 而且针对模型，能看到我们已经编辑好的提示词，还允许我们补充一些针对这轮的模型的提示词。 成功at之后， 聊天框里也要有 子会话-模型名-思考强度 这种展示。

## 0. 新建任务页 @ 出子会话

- 原因：`useComposerMentions` 只在有「当前会话」时给「开子会话…」，新建任务页没有会话；草稿的 `cleanRefs` 也只认带 id 的项目、任务、会话，子会话设定离开页面就丢了。
- 做法（提交 `63d82354`）：hook 的 `subsession` 参数给没有会话的输入框用，新建任务页打开（任务的第一个会话是主会话，能开子会话）；`SubSessionDialog` 的第一个模型用 `defaultPick`（新建任务页用草稿选的模型，会话里用会话的模型）；`cleanRefs` 留住子会话设定。
- 快捷栏（Ctrl+N 那一行）不加：一行的输入框放不下这个弹窗。

## 1. 代码在哪

| 部分 | 文件 | 怎么做 |
|---|---|---|
| @ 列表 | `ui/src/attach/mentions.ts` `mentionGroups` | 「AMO 扩展功能」下有「开子会话…」（会话输入框和新建任务页） |
| 弹窗 | `ui/src/attach/SubSessionDialog.tsx` | 模型、这个模型的选项（强度、Fast）、人写的模型用法、这一轮补充；权限在「更多」里 |
| 输入框里 | `useMentions.tsx`、`MentionBackdrop` | 标签 `@子会话·模型·强度` 整段上色（textarea 文字透明，背后一层同样的文字上色，所以两层的字必须一模一样） |
| 发出去的消息 | `mentions.ts` `subSessionTag` / `subSessionName` / `subSessionSetups` | 消息末尾一段「子会话的设定（」，旧消息的「子会话的开法（」照样能读；会话和新建任务页发出时带 `subsessions` |
| 对话里显示 | `chat/Transcript.tsx` `splitMentionRefs` | 标签上色、悬停看设定；提示行「AMO：已附上子会话设定」 |
| 设置 → 子会话 | `ui/src/settings/SubsessionPage.tsx` | 每个渠道一排型号，每个型号有默认选项（`NoteDefaults`）和模型用法 |
| 设定的存取 | `host/src/features/sessions/setups.ts` | kv `subsession-setup:<会话>`（登记在 `store/kv-keys.ts`），按名字覆盖，留最新 30 个 |
| Host 开会话 | `host/src/features/sessions/mcp.ts` `session_start`；`sessions/service.ts` `startPeer` | 参数多了 `setup`、`fast` |
| Claude 的 Fast | `host/src/runtime/claude/probe.ts`、`claude-runtime.ts` | 型号 `supportsFastMode` 时 `ModelOption.fast`；`options.fast` 启动时进 `settings.fastMode`，中途用 `applyFlagSettings` |

## 2. 各模型能设什么（11-05 核实）

Studio 现在的三种 CLI。思考强度的可选值都是运行时问 CLI 拿到的（`ModelOption.efforts`），界面照列表画，不写死。

| | 思考强度 | Fast | 权限（session_start 的三档对应） | 来源 |
|---|---|---|---|---|
| Claude（Claude Code） | 每个型号自己的 `supportedEffortLevels`（SDK `supportedModels()`，`runtime/claude/probe.ts`）。文档：Opus 5.5 / Sonnet 5.5 / Haiku 5.5 / Opus 5 / Opus 4.8 / Opus 4.7 / Fable 是 low–max 五档；Opus 4.6、Sonnet 4.6 没有 xhigh；5.5 系默认 medium（文档这段是摘要读取，没逐字核对） | 型号信息的 `supportsFastMode`，设置项 `fastMode`（`applyFlagSettings`）。文档：只有 Opus 5.5、Opus 5、Opus 4.8 有；**订阅账号只能走 usage credits（额外用量），不算订阅额度**，没开额外用量会报「Fast mode requires usage credits」；Opus 5.5 $8/$40 每百万 token | 只读 = plan，可写 = auto（帮我审批），完全放开 = bypassPermissions | `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`；https://code.claude.com/docs/en/fast-mode、/model-config |
| Codex | `model/list` 的 `supportedReasoningEfforts`（`runtime/codex/account.ts`）；文档说可选值随型号变（low…max/ultra） | 型号的 `serviceTiers` 里有名为 Fast 的档（id `priority`）就有，会话选项 `options.fast`，Codex 自己的说明是「2x speed, increased usage」 | read-only / workspace-write / full-auto | `runtime/codex/codex-runtime.ts` `serviceTier`；https://developers.openai.com/codex/config-reference |
| DSH（DeepSeek、Dxx-DS 等） | ACP 配置项 `reasoning_effort` 的可选值（`runtime/dsh/dsh-runtime.ts`） | 没有 | read-only / workspace-write / full-access | `runtime/dsh/` |

Codex 还有 `model_reasoning_summary`、`model_verbosity`，Studio 里任何地方都没有，这次也不加。

## 3. 流程

1. 输入框里打 `@`，「AMO 扩展功能」下选「开子会话…」（新建任务页、会话输入框都有）。
2. 弹窗「开子会话」，从上到下：
   - **模型**：同会话的模型行（常用型号 + 全部型号）。
   - **这个模型的选项**：随模型换。Claude：思考强度条（按型号的列表），型号支持时有「Fast（按额外用量计费）」开关；Codex：思考强度条，型号有 Fast 档时有「Fast（2 倍速度，用量更多）」开关；DSH：只有思考强度。都从 设置 → 子会话 里这个型号的默认开始。权限收进「更多」一行（默认/只读/可写/完全放开），平时不用动。
   - **你写的模型用法**：设置 → 子会话 里这个型号（或整个渠道）的那段，只读，折成两行，旁边「去设置里改」。没写过就显示「还没写，去设置里写」。
   - **这一轮补充**：多行输入框，可以不写。例子：「这轮只改 ui 包，不动 host；改完跑 newtask 的 e2e」。
   - 底部预览输入框里会出现的标签，「放进输入框」。
   - 没有「结果回到这个对话」。
3. 输入框里出现 **`@子会话·Opus 5.5·high`**（没选强度时写「默认强度」，开了 Fast 加「·Fast」；同一条消息里第二个同样的设定后面加 2）。整段上色，悬停看全部设定。
4. 发出去后，对话里这条消息显示同样的标签；下面一行「AMO：已附上子会话设定」。

带着子会话设定的任务不能「放进待办」，会提示先去掉或直接开始。

## 4. 数据怎么传：设定交给 Host

考虑过两种：A 全写进消息末尾那段，让主模型开会话时原样抄进 `session_start`，不改 Host；B 设定交给 Host。选 B：A 要主模型一字一字抄补充的话，长了会被改写、漏掉，Fast 也没有参数可抄。B 的代价是多一处存储、要改 Host 和 MCP 工具说明，换来补充的话一字不差到子会话、Fast 真正生效、主模型抄错参数也没关系。

- 发消息时界面把这条消息里的子会话设定一起交给 Host：`POST /api/sessions/:id/messages` 和 `POST /api/tasks` 的 `firstSession` 带 `subsessions: [{ name, profileId, model, effort?, fast?, permission?, extra? }]`。Host 记在发消息的会话名下，会话删了一起删；同名的后来覆盖先前的。
- 消息末尾那段只写「要开时用 session_start 带 setup: "<名字>"」，再加人写的模型用法（给主模型看怎么交代）。
- `session_start` 的 `setup`（这个会话收到过的设定名）和 `fast`（只对有 Fast 的型号有效，Claude 和 Codex 都接）。带了 `setup`：模型、强度、Fast、权限都从设定来，人补充的话接在第一句话后面「【人对这个子会话补充的话（@名字）】」原样给子会话。设定名不存在时报错，列出这个会话有的设定。
- **优先级**：设定 > AI 写的参数 > 设置里这个型号的默认 > 设置 → 模型 的默认（人定的优先）。设置的默认：强度用型号自己那条的，Fast 和权限型号没写就用「整个渠道」那条。
- **权限**：人定的权限（设定里的、或 AI 没写时用的设置默认）不受「不比开它的会话宽」的限制；AI 自己写的照旧受。
- Claude 的 Fast：没有额外用量时 Claude Code 会拒绝，把它的提示原样显示在子会话里。

**`report`**：界面上不再让人配，弹窗、设定、消息里都不出现。`session_start` 的 `report` 参数保留给 AI 用，带不带由主模型按工具说明自己定（它要结果就带）。以前存下的 `report` 读到就忽略；旧消息照样能显示。

## 5. 设置 → 子会话 按模型分

每个渠道下面还是一排型号按钮，点开一个型号：

- **默认选项**：思考强度、Fast（型号有才显示）、权限，和弹窗里的控件一样，按这个型号的 CLI 列出来；「整个渠道」那块只有说明和权限（不同型号强度列表不同）。
- **模型用法**：说明文本框。

存法：`SubsessionNote` 有可选的 `effort?`、`fast?`、`permission?`（旧数据照常能读），`PUT /api/settings` 跟着校验。

这些默认值用在 @ 弹窗选到这个型号时的初始值，也用在 AI 不带参数直接 `session_start` 的时候（用户决定 3）。

## 6. 范围

不改：远程设备上的新建任务（`RemoteDraft`，模型是那台电脑的）、快捷栏、`session_send`/`session_archive`、设置 → 模型 的默认值、Codex 的 summary/verbosity。

## 7. 用户的决定（11-05，都按推荐）

1. **数据怎么传**：B 设定交给 Host（不是 A 全写进消息）。B 才能保证补充的话原样到子会话、Fast 生效。
2. **「简单说明」和「这一轮补充的提示词」**：合成一个「这一轮补充」框，原样交给子会话（不分成给主模型看的一句 + 给子会话的一段）。
3. **设置里每个型号的默认选项，AI 自己 `session_start` 不带参数时也用**：设置里定了就处处算数，AI 不用每次猜强度。
4. **Claude 的 Fast**：做，开关旁边写明「按额外用量计费，订阅额度不包含」。
5. **输入框里的标签**：直接是文字 `@子会话·模型·强度`，复制、撤销都正常（不做输入框上方另放的小卡片）。
6. **权限**：收进弹窗的「更多」，默认用设置里的（不是从弹窗里去掉）。
