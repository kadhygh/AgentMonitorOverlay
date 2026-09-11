# Focus Panel

Focus Panel 是 AMO 的独立悬浮处理队列。Open Canvas 右侧的开关控制显示/隐藏，面板关闭按钮同步关闭开关。它现在读取通用 CardStore，不再维护独立的 Focus 卡片文件。

## 使用

- **New card**：创建独立工作卡，填写标题和备注。可以先记录想法，不必先启动 Session。
- **Pending / In progress / Later / Future / Handled**：保存你的人工处理安排；All tasks 查看全部。
- 点击卡片展开。关联 Session 时显示常规会话状态；Conversation 区域单独显示 CLI/TUI、App/GUI 和绑定可用性。
- **Open CLI / Open app / Open conversation**：通过主窗口已有入口返回对话。无绑定的 Codex 可进入目标选择；支持的无绑定 CLI 可恢复。App 不提供 CLI Resume。
- **Task note / Save note**：保存自己的上下文。未保存草稿在隐藏后保留；只有保存后才能跨应用重启保留。
- **Handle this update / Mark handled**：处理当前卡片或指定更新版本，不结束 Session，不代替 CLI 内权限回答。

打开对话不会清除人工待办。新回复保留 Later、Future、In progress 的选择并显示 New update；已处理卡片有新的回复时重新进入 Pending。重复回复不会重复增加版本。

并发备注冲突时保留当前草稿，并显示最新保存内容，需明确选择后重试。Card 归档或 processing 组件被移除后，卡片从队列消失；尚未保存的备注可以在 All tasks 中找回文本。

## Card 与组件

Card 有独立 UUID 身份，基本字段只包含标题、版本、时间、归档状态与组件集合。初版组件：

| 组件 | 用途 |
|---|---|
| amo.session | 引用真实会话，读取一般会话数据与运行状态 |
| amo.conversation | 引用 Session 组件，单独读取 GUI/TUI 对话承载、绑定与可用性 |
| amo.processing | 人工分组和处理到的源版本 |
| amo.notes | 备注 |

一张卡可以没有 Session，也可以包含多个 Session 引用。当前 Focus 的 processing 组件选择一个源来展示/处理；多源聚合后续再做。移除对话组件不结束 Session；Card 归档不等于 Session 归档。

主窗口收到返回对话请求时，会重新核对 Card/组件关联与最新 Session，防止旧界面按钮操作已改绑的目标。

## 数据接口

通用接口提供创建/读取 Card、修改标题、归档/恢复、增删组件、更新处理状态与备注。跨组件修改可以在单个原子命令批次中完成。Focus 接口是该存储的视图与命令门面。

详细数据和接口定义见 [Card 整体框架](card-framework-design-2026-09-11.md)。

## 本轮数据策略

按用户授权直接采用 `cards.json`；可用 `AGENT_MONITOR_CARDS_DATA_FILE` 指定测试位置。旧 `focus-cards.json` 不读取、不迁移，也不自动删除。现有 Session 仍从原监控底座接入，并建立新的默认 Card 映射。

首次接入时，已有未处理回复/阻塞进入 Pending，已看过的历史和无待处理内容的会话进入 Handled；后续以 Card 内人工记录为准。

面板默认不随 AMO 启动自动打开，但 Broker 持续记录变化。复用已有 AMO 通知和原生操作，不创建第二个窗口探测/通知循环。

## 验证与限制

`node scripts/performance/focus-panel-smoke.cjs` 使用真实 Focus UI 和 Broker、临时工作区，以及模拟的原生接口。它验证独立卡创建、通用接口、组件拆分/移除、原子失败、处理状态、冲突、重试、真正的 Broker 重启和隐藏轮询。可用 `AMO_PLAYWRIGHT_MODULE` 指向现有 Playwright；产物位于 `tmp/focus-smoke-*`。

[当前执行记录](tasks/card-components-refactor-2026-09-11.md) 记录最终验证。真实 Windows 窗口层级和 CLI/App 聚焦仍需实测；委托给 AMO 不代表已经成功聚焦。存储在单 Broker 内串行，不支持多个 Broker 同时写同一文件。对于没有稳定 turn/artifact ID 的未知来源，回复去重仍依赖时间信息。
