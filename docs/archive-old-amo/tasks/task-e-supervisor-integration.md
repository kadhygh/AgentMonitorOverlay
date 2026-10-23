# Task: Supervisor Integration

Owner: supervisor-agent
Stage: Phase 1/2/3 integration
Status: done

## Goal

- 收敛 Task A-D 的 worker 输出。
- 判断哪些结果进入当前阶段分支。
- 形成用户可验证版本和验证清单。
- 更新项目计划、阶段状态和 git checkpoint 建议。

## Allowed Scope

- 更新 `PROJECT_PLAN.md`。
- 更新 `docs/` 下阶段文档、任务卡、验证清单。
- 整合 worker 产出的代码和文档。
- 管理本地 git 分支、暂存和 checkpoint commit。

## Forbidden Scope

- 不把 worker 未验证结论直接当最终结论。
- 不让用户处理 worker 冲突或技术审查。
- 不执行 `git reset --hard`、rebase、push、删除分支，除非用户明确要求。
- 不把高风险控制能力纳入 MVP。

## Required Context

- `PROJECT_PLAN.md`
- `USER_SESSION_MANUAL.md`
- Task A-D 的任务卡和完成报告。
- 当前 git status / diff / staged 文件。

## Acceptance Criteria

- 明确 Phase 1/2/3 当前达成度。
- 明确哪些功能可以交给用户验证。
- 明确哪些任务需要继续派 worker。
- 项目文档与实际仓库状态一致。
- git 工作区边界清晰，必要时形成 checkpoint commit 建议。

## Verification

- 检查 `git status --short`。
- 检查 `git diff --stat`。
- 检查 `git diff --cached --name-only`。
- 运行 broker / overlay / scripts 的可用验证命令。
- 生成用户验证清单。

## Report Back

主管 agent 对用户汇报：

```text
当前阶段：
本轮状态：
git 状态：
需要我验证：
需要我确认：
下一步计划：
风险/阻塞：
```
