# Task: Codex Claude Kiro Hook Spike

Owner: worker-tool-adapters
Stage: Phase 4 spike
Status: done

## Goal

- 验证 Codex / Claude / Kiro 的官方 hook 或接入点能否提供 MVP 所需事件。
- 设计 hook 上报到 broker 的最小事件格式。
- 产出配置示例和风险清单。

## Allowed Scope

- 新增 `docs/tool-adapter-spike.md`。
- 新增 hook 配置示例，例如 `examples/hooks/`。
- 新增轻量上报脚本，例如 `scripts/adapters/`。
- 可查阅官方文档和本机配置文件位置。

## Forbidden Scope

- 不修改用户真实全局 Codex / Claude / Kiro 配置，除非主管 agent 另行确认。
- 不接管真实 shell 执行。
- 不实现自动审批。
- 不把真实 transcript 或敏感路径提交进仓库。
- 不执行 git commit / branch / push。

## Required Context

- `PROJECT_PLAN.md`
- `USER_SESSION_MANUAL.md`
- `docs/tasks/task-b-broker-skeleton.md`

## Acceptance Criteria

- `docs/tool-adapter-spike.md` 明确 Codex / Claude / Kiro 各自可用事件源。
- 明确每类工具能否拿到：
  - session id
  - cwd
  - event name
  - transcript/log path
  - permission/waiting 状态信号
  - window hint
- 给出统一上报 payload 草案。
- 给出至少 Codex 和 Claude 的 hook 配置示例。
- Kiro 至少给出 hook / ACP / IDE hooks 的推荐路线和不确定点。

## Verification

- 如能在不污染用户全局配置的前提下测试 hook，记录测试方法。
- 如只能做文档级 spike，必须列出真实验证步骤和风险。
- 上报 payload 应能被 Task B broker 接收或容易映射。

## Report Back

Worker 完成后汇报：

1. 做了什么。
2. 改了哪些文件。
3. Codex / Claude / Kiro 各自结论。
4. 推荐 payload。
5. 实际验证了什么。
6. 遗留问题。
7. 是否需要主管 agent 或用户决策。
