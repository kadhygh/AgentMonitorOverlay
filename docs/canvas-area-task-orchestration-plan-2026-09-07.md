# Canvas、Area、需求卡与会话协作推进计划

2026-09-08 方向补充：用户希望优先从 Obsidian 发起可定位历史来源的受管 Fork，并减少 CLI 内手动分叉。见 [Obsidian 受管 Fork 调查与建议](obsidian-managed-fork-investigation-2026-09-08.md)。下一轮建议先完成隔离实测及受管 Fork 基础，再接 Obsidian 入口；本文的 Area/需求卡模型保留为后续工作。

日期：2026-09-07。
状态：分析与建议，等待后续产品讨论；本轮没有实现这里的新功能。
基础：当前工作区已有 Task Canvas 第一轮实现，见 [执行记录](tasks/task-canvas-foundation-2026-09-07.md)。

## 1. 已明确的工作方式

- 一个 Canvas 可以跨多个真实 project 文件夹；未来可以有独立 Canvas，但第一版不做多看板切换、分页或标签页。
- Project Mining 是一个业务范围，可以包含三个独立 Unity 工程目录。新需求分别在这些目录推进，完成后由用户验证；不要求创建 Git worktree。
- 每个工程通常有一个运行任务，也允许同时有两三个。Area 应能清楚展示各工程正在进行的任务，且可保存自身的说明、注释和上下文。
- 看板卡片可以是现有 AMO 单会话卡，也可以是承载一个需求、挂接多个真实执行任务的包装。
- 当前监控混乱主要来自已有 Codex CLI 窗口内执行 `/fork`。另开终端 Fork 的实际表现尚未确认。
- 希望增加 Side Chat：围绕原任务补充讨论，同时能与原任务保持关系；希望 AI 主控可通过 CLI 规划、派发和交流。

本轮的复杂度/风险评级继续用于工程任务拆分，不自动变成 Canvas 产品中的 AI 评分功能。

## 2. 产品模型建议

| 对象 | 主要职责 | 自有数据 | 与其他对象的关系 |
|---|---|---|---|
| Canvas | 保存一张工作视图 | 标题、说明、节点位置、连线、视图状态 | 引用 Area、需求卡和直接会话卡；先只有 default |
| Area | 业务范围，例如 Project Mining | 标题、说明、Markdown 上下文、注释、关联工程、常用链接 | 包含需求卡，关联零到多个 Workspace |
| Workspace | 真实执行目录 | 复用现有 workspaceId、路径、别名、部署状态 | 一个工程可以运行多个会话；不会因 Area 而复制工作区 |
| 需求卡 WorkItem | 稳定的需求/工作目标 | 标题、需求正文、验收项、业务状态、注释、负责人、工程关联 | 可以尚无会话，也可以挂接多个执行会话 |
| Session / Execution | 实际正在运行的 CLI 会话 | 复用当前 AgentSession 状态；额外保存明确的需求关联、角色和分叉关系 | 提供运行、权限、产物和窗口定位状态 |
| CanvasNode | 对象在图上的一次呈现 | nodeId、对象引用、位置、尺寸、折叠状态 | 删除这次呈现不删除其业务对象或底层会话 |

界面可以称 WorkItem 为“需求卡”或“任务”，开发与 CLI 必须清楚区分它和现有 session。建议 CLI `amo task` 操作需求卡，`amo session` 操作真实会话，避免一个 taskId 同时表示两种身份。

建议先做到“一个需求挂多个执行会话”，不同时引入任意深度的需求树、工作流引擎和自定义卡片插件。真正出现多层子需求时，再增加明确的子需求关系。

现有 TaskCard 继续负责单会话的展示与操作。新增需求容器负责标题、验收、聚合状态和展开/折叠；展开后复用单会话展示及应用命令，不复制主窗口的后台监控或重新实现一套 Focus/Resume 规则。第一步只抽出这轮确实需要的共享展示/命令，不把全面重构设成前置条件。

### Project Mining 的具体呈现

一个 Project Mining Area 中，顶部显示范围说明、共享约定和运行汇总；内部按真实工程分成三个工程栏。每栏列出相关需求和会话，显示目录别名、路径提示、运行/等待/待验证数量。同一需求跨两个工程时，只有一个业务身份，可以在另一个工程栏显示引用或工程徽标；汇总按唯一身份计数。

例如三项需求分别指派给工程 A、B、C；需求 B 挂了一个实现会话和一个审阅会话。Area 应显示“三项需求、四个执行会话”，并能看到工程 B 同时有两个会话。它不应显示成四个已完成或未完成的业务需求。

工程栏是 Workspace 关联的视图，不必为每个目录再建一种特殊 Area。后续若用户希望手工划出专题 Area，可以沿用同一模型。

Area 的边界需要支持移动、缩放、折叠和拖入/移出。成员归属由显式 areaId/命令决定，不能仅靠卡片是否落在矩形里判断。整体拖动不改变 workspacePath、会话绑定或执行权限。第一版不做嵌套 Area。

### 上下文与注释

Area 的共享约定、需求卡的验收说明、评论是各自的持久数据。第一版建议普通 Markdown 正文，加 `{id, author, createdAt, body}` 形式的评论；先不做复杂富文本和逐句批注。

启动/派发时按需提供“Area 上下文 + 需求卡正文 + 指定任务范围 + 验收要求”，记录采用的版本。用户或 AI 后续改 Area 说明，不应默默改变正在执行的任务合同；需要另发更新消息。不要自动拼入同 Area 所有会话的完整历史。

### 需求状态和会话状态分开

- 业务状态建议：`planned → in_progress → ready_for_validation → done`，另有 `blocked / cancelled`。
- 会话的 `idle/running/waiting_permission/offline/failed` 保留原含义。一个回复结束不表示需求完成；窗口关闭也不表示需求失败。
- 卡片汇总展示运行数、权限等待数、阻塞数、待审阅数，并标出具体会话。多个引用按唯一 session 去重。
- Agent 可以提交“实现结束/建议待验证”及产物、测试证据；用户完成 Unity 验证后确认 `done`。存在人工确认记录时，后续迟到的会话事件不能把它改回去。
- 没有会话的需求也能规划、注释和排列；多个会话全部离线时，需求及其验收资料继续存在。

## 3. 当前实现与差距

| 现状 | 对后续的影响 |
|---|---|
| 当前 CanvasNode 只有 task/note，task 直接引用 sessionId | 保留简单会话卡，增加 area/work-item 呈现与稳定业务对象 |
| Canvas 接口提交整份 document，使用 expectedRevision 和 operationId | 适合初版手工 Save；AI 与人同时编辑时应增加小粒度业务命令，避免一次移动覆盖整个计划 |
| WorkspaceRegistry 已有 workspaceId/path/label | 复用真实工程，显式把多个目录关联到 Area，不按目录名或 Git 远程自动合并 |
| launchWorkspace 仅按有无 resumeSessionId 选择 new/resume | 没有独立 Fork/Side Chat 的启动合同 |
| launchStore 固定第一次认领的 session 为 owner | 缺少原终端切换当前会话的表达，也缺少与内部 subagent 的区分 |
| codex-app-server.js 是启动一次进程完成重命名的适配器 | 不能直接当作已有 CLI 会话的持续控制连接 |

代码入口：`broker/lib/task-canvas-store.js`、`broker/routes/task-canvas.js`、`overlay/src/windows/CanvasWorkbenchApp.tsx`、`broker/lib/workspace-registry.js`、`broker/lib/workspace-launch.js`、`broker/lib/launch-store.js`、`broker/hooks/codex.js`、`broker/lib/codex-app-server.js`。

## 4. Fork：先修身份与路由，再做入口

### 已验证的代码事实

`launchStore.claim()` 对同一 launch 中的不同 sessionId 一律归类为 `attached-child`，清掉新的 launchId/targetBinding，设置 routeOwnerSessionId，并使用父会话的 windowHint。已有测试明确保护“首次 owner 不被后来会话抢占”；启动加载时也会把历史的被转移绑定修复回首次 owner。

本轮用实际 createLaunchStore 做了隔离探针：同一个已认领 launch，传入新的 sessionId；无论 hookParentPid 与父会话相同还是不同，即使传入 `sessionStartSource: fork`，均得到 attached-child，并沿用父窗口。探针位于忽略目录 `tmp/canvas-planning-fork-probe.cjs`。

这是可复现的路由分类局限，**尚不是用户那次真实 `/fork` 的完整根因复现**。真实 CLI 是否发 SessionStart、source 的具体值、事件顺序，以及多个 TUI 是否共享 provider 后台进程，必须另采样。`process.ppid` 目前只是 hook 父进程，不能未经验证就当作可唯一识别终端的 runtimeId。

### 身份应拆开的部分

1. `parentSessionId / forkedFromSessionId`：对话来源关系，持久保存，不因窗口切换改变。
2. `launchId`：一次受管启动的来源记录。
3. `runtimeAttachmentId + foregroundSessionId + bindingRevision`：具体可定位交互终端当前承载哪个会话。
4. `workItemId + role`：该会话参与哪个需求、承担实现/审阅/Side Chat 等哪种职责。

首次启动 owner 可以保留为来源信息，但不能永远等同于终端当前显示的会话。来源关系也不能只存 launch.sourceCardSessionId：终止的启动记录有清理周期。

### 必须分别覆盖的行为

| 场景 | 目标行为 |
|---|---|
| 原终端 `/fork` 后切换到新会话 | 新会话独立状态和持久来源；终端当前会话切换，父会话不再宣称它是自己的当前交互目标 |
| 新终端 `codex fork` 且继承旧 AMO 环境 | 经来源/终端证据确认后独立关联新终端；不因继承旧 launchId 就跳回父窗口 |
| AMO 主动 Fork | 先建立明确的 Fork operation 和新 launch，再认领新 provider 会话 |
| CLI 内部 subagent / memory 子会话 | 保持当前防抢占保护，不将其认作用户切换了终端会话 |
| 新会话出现后又收到旧会话迟到 Hook | 不回退 foregroundSessionId/bindingRevision |
| 后台进程共享、证据不足或恢复失败 | 显示关联待确认/不可直接定位，不伪造可信窗口绑定；可提供显式关联命令 |

不能简单改成“最后一次收到 Hook 的 session 拥有窗口”，也不能仅用 source 或 PID 相同作为自动转移依据。优先验证 provider 的显式线程/前台绑定事件；不够时补 AMO 发起的切换合同或可见的人工关联入口。

修复必须覆盖 claim、启动恢复/normalizePersistedLaunch、窗口探测、Focus、重启和迟到事件；只改 claim 会在下次重启时被旧恢复逻辑改回去。

## 5. Side Chat：独立会话，作为需求的附属讨论

建议 Side Chat 挂到原需求卡下，保存 parentSessionId、来源回合（能可靠取得时）、问题、childSessionId、状态和摘要。它使用真实独立会话；折叠后不增加主画布节点噪声，权限/失败/新回复仍有可发现的提示。

Side Chat 来源关系和视觉收纳分开：它不应因挂在父卡下而混用父窗口、父会话状态或父 sessionId。正式 Fork 和 Side Chat 可以共用可靠的分叉底层，但 role 和展示策略不同。

第一版的可交付闭环：创建 Side Chat → 继续阅读/提问 → 将选中的结论发回主任务 → 用户需要时“提升为正式需求”。提升保留 provider 会话及来源关系，创建或关联 WorkItem，不复制一遍 transcript，也不重新计入所有历史回复。

建议先提供专属受管 CLI 窗口，保证用户可随时查看和继续交互；后续再评估 Canvas 内嵌聊天面板。不能为了模仿内嵌外观而把多会话塞进无法可靠区分的同一窗口。父会话执行中的分叉边界也需要明确：优先选完整已完成回合，避免复制半段未完成工作。

旧 [Managed Side Fork Plan](managed-side-fork-plan.md) 保留为调查资料。其中“隐藏普通卡、抑制 Obsidian 产物”等规则针对旧版 Side Chat，不能直接套给所有正式 Fork。新普通 Fork 应正常监控；Side Chat 是否产生 Obsidian 产物单独配置，不追溯批量补写。

## 6. AI CLI：规划、派发、投递是三个不同层级

### 先提供所有对象的规划接口

CLI 和 UI 都调用 Broker 应用命令，不直接改 JSON 文件。第一版可先用 Node CLI 封装，不必打包新原生二进制。

以下是**建议命令，不是当前已经可执行的功能**：

```text
amo canvas inspect default --json
amo area create --input area.json --json
amo area comment <area-id> --body-file comment.md
amo task create --input requirement.json --json
amo task bind-session <task-id> --session <session-id> --role implementation
amo task inspect <task-id> --json
amo canvas move-node <node-id> --x 120 --y 80 --expected-revision <rev>
amo session inspect <session-id> --json
amo events wait --after <cursor> --timeout 30 --json
```

业务字段和坐标分别更新，返回明确 schemaVersion、对象版本、operationId 和结构化错误。批量命令限量且全有或全无；冲突返回相关当前版本，不静默重试旧状态。CLI 默认做增量操作，不上传覆盖完整画布。已有手工 Save 在切换小粒度模型前保留明确兼容策略。

### 再提供执行合同与投递

```text
amo task dispatch <task-id> --workspace <workspace-id> --input assignment.json --json
amo task message <task-id> --to-session <session-id> --body-file message.md --json
amo inbox read --session <session-id> --after <cursor> --json
amo task report <task-id> --input result.json --json
amo session fork <session-id> --task <task-id> --json
amo side-chat create --parent-session <session-id> --body-file question.md --json
amo side-chat promote <side-id> --json
```

assignment 至少带需求、目标 Workspace、父需求/主控关联、角色、范围、禁止修改范围、验收项、模型/推理配置（用户指定时）、并发约定和回复对象。创建一次业务需求、一次执行指派和一次 provider 会话是不同操作；CLI 重试不能重复派发三份工作。

主控与子任务通过 Broker 持久消息通道交流。消息包括 messageId、correlationId、来源身份、目标执行会话、正文和投递状态；消息可以指向需求，但实际投递前必须解析到明确的接收会话，多个执行会话时不得猜默认接收者。

“已记录”“已提交给 provider”“接收方已确认”“已回复”分别显示；普通 CLI 返回成功不能冒充 Agent 已阅读，Agent 的回复也不能冒充用户已验收。子任务用结构化 report 提供修改文件、测试、结果摘要、阻塞和待用户验证项，主控可轮询/等待增量事件决定下一步。

离线或正忙的目标使用明确的等待/排队状态。网络或 provider 响应丢失时，不能宣称端到端恰好一次投递：先按 messageId/turnId 查证，无法查证则保留 unknown，禁止盲目自动重送并触发第二轮执行。派发的操作记录应保留到执行结束，不能依赖现有画布的短期重放缓存。

### 本机能力核对和建议选型

本机只执行了 `--version`/`--help`，读到 Codex CLI **0.153.2**：

- `codex fork [OPTIONS] [SESSION_ID] [PROMPT]` 存在。
- `codex queue --thread <THREAD> --message <TEXT>` 存在，帮助说明可向已有会话排队消息。
- `codex agents` 帮助说明可浏览共享本地 app-server daemon 上的会话。

这些帮助信息不证明 queue 对当前部署的交互式会话必然可用、不证明能自动唤醒离线会话，也没有建立投递回执或重试语义。本轮未调用真实 queue/fork，未发送任何消息。

官方文档提供 `thread/fork`、`thread/read`、`turn/start`、`turn/steer` 等协议；steer 要匹配当前 turn，并且不创建新的 turn。它们适合做程序化会话控制的候选能力，但需要连到拥有该会话的运行端，不能默认新启动的短命 app-server 能控制任意已有 TUI。[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)

建议做一个有明确退出条件的 transport spike：先验证本机 queue 能否对同一现有 TUI 正确投递、是否保留现有权限/模型/cwd、空闲/运行/离线时如何处理、能否识别消息和结果。若不满足，再评估受管 app-server + TUI attach 的模式，并把新受管会话和旧 Hook-only 会话分别声明能力。

不要直接承诺所有 provider 都支持 send/fork。统一能力表至少区分 observe、launch、resume、fork、queue、steer、readResult、attachTui；Codex 先验证，Claude/Grok 按实际适配能力扩展。暂不支持直接投递的会话可以显式保留人工 copy+focus 流程，但不能标成自动派发完成。

### AI 权限与真实工程并发

规划写入、启动/分叉、消息投递、接受验收分别授权。首版不对接公网；本地调用也需要明确的可撤销 client/session 凭据与 Area/Workspace/操作范围，不能只依赖 loopback、Origin 或请求里自称的 senderSessionId。主控的管理权限不应随环境变量无差别继承给所有子任务。

AI CLI 规划的 read/write 权限先随规划接口一起落地；执行权限随 dispatch/send 一起落地。默认遵循用户选择的真实目录，不强制 worktree、不自动合并。

按 Workspace 显示当前执行占用。建议新受管派发默认同目录一个写入者，可显式允许多个不相交范围的写入任务或只读审阅；这不是对现有外部 CLI 的强制锁，也不能保证尚未接入系统的程序不修改文件。不同工程可并行；Unity 验证、导表等共享资源可作为后续显式占用项。需要清晰展示“两个任务正在同一目录写入”，而非从“同属 Area”推断它们已经隔离。

## 7. 分阶段交付与依赖

| 批次 | 可交付成果 | 复杂度 / 风险 | 核心验收 |
|---|---|---|---|
| P0 身份与通信调查 | `/fork`真实事件样本、前台绑定合同、queue/app-server 能力矩阵 | 高 / 高 | 区分原窗口切换、另开窗口、内部子会话；记录能力未知项，不改真实任务 |
| P1 业务模型 + Area/需求卡 + 规划 CLI | 单 Canvas，Area 关联多个工程，需求正文/注释/验收，多会话包装，AI 可创建/更新计划 | 高 / 中高 | 三工程三需求、一个需求两会话、无会话需求、去重汇总、人工验证状态、人机并发编辑与迁移 |
| P2 Fork 监控修复 | 可审计的前台会话切换、独立分叉来源、可靠新窗口认领 | 高 / 高 | `/fork`前后两卡不串状态，Focus 正确，内部子会话不抢占，迟到 Hook/重启不回退 |
| P3 Side Chat | 创建、独立监控、折叠、结论发回入口、提升正式需求 | 中高 / 高 | 父会话保持独立，权限提示可达，来源保留，提升不复制/污染历史 |
| P4 主控与子任务闭环 | 有权限约束的 dispatch/message/inbox/report，至少一个 provider 完整投递 | 高 / 高 | 可验证的派发/投递状态、重复请求不重开任务、结果可回收、用户验证闭环、离线恢复 |

建议下一轮的主要产品交付是 **P1**，同时推进 **P0 的小范围实测**。不要等做完所有执行控制才交付 Area，也不要在 Fork 身份尚不可靠时就把自动派发开放给真实工程。

规划 CLI 的基础命令合同需要先冻结，再把 P1 拆成后端业务模型/命令、Area 与需求卡 UI、CLI 封装三路并发；UI 和 CLI 共用同一应用命令。P0 可以作为独立调查并行。P2 必须消费 P0 的事件证据；P3 依赖 P2 的身份与持久来源；P4 依赖 P1 命令基础以及 P0 选定并验证的投递通道。

P3 可以先交付 Side Chat 的独立窗口和监控；若 P4 消息通道未就绪，“发回主任务”应显示为人工确认/复制，而不是宣称自动投递。

继续使用执行前复杂度/风险评级、完成后证据评级；模型和 reasoning 配置由每轮用户授权确定。上一轮三路 Astra medium 的结果可以参考，但不把风险高的身份/投递模块因文件少而评为简单任务。

## 8. 迁移、数据一致性与范围控制

- 当前 v1 task/note 节点、nodeId、边和位置必须保留。先允许直接会话卡继续存在，用户通过“包装为需求”创建 WorkItem；不根据同名标题或同一目录自动合并需求。
- 第一版业务实体和单看板布局可放在同一个版本化 Broker 存储边界，避免立即增加跨文件事务。需求正文/状态与布局语义分开，即使初版物理上同文件，也不得写回运行时派生状态。
- 从 schema v1 到 v2 显式迁移、先备份、失败保留旧数据；旧程序读取新 schema 应报不支持，不能按损坏数据重置。
- UI 和 AI 都以小粒度命令表达变更，同一对象按版本冲突，不相关位置变动不覆盖需求正文。跨对象的包装/关联操作原子提交。
- 删除 Area 默认移除收纳关系/视图，不删除需求或真实会话；删除视图节点与归档业务需求是不同命令。变更执行目录必须显式重派发，不因拖卡而发生。
- 评论需要记录作者和时间；agent 自报结果与用户验收记录分别留存。运行状态和需求状态各有唯一权威，不能由不同窗口争写。

## 9. 本轮结论与尚待补充

建议确认的默认方向：单 Canvas；有数据的 Area；跨真实工程；稳定需求卡包装多个会话；业务状态与执行状态分离；Fork 前台绑定独立于父子来源；Side Chat 独立身份；AI 规划接口先行，自动投递依能力逐步开放。

仍需实际证据的是原窗口 `/fork` 的具体事件和窗口行为、queue 的真实投递语义，以及未知关联场景的恢复方式。Side Chat 的最终内嵌交互、正文呈现和 Obsidian 产物策略可在 P3 前继续补充，不应阻塞 Area 与需求模型。

本轮仅新增计划、补充旧文档导航并运行临时隔离分类探针；未改动上一轮 Canvas 实现、未创建真实 Fork、未派发真实任务、未修改真实工程。
