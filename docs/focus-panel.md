# Focus Panel

Focus Panel 是独立的悬浮任务梳理面板。Open Canvas 旁的开关控制显示/隐藏；面板关闭会同步开关。当前版本由用户手动安排 Task groups，不再使用固定 pending / in progress 等分类，也没有 Agent 专用规则或点击自动 Reviewing。

## 日常操作

- **新建卡片**：填写标题、备注和可选分组；不需要 Session，不会启动任务。
- **分组设置**：新增、改名、删除自己的 Task group。名称可变，ID 保持不变。每组可设置“仅拖拽时显示”。初始没有预设组。
- **横向分组**：常驻组一组一行，卡片仅显示标题。拖拽或右键选择分组；卡片更新不会自动移组或重排。
- **仅拖拽时显示**：平时整组隐藏，拖动卡片时显示组名和投放区域；放入或取消拖拽后隐藏。隐藏不删除任何数据。
- **全部分组**：新建旁的列表按钮列出所有组和卡片，包括隐藏组、归档 Card。可以打开详情、手动换组或恢复 Card。
- **详情**：点击只打开详情。修改标题、Task group、工作备注后点击“保存卡片”；Session 卡另外复用 AMO 的会话卡内容和动作。
- **归档 Card / 恢复 Card**：只作用于工作卡。详情内的 Session 归档是另一动作；任何动作都不代表停止底层执行。

删除分组会原子地清除所有卡片的该分组引用，连同归档卡一起处理。卡片和备注保留在“未分组”。“未分组”是无引用的展示位置，没有可删除的分组 ID。

## 保存与冲突

隐藏面板或关闭详情保留内存草稿，只有保存的内容能跨应用退出恢复。新建草稿、详情草稿和未确认的请求保持各自状态。保存结果不明确时使用原请求重试，避免重复创建或重复执行。

另一窗口、分组删除或其他 Card 命令造成版本冲突时，显示最新内容并保留草稿。明确选择“保留草稿并使用最新版本”或“使用最新保存内容”后继续。分组已删除时需要重新选择有效分组，不能复活旧引用。

## Card 与组件

Card 有独立 UUID。CardStore 的 `cards.json` 是工作数据来源。当前内置组件：

| 组件 | 职责 |
|---|---|
| `amo.session` | 真实会话引用；运行层提供执行状态与工程资料 |
| `amo.conversation` | 指向 Session 组件，提供 GUI/TUI 承载、绑定与可用性 |
| `amo.processing` | 保留源注意力与已处理游标；Focus 不再用它的状态字段做人工分组 |
| `amo.notes` | 工作备注 |
| `amo.task-group` | `{groupId:string|null}` 人工分组引用；每 Card 最多一个 |

分组注册表与 Card 在同一文件、同一串行 writer 内保存。分组更新接口有独立 revision 和精确重放记录。多个 Broker 不能同时写同一文件。

`GET /api/focus-panel?includeArchived=1` 提供分组、分组 revision、Card 视图以及归档卡。`GET /api/card-groups` 和 `POST /api/card-groups/commands` 管理分组；Card 归属、标题、备注、归档沿用通用 Card commands。详见 [Card 框架](card-framework-design-2026-09-11.md) 和 [本轮交接](session-handoffs/2026-09-11-focus-manual-groups.md)。

## 返回会话

有关联 Session 时，详情复用已有 AMO TaskCard。Note、Canvas、VS Code、Seen、返回目标、目标选择、恢复、工程工具等沿用主窗口命令 owner。原生命令发送前重新读取当前 Card、Session 与组件引用，拒绝归档或改绑后的旧按钮。

跨窗口无法传递鼠标绑定手势，因此“Bind in AMO…”会定位主窗口的对应 Session，再由用户操作原绑定按钮。回执只表示委托，目标聚焦和启动结果以主窗口反馈为准。无 Session 卡不显示虚构状态和会话动作。

旧 Session 层的自动 Seen 行为没有全局重写，但不确认 Card processing、不改变人工分组。

## 隔离预览与验证

仓库根目录运行 `node scripts/performance/focus-panel-preview.cjs`，会启动真实 Focus UI 和空 Session 的临时 Broker，输出本地 URL 与数据目录。预览的数据保存在自己的 `tmp/focus-manual-preview-*` 中，与生产数据隔离。浏览器只允许预览数据接口，原生动作禁用；顶部预览控制模拟显隐和主题。Ctrl+C 停止预览及它自己的 Broker。`--check` 执行边界检查并退出。

`node scripts/performance/focus-panel-smoke.cjs` 使用临时空 Session Broker 与真实 UI，覆盖拖拽、设置、全部列表、独立卡、冲突、重放与重启。需要已有 Playwright 时设置 `AMO_PLAYWRIGHT_MODULE`。窗口 API 为模拟端口。

Focus 的原生选项为透明、无窗口阴影，关闭 Windows 原生文件拖放拦截以支持 HTML5 拖拽。`26bb27d` 已在 2026-09-11 经用户确认合入本地 master 并部署。真实 Windows 窗口中已确认透明背景、新版控件、关闭与主开关同步、重新显示及分组设置弹窗。**窗口层级/焦点的完整场景、原生拖动缩放及卡片拖拽、对 CLI/Unity 的影响、CLI/App 返回仍未实测；未实现透明区域鼠标穿透。** 生产保留原有 142 张 Card，初始全部未分组；隔离预览的空数据不会导入生产。
