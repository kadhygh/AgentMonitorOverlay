# Focus Panel：人工 Task groups 交接

日期：2026-09-11。基线：`90808f8`。开发分支：`codex/focus-manual-groups`。

开发 worktree：`G:/PROJECT/AgentMonitorOverlay/tmp/worktrees/focus-manual-groups`。实现提交 `26bb27d`，已在用户明确确认“合入”后快进合入本地 master，并于 2026-09-11 15:13（香港时间）完成生产 Source 重启。未 push。

## 用户确认的范围

先使用无 Session 的测试 Card，跑通基础操作，再接入真实会话。用户通过两轮交互原型确认：

- Focus 面板透明底，每个自定义 Task group 一横行，卡片只显示标题。
- 分组有独立稳定 ID；改名不改归属；删除分组清除所有卡片引用，卡片和备注保留。
- 分组设置有“仅拖拽时显示”：平时整组隐藏，拖拽时只露出组名和投放区域，允许投放；结束或取消后隐藏。
- 新建卡片旁有“全部分组”列表，包含隐藏组和归档 Card，可打开详情并手动换组。
- 点击卡片弹出详情，复用现有 AMO TaskCard 的会话内容和操作。
- 不提供 Agent 特殊分组或点击后自动 Reviewing。不用 pending/in progress 等固定状态决定分组；运行事件、回复、打开详情不会替用户换组。
- 保留原 CLI 完整讨论与审核，不做自动派发、内嵌聊天或 Canvas/Area 扩展。

## 已实现

### 数据与接口

CardStore 的同一个 `cards.json` 中新增 `groups`、`groupRevision`、`groupOperations`。分组为 `{groupId,name,dragOnly}`，ID 是 `group-<UUID>`；初始注册表为空，不预设不可变分类。最多 128 组。

新组件 `amo.task-group`，schema 1，data `{groupId:string|null}`，每 Card 最多一个。分组归属与 `amo.processing` 的既有状态/源游标分开。当前 Focus 使用分组组件做人工分类，不执行 processing 自动流转作为分组规则。

`GET /api/card-groups` 返回 `{schemaVersion:1,revision,groups}`。

`POST /api/card-groups/commands` 接受 `{operationId,expectedRevision,commands}`，命令为 `create {name,dragOnly}`、`update {groupId,name,dragOnly}`、`delete {groupId}`。使用冲突检测及有界精确重放。

创建/修改 Card 归属沿用通用 Card commands。任何引用必须指向现存分组。分组删除与普通/归档 Card 引用清理通过同一次原子持久化完成；失败时都不改变。不会停止、归档或解除真实 Session。

Focus 保留 schema 2，添加 `groups` / `groupRevision` 和每卡 `groupId` / `archivedAt`。`?includeArchived=1` 为全部分组列表提供归档 Card；默认仍排除归档 Card。分组和卡片引用在同一个串行读取中投影。

旧 Card snapshot 缺少全部三个分组字段时，仅初始化为空注册表；不读取、迁移或删除 `focus-cards.json`。未知组件仍保留。

### 面板与详情

新建、设置和详情有对话框；标题卡可以拖拽或右键移动。组内顺序按创建时间稳定排列，不因运行更新而跳动。设置可新增、改名、改变 dragOnly、删除。无归属卡显示在“未分组”。Card 归档/恢复在详情中提供；有未保存编辑时先保存或明确采用最新内容。

详情标题、备注与分组使用通用 Card 原子命令保存。隐藏窗口或关闭详情保留内存草稿；应用完全退出前需保存。网络结果不明确时保留原 operationId 重试；并发变化显示最新内容，需要用户明确选择，不能静默覆盖。

Session 详情复用 `TaskCard`，显示真实 Session 资料、消息、事件及原有动作。所有原生命令通过主窗口 owner 委托，重新核对 Card、Session、组件引用。移除/改绑后旧按钮拒绝操作；归档 Card 禁用 Session 操作；多 Session 中其他 conversation 不阻塞选定源的纯 Session 动作。

窗口绑定拖拽不能从一个 WebView 传到另一个，使用明确的“Bind in AMO…”返回主窗口，再由用户拖动原 crosshair。Card 归档与 Session 归档按钮分开。委托回执不冒充真实聚焦/启动成功。

原有 Session 级 Seen/打开目标等历史行为仍属于 AMO 会话层，未全局重写；不会确认 Card processing 或改变分组。

Focus 原生创建选项改为透明、无窗口阴影；关闭原生文件拖放 handler (`dragDropEnabled:false`)，让 Windows WebView2 的 HTML5 卡片拖拽工作。默认大小 680×540，最小 360×440。未实现透明区域鼠标穿透。

## 验证边界

- **自动数据验证**：最终 Broker 215 项通过。隔离 `LOCALAPPDATA` 放在 worktree/tmp，未写生产数据。
- **前端与原生命令模拟**：最终运行时测试 **112/112** 通过，`npm run build` 通过；窗口属性及委托路由用模拟端口验证。构建日志在本 worktree 的 `tmp/manual-groups-build.log`，测试日志在 `tmp/manual-groups-runtime-tests.log`。
- **真实 UI + 临时 Broker**：新版 `scripts/performance/focus-panel-smoke.cjs` 使用空 Session 和隔离数据，验证分组、新建独立卡、真实浏览器鼠标拖拽、隐藏/列表、稳定改名、删除引用、归档、备注冲突、失响应重放、隐藏轮询与真实 Broker 进程重启；截图人工检查。
- **已原生实测**：部署后通过生产 AMO 的真实开关打开 Focus；截图确认卡片之间直接透出下层窗口，新版列表/设置/创建控件存在，旧 Pending/In progress 分类不存在。通过 Windows UI Automation 验证关闭同步主开关为 Off、重开为 On、分组设置可打开并关闭。未创建或修改生产卡片。
- **未实测**：完整窗口层级/焦点场景、原生窗口拖动缩放和卡片拖拽、对 CLI/Unity 的影响、真实 CLI/App 返回/恢复。浏览器鼠标拖拽与窗口端口模拟不能替代这些验证。
- 本轮无 Rust 源码或依赖变更；此前 `cargo check --offline` 属于基线证据，不列为本轮新实测。

真实 UI smoke 最终产物：`tmp/focus-manual-smoke-IpSX3E/`，`result.json` 中页面错误为空。覆盖实际浏览器鼠标拖拽、右键移组、归档恢复、数据冲突与进程重启。该目录属于忽略的本地产物，不随源码提交。

复用 TaskCard 的详情另做了合成会话视觉检查：680px 与 360px，全部 HTTP 请求拦截，不连接任何真实 Session。修复紧凑图标被通用按钮 padding 挤压、窄窗顶部动作覆盖标题的问题；会话动作拥有独立顶部区域，标题和正文可换行。产物为 `tmp/focus-session-visual-qa/`，页面错误为空、无横向溢出。它只证明布局，不证明真实会话动作已经执行成功。

`scripts/performance/focus-panel-preview.cjs --check` 通过空数据启动、同源代理、拒绝 Session 动作、拒绝跨域请求检查。实际浏览器验证设置弹窗、模拟显示/隐藏与主题，页面错误为空。

本轮留下的隔离预览：`http://127.0.0.1:3199/`，数据在 `tmp/focus-manual-preview-4t9LKM/`；初始 Card、group、Session 全为空，用户可手动创建。预览使用真实 UI 与临时 CardStore，原生接口模拟且禁止外部动作。服务退出后 URL 不再可用，数据文件保留；runner 下次启动会创建新的临时数据目录。预览数据未导入生产。

生产部署前 JSON 备份：主目录 `tmp/production-backup-20260911-151222/`；同时保存四项既有未提交文件的 SHA256，合入后校验一致。生产 Session 数据仍为主目录 `broker/data/sessions.json`，142 个 Session 和142张 Card 保留，分组注册表为空（revision 0），所有卡片呈现为未分组。

原生检查产物在主目录 `tmp/native-focus-deployment-20260911/`，包含 `focus-native.png`、`window-bounds.json`、`native-controls.json`。检查时原生 PID 为 32572，窗口标题 AMO Focus Panel，尺寸680×540。PID仅为当时证据，不应作后续操作依据。

## 后续工作

继续让用户完整审核交互，并补齐上述原生验证缺口。真实 Session 动作验证仍不自动发送 CLI 消息或启动任务。不要自动扩展 Canvas、Area、秘书能力或分类自动化。

生产运行状态在接手时已经不一致：主目录存在 Tauri dev/Vite，原生 exe 启动于 11:39:55，Broker 仍是 9 月 10 日 21:39:25 的进程，旧 Broker `/api/focus-panel` 返回 404。以后不能仅看 master HEAD 判断实机版本；部署前再次只读核对。

主目录四项已有未提交内容原样保留：两份规划文档、`overlay/src-tauri/Cargo.toml`、未跟踪的 Obsidian 调研文档。不要混入本轮。
