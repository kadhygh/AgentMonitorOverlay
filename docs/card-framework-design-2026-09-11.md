# Card 整体数据框架

日期：2026-09-11。状态：本轮最小框架已实现并接入 Focus Panel；未部署到正在运行的 AMO。

## 当前增量：人工 Task groups

后续交互讨论已确认 Focus 只做人工任务梳理。新增 `amo.task-group` 组件（schema 1，`{groupId:string|null}`，最多一个），独立于 processing 源游标。Focus 不再把 pending/reviewing/later/future/handled 用作固定分类，也不做点击自动 Reviewing 或特殊 Agent 分组。下文 processing 的既有数据接口仍保留，不能据此推断当前界面分类。

CardStore 同文件新增 `groups: {groupId,name,dragOnly}[]`、`groupRevision` 和有界 `groupOperations`。组 ID 是稳定 UUID，名称和 dragOnly 可修改。注册表初始为空。`GET /api/card-groups` 返回 `{schemaVersion:1,revision,groups}`；`POST /api/card-groups/commands` 以 operationId/expectedRevision 执行 create/update/delete 批次。create/update 均包含 name 和 dragOnly。

通用 Card commands 设置分组引用时验证目标存在。删除分组与所有普通/归档 Card 引用清理在同一 writer 事务中完成，失败则整体不生效。组名变化不改变 Card 引用，运行观察不写人工分组。缺失引用呈现为“未分组”，不创建虚构分组身份。

Focus schema 2 增加 groups/groupRevision 和每卡 groupId/archivedAt；`?includeArchived=1` 供完整列表使用，读取注册表和卡片引用保持一致。隐藏组只影响面板常驻展示，不影响列表、Card 归档状态或 Session。

UI 和验证详情见 [人工分组交接](session-handoffs/2026-09-11-focus-manual-groups.md)。原有 Card snapshot 缺少分组字段时只初始化空注册表，仍不读取或迁移旧 focus-cards.json。

## 本轮采用的约定

Session 是最小运行单元。Card 是独立的工作与扩展单元，使用组件组合能力。Focus Panel 是第一个实际消费者；Canvas 的 Card 接入、需求包装与多任务聚合留待后续。

用户允许通过接口修改数据，因此核心标题、归档状态和组件数据都可以通过明确的应用命令修改；跨组件变更可在一个原子批次中完成。不能未经校验直接写持久文件，组件也不通过任意顶层字段覆盖其他模块的数据。

用户允许不做旧数据兼容。本轮直接使用新的 cards.json，不读取、迁移或删除旧 focus-cards.json。现有 SessionStore 仍是运行数据来源，这属于当前运行底座的接入，不是为旧 Focus 格式建立兼容层。

## 三层数据结构

| 层 | 对象 | 职责 |
|---|---|---|
| 运行层 | AgentSession、启动记录、窗口/会话绑定 | 真实会话、执行状态和平台事实的权威来源 |
| 工作层 | CardStore、Card、功能组件 | 稳定工作身份、人工处理、备注和组件关联 |
| 呈现层 | Focus Panel、现有 AMO 列表、未来 Canvas Card | 读取或投影工作/运行数据；布局数据不侵入 Card 核心 |

现有运行层的 flat AgentSession/Hook 接口继续承担原职责；本轮新增组件通过清晰的投影接口分开读取常规会话与 GUI/TUI 生命周期信息，没有同时重写所有旧 Hook、启动器和平台操作。

## Card 核心

```text
Card
  schemaVersion
  cardId                 独立 UUID 身份
  title
  revision
  createdAt / updatedAt
  archivedAt
  components[]
```

Card 不要求 Session。两个 Card 可以引用同一个 Session；一个 Card 可以挂多个 Session 组件。自动收纳已有会话时，有独立的默认 Session→Card 索引，避免重复创建；这个索引不限定一般 Card 的身份。显式修改 Card 标题后，后续 Session Hook 不会覆盖它。

组件统一使用 `{componentId, type, schemaVersion, data}`。componentId 在 Card 内唯一，组件有自己的格式和版本。当前每卡上限 32 个组件，未知组件按有界数据保留而不执行。

## Session 与对话承载分开

### amo.session：常规会话与运行状态组

保存 `{sessionRef:{frameworkId,sessionId}}`。通过 `projectSessionRuntime` 读取：

- 精确的会话身份、关联工程；
- 会话是否存在/归档/已从运行库移除；
- running、idle、waiting_permission 等执行状态。

这些状态由运行层提供，不在 Card 中持久化第二份可独立修改的副本。

### amo.conversation：GUI/TUI 对话承载组

保存 `{sessionComponentId}`，显式指向本卡中的 Session 组件。通过 `projectConversationRuntime` 读取：

- CLI/TUI、App/GUI，或尚未绑定；
- 受管启动、显式窗口、App thread 等绑定方式；
- 有证据的 online/offline/unknown 可用性；
- 当前是否支持返回或恢复对话。

会话 idle 不等于终端 offline，会话 running 也不证明某个窗口在线。App 显式绑定优先于残留 CLI 启动字段；App 不会获得 CLI Resume 能力。移除 conversation 组件只移除卡片的对话入口，不停止会话，也不解除真实窗口绑定。更改实际绑定沿用运行层的目标绑定接口，组件投影随后反映结果。

原生操作现在携带 cardId、Session 组件 ID 和对话组件 ID。主窗口会重新检查 Card 当前关联和真实 Session，再进入已有操作流程；旧界面上的按钮不能对已经改绑或移除的组件执行操作。

## 已实现的工作组件

| 组件 | 数据与操作 |
|---|---|
| amo.processing | 选定的源 Session 组件（可空）、人工分组、已处理版本和持久注意力信息 |
| amo.notes | 用户备注文本，通过 set-note 接口修改 |
| amo.session | 常规会话身份引用；运行信息使用独立投影 |
| amo.conversation | 对应 Session 的 GUI/TUI 承载引用；连接状态使用另一组投影 |

Focus Panel 可直接创建仅含 processing/notes 的独立卡片。它能被记录、分类和处理，但没有虚构的运行状态或 CLI 按钮。

当前每张 Card 只有一个 processing 与一个 notes 组件。processing 可以从多个 Session 组件中选择一个源；同一 Session 组件最多对应一个 conversation，避免静默猜测要打开哪个对话。多源同时确认与聚合卡的注意力规则尚未实现。

## 组件与核心修改接口

接口均以通用 CardStore 为数据权威：

| API | 功能 |
|---|---|
| GET /api/cards | 读取所有 Card，包括归档卡 |
| GET /api/cards/:cardId | 读取一张 Card 的核心与组件 |
| POST /api/cards | 创建独立 Card，components 可为空 |
| POST /api/cards/:cardId/commands | 原子执行 1～20 个有校验的修改命令 |

支持 set-title、archive、restore、set-component、remove-component、set-processing、set-note、handle。批次校验最终组件关系，因此可以在一次请求中增加 Session、conversation，再将 processing 指向该 Session；任一项无效则整批失败。

操作使用 operationId 去重和 expectedRevision 冲突检测。组件允许通过这些接口修改核心或其他组件，不需要直接操作存储。修改 source 必须显式重设 processing 组件；清掉旧源处理游标后，先观察新源，不能同批将旧源的确认应用到新源。

运行时生成的 attention/cursor 字段受保护：普通 set-component 不能伪造已处理版本。用户通过 handle 明确处理已观察到的版本。

## Focus Panel 的职责

Focus API 返回 schemaVersion 2 的视图，组合 Card 的人工数据以及相互独立的 session/conversation 投影。它不拥有第二套存储。面板选择非归档且带 processing 的 Card。

同一个 cardId 在未来其他视图中可以共享人工处理数据。隐藏面板不改变工作状态；打开 CLI 不确认处理；归档 Card 不归档真实 Session。会话移除后 Card、备注和人工记录继续存在，原生按钮禁用。

未知组件/未知版本在普通保存中保持原样。面板不执行未知组件，旧 schema-1 Focus 响应会明确报不支持，不会被误当成无会话卡。

## 存储和清理

新文件为会话数据目录旁的 `cards.json`，覆盖变量为 `AGENT_MONITOR_CARDS_DATA_FILE`。持久结构包含 Card records、默认会话卡索引、attention evidence 和操作重放记录。无旧 Focus 迁移分支；旧 Focus store 源码及重复投影已移除。

已保留的机制包括串行写入、合并观察、重复/迟到回复去重、失败退避重试、精确操作重放、损坏文件显式报错。运行时变化本身不写入 Card 快照；只有新的注意力信息等持久内容改变才更新 Card。

原生平台、运行框架别名、Card 功能组件属于不同模块。别名工具不再生成 cardId，也不再输出包含 triage 的旧 Focus 对象。

## 后续扩展

新增数据组件从 `broker/lib/card-components/registry.js` 的显式定义入手，规定格式、依赖和数量约束；界面通过对应投影/渲染组件读取。新增操作需要明确的命令实现和测试。当前是受控内置组件体系，没有动态加载任意插件代码。

后续可增加工程关联、正文、验收、需求进度、集合/Area 等组件；Canvas 自己保存 nodeId、cardId 与布局，不再另造一套工作卡真相。

执行与验证记录见 [本轮组件整理](tasks/card-components-refactor-2026-09-11.md)。当前未迁移历史 Focus 数据；真实 Windows 聚焦、窗口层级和 CLI 恢复仍需原生实测。
