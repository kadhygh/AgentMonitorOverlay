# Task: Obsidian Sync-Back Bridge Spike

Owner: worker-obsidian-sync-back
Stage: Future parallel spike from Phase 6.x planning
Status: partial

## Goal

- 为 `Obsidian -> target agent session / CLI window` 定义最小回传桥接方案。
- 明确第一版为什么应优先 `copy + focus target session`，而不是自动发送。
- 明确 sync-back 所需的目标 session 标识、用户动作、安全门和失败反馈。
- 在独立 worktree 内准备一个 disposable Obsidian test vault 和最小 plugin/helper prototype。

## Allowed Scope

- 更新 `docs/` 下与 sync-back bridge 相关的设计文档。
- 新增轻量桥接草案，例如：
  - sync-back payload 结构
  - target session locator
  - clipboard + focus flow
  - 安全确认 UX
- 可新增局部原型脚本、空 vault、plugin skeleton 或示例配置，例如：
  - `scripts/obsidian/`
  - `examples/obsidian/`
  - `prototypes/obsidian-sync-back-plugin/`
  - `tmp/obsidian-sync-back-vault/`
- 可复用现有 AMO window routing / session identity 文档进行设计。

## Forbidden Scope

- 不做自动把文本直接注入真实 CLI 输入框的主线实现。
- 不做自动 shell 执行。
- 不做自动审批。
- 不改坏当前 Phase 3/4 的窗口路由主线。
- 不要求真实接入 Obsidian 插件市场发布流程，只要把桥接点定义清楚。
- 不执行 git commit / branch / push。

## Required Context

- `PROJECT_PLAN.md`
- `DEVELOPMENT.md`
- `docs/supervisor-status.md`
- `docs/window-routing-notes.md`
- `docs/tasks/task-f-obsidian-external-note-jump-spike.md`
- `docs/tasks/task-g-obsidian-plugin-model-spike.md`

## Acceptance Criteria

- 明确第一版 sync-back 推荐路径：
  - summarize annotations
  - copy summary to clipboard
  - focus target session/window
  - user manually paste/send
- 定义最小 bridge contract，例如：
  - target session id
  - expected tool
  - cwd / project
  - optional window hint
  - summary payload shape
- 准备一个可接手的空 Obsidian test vault，其中包含：
  - 一个示例 note
  - 一个最小 plugin skeleton
  - 一个 sync-back helper script
- 明确失败与风险策略：
  - 找不到 session
  - session 已失效
  - 焦点切换被系统拦截
  - summary 太长或格式不合适
- 给出“后续如果要升级到 auto-send，需要额外满足哪些安全条件”的清单。

## Verification

- 本轮只要求静态验证与离线 helper 验证：
  - annotation marker 解析
  - summary 生成
  - sync-back request JSON 生成
  - helper `-DryRun` 输出结构化结果
- 不要求也不建议在本轮验证自动输入注入。
- Obsidian GUI 拉起与手工启用 plugin 交由后续人工附体验证。
- 必须区分已验证行为与设计推断。

## Report Back

Worker 完成后汇报：

1. 做了什么。
2. 改了哪些文件。
3. 推荐的 sync-back bridge 方案是什么。
4. 第一版为什么应坚持 `copy + focus target session`。
5. 实际验证了什么。
6. 升级到 auto-send 还缺什么。
7. 是否需要主管 agent 或用户决策。
