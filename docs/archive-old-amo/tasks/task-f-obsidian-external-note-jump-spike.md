# Task: Obsidian External Note Jump Spike

Owner: worker-obsidian-entry
Stage: Superseded by Phase 5 AMO Obsidian Bridge MVP
Status: superseded

This standalone spike has been folded into `docs/amo-obsidian-bridge-mvp.md` and `docs/tasks/task-i-amo-obsidian-bridge-mvp.md`. The useful part that remains is the explicit `session -> note/canvas` opening contract; it should now be implemented through the AMO bridge and overlay card actions.

## Goal

- 为 Agent Monitor Overlay 定义 `session -> external note` 的最小入口契约。
- 验证 `Open in Obsidian` 是否可以在不引入 Obsidian 插件依赖的前提下先行成立。
- 明确第一版需要哪些 session-note 绑定字段，以及 AMO 侧应该如何显式触发打开动作。

## Allowed Scope

- 更新 `docs/` 下与 Obsidian note jump 相关的设计文档。
- 新增面向后续实现的契约草案，例如：
  - session-note binding 字段
  - note locator 结构
  - Obsidian URI / file open 方案比较
- 如确有必要，可新增轻量原型脚本或示例配置，例如 `scripts/obsidian/` 或 `examples/obsidian/`。
- 可调研 Obsidian 官方 URI / vault 打开方式，并记录本机验证步骤。

## Forbidden Scope

- 不实现 note 自动创建。
- 不实现 canvas 写入。
- 不实现注释汇总。
- 不实现 sync-back 回写 CLI。
- 不修改用户全局 Obsidian 配置，除非主管 agent 明确要求。
- 不把 Obsidian 变成当前 AMO 的主数据模型。
- 不执行 git commit / branch / push。

## Required Context

- `PROJECT_PLAN.md`
- `DEVELOPMENT.md`
- `docs/supervisor-status.md`
- `docs/window-routing-notes.md`
- `docs/tasks/task-e-supervisor-integration.md`

## Acceptance Criteria

- 产出一份清晰的 `Open in Obsidian` 入口设计说明。
- 明确第一版 session-note binding 最小字段，例如：
  - `notePath` / `noteId`
  - `vault`
  - `subpath` 或 heading/block target
  - 是否需要 `canvasId`
- 比较并给出推荐打开策略：
  - `obsidian://` URI
  - 本地文件路径
  - vault + note name
- 明确 AMO 侧动作边界：
  - 仅显式用户点击触发
  - 找不到 note 时给出可解释失败
  - 不依赖脆弱标题猜测
- 给出后续实现建议，但不要求真正接入主线 UI。

## Verification

- 如果做本机原型，记录：
  - 如何打开指定 note
  - 如何打开指定 vault/note/subpath
  - 失败时会出现什么行为
- 如果只做文档级 spike，必须给出后续最小手工验证步骤。
- 明确哪些结论已本机验证，哪些只是文档/推断。

## Report Back

Worker 完成后汇报：

1. 做了什么。
2. 改了哪些文件。
3. 推荐的 `Open in Obsidian` 入口契约是什么。
4. 实际验证了什么。
5. 还缺哪些前置条件。
6. 哪些问题留给 Obsidian 插件或 sync-back 子任务处理。
7. 是否需要主管 agent 或用户决策。
