# TaskCard 加入分组与 Review 接收

2026-09-11，基于 `a5cde0c`。用户要求暂时注释掉新建卡片功能，从 TaskCard 向组添加，并在多个分组中指定一个 Review 接收组。

## 实现

- FocusPanelApp 用明确的关闭开关暂时禁用独立新建入口和弹窗，NewCardForm 及通用 Card 创建接口保留，方便后续恢复。
- TaskCard 增加可选 addToFocus 命令，主窗口提供“加入 Focus 分组”按钮。点击才读取分组并挂载选择器，无新增常驻查询。没有分组时引导打开 Focus 创建组；不自动创建默认组。
- POST `/api/cards/from-session` 接受 `{operationId,sessionRef:{frameworkId,sessionId},groupId}`，返回 `{card}`。共享默认来源索引及串行 writer，复用原 Card，不重复创建；保留标题、备注、组件和真实 Session 状态。显式再次加入会恢复已归档 Card。Session 自身归档/移除、目标组删除或原 Card 已换源时拒绝请求。
- 保存结果不明确时以相同 operationId 重试；确定错误要求刷新并重新选择。选择器不执行 CLI/App 启动或消息操作。
- 分组注册表新增 reviewGroupId，默认 null。GET 分组和 Focus 响应都包含该字段；set-review-group `{groupId:null|string}` 命令纳入同一组 revision、原子保存及重放。目标组改名不改关联；删除组同时取消接收。

## Review 规则

当前范围为所有未归档 Session 的新待审核回复，包含尚未加入 Focus 的默认 Card。

自动收纳需要同时满足：

1. Reply 去重证据判断为一条真正新观察到的回复。
2. Session 满足现有界面 Review 条件：reviewRequired 为真、reviewStatus 不是 reviewed、reviewedAt 为空。
3. 不是启动时的 seed/history，源 Session 没有 archivedAt/dismissedAt，Card 也未归档。
4. 用户已指定一个有效 Review 目标组。

设置、切换或删除接收组不会扫回历史任务。手动移走后的同一回复不会把卡片拉回；下一条新的待审核回复可以。运行、权限、失败等其他状态本身不触发换组。点击卡片仍只打开详情，无自动 Reviewing、自动已处理或自动任务派发。

每张 Card 仍最多32个组件；自动收纳遇到没有分组组件且已满的 Card 时跳过分组写入，保留注意力信息，避免观察循环持续写入失败。显式手动加入时则原子返回格式错误，不部分修改。

已有 Card 归档成本审计中的生命周期优化尚未展开；本轮只确保已归档对象不因 Review 路由重新加入面板。归档期的 attention 计算等剩余成本仍见原审计。

## 验证

- Broker 完整回归：224/224 通过，隔离测试数据与 LOCALAPPDATA。
- 前端完整回归：112/112 通过；生产构建通过。
- 真实 UI + 临时 Broker smoke 通过，产物 `tmp/focus-manual-smoke-FowzJ7`，页面错误为空。覆盖实际 TaskCard/picker 加入与重复加入、Review 选择持久化、新回复收纳、重复和 heartbeat 保持人工移组、归档排除、删除接收组、重启恢复；360px 浅色 picker/设置截图已检查。
- 自动回复测试使用临时工作区/临时 vault 和合成 Session，没有对真实 CLI 发送消息或启动任务。生产原生验证只检查入口、弹窗与设置，接收组保留默认关闭，等待用户选择。
