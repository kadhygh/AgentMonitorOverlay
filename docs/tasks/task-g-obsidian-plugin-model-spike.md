# Task: Obsidian Plugin Model Spike

Owner: supervisor-agent
Stage: Spike worktree for Phase 6.x sidecar preparation
Status: in_progress

## Goal

- 在隔离 worktree 和 disposable test vault 中打通 `overlay -> Obsidian -> linked note` 的最小闭环。
- 用真实可运行原型而不是纯文档假设，反推 Obsidian 插件职责边界。
- 保持当前主工作区 Phase 3/4 MVP 验证不受影响。

## Current Scope

- `obsidian-plugin/`：Obsidian 插件骨架、命令、协议 handler、未来 `.amo/inbox` 处理框架。
- `overlay/`：session row 新增显式 `Open Note` 按钮、Obsidian 目标窗口选择 UI，以及对应 Tauri command。
- `scripts/obsidian/`：插件部署和手工 request 脚本。
- disposable test vault：
  - `D:\Projects\commonproject\AgentMonitorOverlay-obsidian-test-vault`
- disposable worktree：
  - `D:\Projects\commonproject\AgentMonitorOverlay-obsidian-spike`

## What Is Already Working

- 新 worktree 已创建，未污染主工作区。
- disposable test vault 已创建，并部署了 `agent-monitor-overlay` 插件产物。
- `obsidian-plugin` 本地 `npm run build` 通过。
- `overlay` 前端 `npm run build` 通过。
- `overlay/src-tauri` `cargo check` 通过。
- overlay session row 已新增 `Open Note` 按钮。
- Tauri command 已能：
  - 枚举当前可见的 `Obsidian.exe` 窗口
  - 让用户绑定目标 Obsidian 窗口
  - 准备 `.amo/inbox` request JSON
  - 在 request 入队后把焦点切到用户绑定的 Obsidian 窗口
- Obsidian 插件已能：
  - onload 后轮询 `.amo/inbox`
  - 处理 pending create-linked-note request
  - 创建或打开 deterministic linked note

## Current Blocker

- 旧的 URI-first 路线在真实环境里已证明过脆：
  - `Unable to find a vault for the URL obsidian://open/...`
  - `Unable to find a vault for the URL obsidian://amo-create-note/...`
- 当前已切换为“手动绑定目标窗口 + 插件轮询 inbox”的新主路径。
- 当前尚未完成的关键验证是：
  - 绑定的 Obsidian 窗口是否就是启用了 `agent-monitor-overlay` 插件的 test vault
  - 点击 `Open Note` 后，插件是否能在那个 vault 中稳定创建/打开 note

## Updated Direction

- 当前 MVP 主路径：
  - overlay 选择 Obsidian 目标窗口
  - queue request into `.amo/inbox`
  - focus selected Obsidian window
  - plugin polls inbox and handles note creation/opening
- 不再把“是否创建成功”绑定在 URI 冷启动或自定义协议 `amo-create-note` 上。
- 插件仍然保留，并作为后续能力入口：
  - annotation
  - canvas attach
  - summary
  - `.amo/inbox` richer processing

## Next Verification

1. 在 Obsidian 中打开 disposable test vault。
2. 确认 `agent-monitor-overlay` 插件已启用。
3. 启动 spike worktree 的 overlay dev。
4. 先点击顶部 `Obsidian` 按钮，绑定正确的可见 Obsidian 窗口。
5. 再点击 session row 上的 `Open Note`。
6. 验证是否能在 test vault 中创建并打开：
   - `AMO/Sessions/<Project>/<Tool>-<SessionId>.md`

## Expected First-Version Boundary

- 第一版 user-visible 闭环允许用户显式绑定 Obsidian 目标窗口。
- 第一版不要求自动识别正确 vault，不要求自动冷启动命中目标 vault。
- Obsidian 插件在第一版先承担：
  - plugin install/load skeleton
  - command surface
  - `.amo/inbox` processing contract
- 更复杂的 vault-native 结构化注释、canvas、summary 继续留给下一轮。
