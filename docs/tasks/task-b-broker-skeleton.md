# Task: Broker Skeleton

Owner: worker-broker
Stage: Phase 2
Status: done

## Goal

- 实现本地 `agent-monitor-broker` 的最小可运行服务。
- 接收 mock / hook adapter 上报事件。
- 提供统一 session 状态 API 给 overlay 读取。

## Allowed Scope

- 新增 broker 源码目录，例如 `broker/`。
- 新增 mock event 示例，例如 `examples/events/`。
- 新增本地验证脚本，例如 `scripts/broker/`。
- 可新增必要的包管理文件，但必须优先选择轻量、Windows 易运行的方案。

## Forbidden Scope

- 不实现 Tauri overlay。
- 不接入真实 Codex / Claude / Kiro hook。
- 不做自动审批、shell 控制、远程执行。
- 不引入数据库，除非先证明 JSON 文件无法满足 MVP。
- 不执行 git commit / branch / push。

## Required Context

- `PROJECT_PLAN.md`
- `USER_SESSION_MANUAL.md`
- `docs/tasks/task-d-tool-adapter-spike.md`

## Acceptance Criteria

- 能启动本地 HTTP 服务，默认监听 `127.0.0.1`。
- 至少提供：
  - `GET /api/health`
  - `GET /api/sessions`
  - `POST /api/events`
  - `POST /api/sessions/:id/heartbeat`
- `POST /api/events` 能把 Codex / Claude / Kiro mock event 转成统一 session model。
- `GET /api/sessions` 能返回所有 session。
- broker 重启后最近 session 状态不丢失，或文档明确重建策略。
- 提供 Windows PowerShell 下的最小验证命令。

## Verification

- 启动 broker。
- 手工 POST 至少 3 条不同工具事件。
- 调用 `GET /api/sessions` 检查统一状态。
- 如实现了持久化，重启后再次检查状态。

## Report Back

Worker 完成后汇报：

1. 做了什么。
2. 改了哪些文件。
3. API 如何启动和验证。
4. 当前 session model 字段。
5. 未实现范围。
6. 是否需要主管 agent 或用户决策。
