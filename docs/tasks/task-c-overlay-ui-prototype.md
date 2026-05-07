# Task: Overlay UI Prototype

Owner: worker-overlay-ui
Stage: Phase 3
Status: done

## Goal

- 实现第一版 Windows 桌面悬浮窗原型。
- 从 mock 数据或 broker API 读取 session 状态。
- 显示 3-8 条 session 时仍能快速扫读。
- 点击 session 行后触发窗口激活路径。

## Allowed Scope

- 新增 Tauri app 或 overlay 源码目录，例如 `overlay/`。
- 可新增前端 UI 组件、样式和 Tauri command。
- 可使用 mock session 数据作为第一步。
- 如 broker 已可用，可对接 `GET /api/sessions`。

## Forbidden Scope

- 不实现真实 Codex / Claude / Kiro adapter。
- 不做权限审批、取消任务、追加 prompt。
- 不做复杂 dashboard 或历史搜索。
- 不引入云服务或账号系统。
- 不执行 git commit / branch / push。

## Required Context

- `PROJECT_PLAN.md`
- `USER_SESSION_MANUAL.md`
- `docs/tasks/task-a-window-routing-spike.md`
- 如存在，读取 `docs/window-routing-notes.md`。

## Acceptance Criteria

- overlay 能以 Windows 桌面窗口形式启动。
- 窗口默认置顶、紧凑、可拖动。
- UI 显示 session 的 tool、cwd/project、state、last event/message、needsAttention。
- 状态点至少覆盖 running、waiting_user、waiting_permission、completed、failed、unknown。
- 点击 session 行能调用占位或真实窗口激活命令，并对失败有可见反馈或日志。
- 提供启动和验证命令。

## Verification

- 本机启动 overlay。
- 截图或文字记录 3-8 条 mock session 的显示效果。
- 验证 always-on-top / draggable / collapsed 或最小化行为。
- 验证点击 session 是否触发窗口激活路径。

## Report Back

Worker 完成后汇报：

1. 做了什么。
2. 改了哪些文件。
3. 如何启动。
4. UI 当前能验证什么 vibe。
5. 哪些交互是 mock。
6. 遗留问题。
7. 是否需要主管 agent 或用户决策。
