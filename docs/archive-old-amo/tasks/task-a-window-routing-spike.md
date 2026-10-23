# Task: Window Routing Spike

Owner: worker-window-routing
Stage: Phase 1
Status: done

## Goal

- 验证 Windows 上如何稳定发现并激活 Codex / Claude / Kiro 相关窗口。
- 形成第一版窗口命名规范、匹配策略和失败兜底。
- 为 Tauri overlay 的点击切换能力提供可实现的技术路径。

## Allowed Scope

- 新增或修改 `docs/window-routing-notes.md`。
- 如需要，可新增 `scripts/window-routing/` 下的本地验证脚本。
- 可读取 Windows Terminal、PowerShell、AutoHotkey、Win32、Tauri 相关公开文档或本机窗口信息。

## Forbidden Scope

- 不实现正式 Tauri overlay。
- 不修改 broker 或 adapter 代码。
- 不引入需要长期运行的外部服务。
- 不执行破坏性 git 操作，不提交、不推送。
- 不改变项目技术栈。

## Required Context

- `PROJECT_PLAN.md`
- `USER_SESSION_MANUAL.md`

## Acceptance Criteria

- `docs/window-routing-notes.md` 至少包含 3 种窗口匹配方案对比。
- 明确推荐方案：优先匹配字段、辅助匹配字段、失败兜底。
- 明确 Codex / Claude / Kiro session 标题命名规范建议。
- 明确第一版 Tauri 需要调用的 Windows 激活路径。
- 至少说明如何验证 3 个不同窗口能被准确切换。

## Verification

- 检查当前 Windows 可枚举窗口信息的方式。
- 如能本机验证，记录实际命令和结果。
- 如不能完整验证，明确缺口和下一步手工验证方法。

## Report Back

Worker 完成后汇报：

1. 做了什么。
2. 改了哪些文件。
3. 推荐窗口匹配策略。
4. 实际验证了什么。
5. 遗留问题。
6. 是否需要主管 agent 或用户决策。
