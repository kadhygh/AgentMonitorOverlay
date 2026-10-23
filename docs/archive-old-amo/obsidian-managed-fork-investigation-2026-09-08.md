# Obsidian 发起受管 Fork：调查与推进建议

日期：2026-09-08。状态：方案讨论，尚未实现或部署；尚未启动真实 Fork 实验。

用户已授权后续在 `G:/PROJECT` 新建专用测试目录、部署 AMO、启动 managed CLI 并测试 Fork。本轮要求是先调查并讨论方案，因此本轮只读代码、核对本机能力并保存调查资料。后续沿用该测试授权，无需重复申请。

## 1. 产品目标与优先级调整

用户基本满意现有 Obsidian 阅读、引用和批注流程。建议以 Obsidian 为选定历史回复、引用片段和提出旁支问题的入口，AMO 负责创建、绑定、监控和恢复独立 CLI。

下一轮目标从“完整支持任意 CLI 内手动 Fork”收敛为：

1. 复现手动 Fork 与普通任务卡/managed binding 的冲突，明确保护边界。
2. 建立 AMO 主动创建分支的可靠合同：准确历史边界、独立会话、全新受管启动身份。
3. 首先将入口开放给 Obsidian；Overlay 提供状态、定位和恢复。
4. 手动 `/fork` 保留兼容与恢复路径；不能识别时显式显示关联待确认，不自动猜窗口归属。

Area/需求卡不作为这轮前置条件。来源模型保留未来挂接需求卡的空间。

## 2. 当前能力证据

### 官方协议与本机 CLI

- 本机 `codex --version` 为 **0.153.4**，与前一轮记录的 0.153.2 不同。
- `codex fork --help` 提供 session ID 和可选 prompt；帮助中未提供选择历史 turn 的参数。不能据此推断所有 TUI 历史操作都不支持分叉，本轮未实测 TUI。
- 当前官方 App Server 文档明确：`thread/fork` 的 `lastTurnId` 包含指定轮次、排除后续轮次；该轮次不能正在执行。`ephemeral: true` 是内存分支。
- 本机通过 `codex app-server generate-json-schema` 导出的 `v2/ThreadForkParams.json` 同样包含 `lastTurnId`、`ephemeral`、`excludeTurns`、`cwd`、`modelProvider`、`developerInstructions` 等字段。因此这是本机协议已声明的能力，仍需真实操作验证。
- `excludeTurns` 控制响应是否加载历史，并不表示子会话没有继承历史。

来源：[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)。本机 schema 和只读提取资料保存在忽略目录 `tmp/fork-research-20260908/`。

### 本机桌面 App：三个入口不是同一种操作

本轮检查正在运行的 `OpenAI.Codex_26.901.6511.0_x64` 安装包中本地任务界面的调用链。以下是该安装版本的静态实现证据，不是对所有 ChatGPT 云聊天版本的概括，也不是已经执行过的 UI 验收。

| 入口 | 当前本地任务界面实现 | 对 AMO 的启示 |
|---|---|---|
| Quote / Add to chat | 选区进入回复引用/输入附件路径 | 保留现有 Obsidian 批注及原任务回传，引用本身不创建分支 |
| Ask in side chat | 创建侧聊时走 Fork，传入 `ephemeral: true` 和 side conversation 指令；选区可以放入已有侧聊输入框 | Fork 底层成立，但不等于每点击一次都新建分支或自动发送；侧聊用途和创建策略应明确 |
| More details | 走 Quick Chat，自动构造解释请求，附选区、源消息和有限长度的会话 Markdown 上下文，进入 ChatGPT completion 路径 | 本轮追踪的路径没有调用 Codex `thread/fork`；不能继续把它和 Side Chat 都称为同一种 Fork |

定位记录（offset 是 UTF-8 解码后 JS 字符串索引，便于本机复查）：

- `webview/assets/app-primary-428a0a65766f.js`：约 6372k–6376k，选区菜单及回调；约 7397k–7399k，引用附件；约 7658k–7662k，`nZr`/`iZr` 将 Side Chat 与 Quick Chat 分流。
- `webview/assets/thread-pin-shortcut-bridge-f85d28ddca38.js`：`Qe`，约 2371，临时 Fork 创建；`H` 为侧聊开发者指令；`X` 提供独立侧栏生命周期。
- `webview/assets/app-initial-f87238153a19.js`：`Len`/Fork request preparation 支持指定轮次；`tRo`、`nRo`、`hRo`、`kRo` 构造 Quick Chat 上下文，`Ggi`/`qgi` 走 ChatGPT completion。上下文导出上限为 80,000 字符，源消息预算为 40,000 字符，因此也不等价于完整原生历史 Fork。

Side Chat 的创建参数没有从选区传入历史 turn 边界；不能把“点在旧文本上”直接等同于“严格截断在那条旧回复”。AMO 应把来源定位作为自己的明确合同。

## 3. AMO 当前冲突与可复用部分

- `broker/lib/launch-store.js` 的 `claim()` 固定第一次 owner。同 launch 的新 session 被分类为 `attached-child`，清除自身 launch/target binding，并沿用 owner 的 window hint。此护栏保护内部子 agent，却不足以表达用户在同一 TUI 中切换到 Fork 会话。
- `normalizePersistedLaunch()` 等恢复逻辑也优先使用原 owner；仅修改 claim 不能保证重启后的正确性。
- `broker/lib/workspace-launch.js` 当前只创建 new/resume 启动。已有终端启动、唯一标题 token、provider 配置和新 launch 环境可复用，但没有正式 Fork 业务操作。
- `broker/lib/codex-app-server.js` 当前只做短命进程重命名，不能直接视为完整会话控制服务。
- Obsidian 的 `bridge/annotation-sync.ts` 已提交 `sessionId`、`turnId`、vault/note 路径；`core/metadata.ts` 已解析 frontmatter 和 AMO 隐藏 marker。可以沿用现有面板显示文件和选区获取方式。
- 注意 `conversation-service.js` 的回复 turn ID 可退化为 `unknown-turn`，提示记录还可能使用 AMO 生成的 ID。不是所有已有笔记的 `turnId` 都能直接传给 provider。

以上是代码事实及风险定位。尚未实测并证明用户描述的全部“撞普通卡、managed CLI 失效”事件链。

## 4. 建议的 Obsidian 交互

| 操作 | 用户意图 | AMO 建议行为 |
|---|---|---|
| 引用 / 批注回原任务 | 在原任务继续沟通 | 沿用当前流程，不创建新 session |
| 详细解释 | 针对这段内容快速展开 | 默认带预设解释问题，创建可恢复的解释分支；讨论用途，首版不主动修改工程 |
| 在侧聊中提问 | 围绕原文独立追问 | 输入问题后创建分支，保留来源链接，可多轮继续 |
| 从此处创建任务分支 | 基于旧决策继续另一条工作路线 | 创建正式独立任务和 managed CLI，允许用户按任务范围执行工作 |

“详细解释”和“侧聊”在 AMO 首版可以共享持久 Fork 实现；这是为 managed CLI 可恢复性作出的产品选择，不声称复制了当前 App More Details 的底层实现。

优先从已结束的 assistant 回复笔记发起。显示来源任务、源回复时间/标题、选区和执行目录。默认历史截止到该回复所在的完整 turn；保留更早历史，排除其后的所有轮次。段落选区表达关注位置，不宣称 provider 能在一个 turn 内任意 token 处截断。Prompt 笔记、未完成回合、多回复混合选区暂不伪装为同等精度。

定位信息包括 provider、父 session ID、经校验的 provider turn ID、可用的 message/item ID、笔记路径、选区文本快照、附近文本或区间和内容摘要。显示链接使用笔记锚点；实际 Fork 使用 provider turn ID。笔记可编辑/移动时仍保留来源快照。旧笔记锚点缺失时明确提示重新选择有效回复或显式选择最新完整轮次，不能静默 fork latest。

首版每次明确“新侧聊”创建新分支；继续某条侧聊使用已有 child ID。避免 App 式自动复用导致不同旧回复的问题串到同一个分支。

## 5. 受管分支创建合同

推荐验证的路径：**Obsidian 选择回复 → Broker 校验来源并记录操作 → App Server 精确 Fork → 持久保存 child ID → 新 launch 恢复 child CLI → Hook 精确认领 → Obsidian/Overlay 显示结果。**

这里 resume 的对象是已经创建的 child，而非 parent。再次执行 fork 会额外创建一条分支，必须避免。普通命令行 `codex fork <parent>` 可用于最新历史场景的能力对照，不满足历史 turn 精度的主路径。

建议由 Broker 统一维护持久 branch 记录：branch/operation ID、kind（fork/side-chat/explain）、父子 provider ID、来源 turn/选区、workspace/provider 配置引用、关联 launch、创建阶段和失败原因。parent 来源关系不放在会被清理的 launch 记录中作为唯一副本。

每个 child 的新 launch 使用独立标题 token 和目标绑定。先记录操作意图，再进行 provider 操作；Fork 创建阶段也可能触发 Hook，必须单独核验并处理该阶段的身份，防止 CLI 启动前已被当作普通 session 处理。精确 child ID 确认前不能用第一个任意 Hook 认领；子 agent 事件不能抢占。

普通任务和侧聊可以复用同一 session 状态权威及监控组件，额外 branch 元数据控制收纳和展示。优先避免另建一套 side-chat session engine。父子分别统计权限、回复、离线和失败；Overlay 可在父卡旁收纳分支，正式 Fork 正常展示独立任务卡。

调用链关键要求：

- 同一 operation ID 重试不重复 Fork、不重复开 CLI；响应丢失后先恢复/查证创建结果，无法查证时保留 unknown 阶段，不盲目再 fork。
- 子会话已创建而终端失败时，恢复同一个 child。重启 Broker 后依然知道分支角色和来源。
- Fork 成功仅表示会话已创建；终端已启动、Hook 已绑定、首条问题已接受、产生回复分别记录，不能混为一个成功状态。
- App Server 与 CLI 的 provider、存储位置、cwd、模型及权限应一致。复用凭据路由引用，避免把凭据写入笔记或分支记录。DXX 另作兼容验证。
- 讨论/解释分支必须明确继承历史只作背景，不继续父任务中尚未完成的工作；默认讨论权限应通过实际运行配置约束，不能只靠提示词保证。
- Fork 只复制会话上下文，不恢复工程文件到历史版本。Unity 文件仍是当前真实目录的状态，正式分支的并发写入范围需要明确。

## 6. Obsidian 产物与回流

旧 2026-07-16 方案的“Overlay 入口优先、侧聊不产生 Obsidian 产物”不适合本次需求。新建议：

- Obsidian 优先入口，保持现有阅读和批注形式。
- 分支产生自己的新回复笔记，可放入独立分支目录/索引，并链接到父任务的源回复。
- 只输出分叉后新增内容；继承历史不批量复制笔记，不回填到父任务的线性会话流。
- 选定侧聊结论后，沿用现有批注/待发送提示机制回到父任务；默认不自动执行结论、不宣称已投递。
- provider 中保留完整可恢复的子会话。删除视图/收纳项不删除 provider 历史。

## 7. 下一步隔离实测矩阵（已获授权，待本轮讨论后执行）

建议新建 `G:/PROJECT/AMO-Fork-Lab-20260908`，放两个空工程及独立 Obsidian 测试 vault。独立 Broker 端口、sessions/workspaces/launches/canvas 数据和日志；测试 Hook 只向实验 Broker 上报。先核对部署脚本不会把测试注册或 Hook 写到真实工程与日常实例。CLI 辅助进程隐藏运行，需验证的交互终端保留为测试窗口。

使用仅含测试内容的 A/B/C 三轮会话，从 B 分叉到 D。以 provider 返回的历史检查父有 A/B/C、子有 A/B/D，无 C；另验证源选区和窗口绑定，不仅靠模型口头表示它“没看到 C”。任何需要对话输入的操作只发给实验 session，不发给用户现有任务。

| 场景 | 核心证据 |
|---|---|
| 原终端手动 `/fork` | 新旧 session、Hook source、事件顺序、launch 认领、Focus 是否错位 |
| 新终端 fork 且继承旧 AMO 环境 | 是否误挂父 launch，如何区分实际终端 |
| AMO 全新 launch fork | 父子两卡状态独立，各自定位对应窗口 |
| App Server 指定 B 创建持久 child，再 managed resume | 精确历史、进程退出后持久化、CLI 可继续、源父会话不变 |
| 父会话正在 C 执行，从已完成 B 分叉 | B 边界是否稳定；不会在源父任务上回滚或中断 |
| Fork/RPC 创建阶段与 resume 的 Hook | 首个事件、重复 SessionStart、内部子会话不会误认领或污染笔记 |
| 内部 subagent、迟到父事件、Broker/CLI 重启 | 不抢绑定、不倒退来源/角色、重启后可恢复 |
| Obsidian 旧回复、编辑后的笔记、缺失 turn ID | 明确定位或明确报错；Quote 回原任务行为保持 |
| 双击、请求超时、child 创建后终端失败 | 不重复分支；能恢复同一 child，不假报成功 |
| 新增分支回复及结论回流 | 不复制继承笔记、不混进父线性记录、回传目标正确 |

先验证 Codex 默认 provider；DXX 如可用则使用独立实验配置检查相同协议、配置与 Hook 语义。Claude/Grok 暂不承诺 Fork 能力。

## 8. 建议交付顺序

1. 隔离实验与证据：明确冲突、历史精度、持久 Fork → managed resume 的可行性；产出支持矩阵。
2. 受管 Fork 服务：持久来源、可恢复创建流程、新 launch、精确认领；补手动 Fork 的最低限度兼容与显式恢复。
3. Obsidian 首个完整入口：从一条已结束回复发起侧聊，独立 CLI 和新回复笔记，可返回源回复及父任务。
4. 基于相同合同补详细解释和正式 Fork 的用途差异，然后回到 Area/需求卡。

尚待实验证据的关键项：同版本 App Server 的实际历史截断与落盘；短命创建进程退出后 CLI 的恢复；Fork/Resume Hook 的 session/turn/source 及首条问题的可靠提交；DXX/provider 配置是否一致。若这些不满足，再评估长期受管 App Server/TUI 连接；不直接把临时 App Fork 当成可重开的 CLI 会话。
