# Focus Panel 换设备交接

日期：2026-09-11。本记录汇总本轮最终状态；此前分阶段交接中的“等待部署”属于历史记录，以这里及各任务文档的最新部署段落为准。

## 从这里继续

1. 拉取本地默认主线 `master`，先核对当前分支和 `git status`；开发默认使用当前 session 的隔离 worktree。
2. 阅读本文、[Focus 使用说明](../focus-panel.md)，按需要再读 [Card 框架](../card-framework-design-2026-09-11.md)。
3. 原机已部署最新源码，但新设备需要单独安装依赖、构建和启动。遵循 DEVELOPMENT.md 的运行步骤；不要把 Git HEAD 当成运行版本。
4. 优先补完真实 Focus 的失焦视觉复核；上轮生产检查时 Windows 锁屏，这一步没有完成。不要把隔离 probe 的成功写成生产视觉复核成功。

## 用户确认的当前产品行为

- Focus 是独立桌面悬浮处理队列。用户与具体 CLI session 充分讨论方案、执行并完整审核；不做内嵌聊天、主控预审或自动派发。
- 面板只显示用户定义的 Task groups，没有自动“未分组”兜底行。无分组 Card 保留存储但不展示。
- 一组一横行，卡片只显示标题；点击打开详情，不自动变 Reviewing，也不确认本轮已处理。详情复用原 AMO TaskCard 内容与命令入口。
- 独立“新建卡片”入口暂时关闭，代码和通用创建接口保留。通过主窗口 TaskCard 的“加入 Focus 分组”选择已有组，复用默认 Card 身份与备注；重复加入不造重复卡。
- 分组 ID 稳定，改名不改变引用。删除组原子清除 Card 引用，保留内容。名称单独保存；“仅拖拽时显示（立即保存）”勾选后立即落盘，不顺带保存名称草稿。
- 可设置一个 Review 接收组，默认关闭。配置后，未归档 Session 的真正新待审核回复可将对应未归档 Card 放入目标组；包括尚未加入 Focus 的默认会话卡。去重、启动历史、已读标记、归档排除都有约束。配置时不批量搬入历史 Review，手动移走后同一回复不会反复拉回。
- 普通状态透明空白可点击穿透；按钮、卡片与标识仍响应。拖拽/弹窗期间恢复完整输入区域，结束后恢复穿透。顶部有显式拖动缩放按钮，标识/工具按钮有增强描边。
- 常驻“分组已更新”成功提示已移除，保留保存中和错误反馈。

## 数据与关键边界

- Session 是最小运行单元，Card 是独立 UUID 工作对象，可以没有 Session。
- `amo.session` 与 `amo.conversation` 分开：执行状态和 GUI/TUI 承载/绑定生命周期不能混合。另有 `amo.processing`、`amo.notes`、`amo.task-group`。
- CardStore 的 `cards.json` 是工作数据唯一持久来源。分组注册表、Review 目标、Card 引用使用同一串行 writer；通用命令支持原子校验和精确重放。
- 不读取、不迁移、不自动删除旧 `focus-cards.json`。现有 Canvas 尚未迁入 CardStore，后续不要顺手扩展完整 Canvas/Area 改造。
- Card 归档、Session 归档、移除 conversation 是不同动作。原生命令先重新核对当前 Card 和组件引用。无权限自动向真实 CLI 发送消息或触发任务。

## 最后实现及部署

- `90808f8`：Focus / Card 组件框架基线。
- `26bb27d`：人工 Task groups、标题卡片、详情和透明面板。
- `6a54065`：移除自动未分组。
- `c5ddf51`：TaskCard 加入、独立新建停用、Review 接收规则。
- `7caeac7`：隐藏设置立即保存、提示清理、原生点击穿透。
- `d7e211e`：Focus 失焦时禁止默认非客户区重绘，修复被区域裁剪成碎片的原生边框。

以上实现和后续记录均已合入 `master`。原机最后一次以 Source 模式重启原生/前端是在18:02（香港时间）；Broker 保持原进程。未通过此任务更改真实 CLI 执行状态。

## 验证证据与缺口

- Review 接入阶段：Broker 224/224、前端112/112及真实UI＋临时Broker smoke通过。
- 输入区域阶段：前端116/116、Rust检查和3项几何测试通过；隔离Tauri＋另一进程接收窗口验证实际点击穿透及HTML拖拽捕获/恢复，9项命中检查通过。生产也核对了空白命中后方进程、按钮仍命中 AMO、弹窗捕获/恢复。
- 失焦修复：与生产相同的可缩放/透明/frameless配置，旧版三轮复现原生标题/边框碎片，修复后三轮消失；原点击/拖拽回归9项、Tauri焦点事件、Rust检查及3项测试通过。
- 最后部署的健康、前端服务和原生 interactive 启动正常。生产可见失焦截图检查被锁屏阻断，仍待完成。
- 多显示器/不同DPI、系统主题切换、最小化恢复、真实CLI/App返回与Unity长期操作尚未完整验证。隔离原生证据限当前显示器100% DPI。

详细记录：

- [人工分组与部署](2026-09-11-focus-manual-groups.md)
- [TaskCard / Review 接入](../tasks/focus-taskcard-review-routing-2026-09-11.md)
- [点击穿透与立即隐藏](../tasks/focus-input-regions-2026-09-11.md)
- [失焦残影修复](../tasks/focus-blur-rendering-2026-09-11.md)
- [归档成本审计](../tasks/card-archive-cost-audit-2026-09-11.md)

归档成本审计尚未实施：旧 Session 归档停止 transcript/窗口探测的优化仍在，但归档 Card 仍参加注意力计算，Focus常规请求仍携带归档卡，历史归档Session也会生成默认Card。后续需讨论Card恢复基线与按需历史读取，不要自动把Card归档联动为停止Session。

## 不随此次 Git 推送同步的内容

- `broker/data/` 的生产 sessions/cards/groups/notes、机器 launcher配置、凭据、构建产物和本地运行进程。
- `tmp/` 下的备份、截图、日志、隔离原生probe工程和运行中的3199浏览器预览。文档里的这些路径是原机证据位置，新设备不能直接访问。可复用已提交的浏览器smoke脚本；临时原生probe未作为通用工具提交。
- 主目录已有其他工作的未提交内容原样保留，未混入本轮：`docs/canvas-area-task-orchestration-plan-2026-09-07.md`、`docs/managed-side-fork-plan.md`、`overlay/src-tauri/Cargo.toml`（以git status为准）、未跟踪的 `docs/obsidian-managed-fork-investigation-2026-09-08.md`。

因此，换设备拉取源码不会自动带走当前任务队列或上述其他工作的草稿。如果需要这些本机数据，单独迁移并明确数据目录；不要把它们提交到仓库来绕过运行数据管理。
