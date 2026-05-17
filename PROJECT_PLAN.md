# Agent Monitor Overlay Project Plan

## 1. 项目目标

做一个 Windows 优先的桌面监控悬浮窗，用于同时观察多条 AI coding agent 工作线，并能从悬浮窗快速切换到对应窗口。

首批目标工具：

- OpenAI Codex CLI / Codex TUI / Codex App Server
- Claude CLI / Claude Code
- Kiro CLI / Kiro IDE agent hooks

核心体验目标：

- 常驻小悬浮窗显示当前所有 agent session。
- 每条 session 显示工具类型、项目目录、当前状态、最近动作、是否需要用户处理。
- 点击 session 行后快速切换到对应终端、IDE 或 Kiro 窗口。
- 后续支持在悬浮窗内处理等待权限、取消任务、追加指令、查看最近输出。

本项目不是一开始就做完整 agent control plane。第一阶段优先验证“状态可采集、窗口可跳转、用户感知足够清晰”。

## 2. 市场调查结论

没有发现一个现成工具完整满足以下组合：

- Windows 桌面悬浮窗
- 同时监控 Codex CLI、Claude CLI/Claude Code、Kiro 客户端
- 识别等待权限/等待输入/运行中/完成/失败
- 点击后精确切回对应窗口
- 支持长期扩展为本地 agent 工作台

已发现的相关产品和可借鉴点：

| 产品/方向 | 链接 | 可借鉴点 | 主要差距 |
| --- | --- | --- | --- |
| Vibe Island | https://vibeisland.app/ | 最接近目标体验，悬浮/顶部岛、多 agent 状态、跳回终端或 IDE | 偏 macOS，Windows 不完整；Kiro 多数只覆盖 CLI 或 IDE 终端 |
| AgentsView | https://www.agentsview.io/ | 本地 session 浏览、历史检索、支持多种 agent | 不是悬浮窗，不主打窗口跳转和即时处理 |
| CliDeck | https://www.clideck.dev/ | 浏览器多 CLI 工作台，真实 PTY，多会话并排 | 更像托管新会话，不是监控已有桌面窗口 |
| CC Copilot | https://cc-copilot.com/en | Tauri 桌面工作台，Codex + Claude，多 pane | 不支持 Kiro，不是外部窗口监控悬浮窗 |
| OctoAlly | https://www.octoally.com/ | Claude/Codex dashboard、实时输出、tmux-backed terminal | 偏完整 dashboard，不是轻量 overlay，Kiro 不明确 |
| The Companion | https://docs.thecompanion.sh/ | 本地 Web UI、Claude/Codex session、权限控制 | 不支持 Kiro，不是 OS 层悬浮窗 |
| tmux-agent-status | https://github.com/samleeney/tmux-agent-status | 状态栏、多 session 状态、快速切换 | tmux 场景，不是 Windows 桌面悬浮窗 |

Windows 可拼装方向：

- PowerToys Always On Top: https://learn.microsoft.com/windows/powertoys/always-on-top
- PowerToys Workspaces: https://learn.microsoft.com/windows/powertoys/workspaces
- PowerToys FancyZones: https://learn.microsoft.com/windows/powertoys/fancyzones
- Fluent Search: https://fluentsearch.net/docs/Search%20apps/Windows
- Flow Launcher: https://www.flowlauncher.com/
- Windows Terminal panes: https://learn.microsoft.com/windows/terminal/panes
- WezTerm: https://wezterm.org/
- AutoHotkey WinSet: https://documentation.help/AutoHotkey-en/WinSet.htm
- Tauri window customization: https://v2.tauri.app/learn/window-customization/

## 3. 技术判断

不要解析终端 TUI 屏幕文本作为主方案。更可靠的接入方式是：

- Codex: App Server / SDK / hooks / transcript
- Claude: hooks / statusline / stream-json / Agent SDK
- Kiro: ACP / CLI hooks / IDE Agent Hooks

参考官方入口：

- Codex App Server: https://developers.openai.com/codex/app-server
- Codex SDK: https://developers.openai.com/codex/sdk
- Codex Hooks: https://developers.openai.com/codex/hooks
- Claude Hooks: https://code.claude.com/docs/en/hooks
- Claude Statusline: https://code.claude.com/docs/en/statusline
- Claude CLI Reference: https://code.claude.com/docs/en/cli-reference
- Kiro ACP: https://kiro.dev/docs/cli/acp/
- Kiro CLI Hooks: https://kiro.dev/docs/cli/hooks/
- Kiro IDE Hooks: https://kiro.dev/docs/hooks/

推荐架构：

```text
Codex hooks/AppServer   \
Claude hooks/statusline  -> local agent-monitor-broker -> Tauri overlay -> Win32 window activation
Kiro ACP/hooks          /
```

核心原则：

- 先做只读监控，再做控制。
- 先接 hook 状态，再接深度 SDK/App Server。
- 先能跳回窗口，再做窗口内控制。
- 所有自动审批、命令执行、shell 控制都必须晚于 MVP，并单独标记高风险。

## 4. 用户角色和协作模式

用户只承担三个职责：

1. 验证  
   用户负责在真实工作流中试用版本，确认状态是否准确、切换是否可靠、是否打扰工作节奏。

2. Vibe  
   用户负责判断悬浮窗的观感、信息密度、交互节奏、是否像个人工作台，而不是普通监控面板。

3. 需求细节确认  
   当需求存在分歧时，用户只需要做取舍，例如“悬浮窗默认展开还是折叠”“等待权限是否要强提醒”“点击是切窗口还是打开详情”。

用户不负责：

- 拆分技术任务
- 跟多个 worker agent 对齐
- 审查底层实现细节
- 同时阅读多个 agent 的碎片报告
- 手工合并 worker 的冲突方案

## 5. Agent 协作协议

项目采用主管 agent + 多 worker agent 的模式。

### 5.1 主管 agent

主管 agent 是唯一对用户汇报的角色。

主管 agent 职责：

- 维护本计划文档和阶段状态。
- 根据阶段目标拆分 worker task。
- 启动或指派其他 agent 做探索、实现、验证、评审。
- 收敛 worker 输出，形成一个用户能决策的结论。
- 只向用户汇报需要用户确认的事项和可验证结果。
- 避免把多个 worker 的原始输出直接堆给用户。
- 负责最终质量门禁：是否能运行、是否有验证、是否和阶段目标一致。
- 管理本地 git：分支、阶段 checkpoint、提交边界、worker 合并顺序、回滚方案。
- 在需要创建远程仓库、推送、安装依赖、引入外部服务、做高风险 git 操作时，先向用户说明原因并获得确认。

主管 agent 的汇报格式：

```text
当前阶段：
本轮完成：
需要你验证：
需要你确认：
下一步计划：
风险/阻塞：
```

### 5.2 Worker agent

Worker agent 不直接改变项目方向。每个 worker 只执行主管 agent 给出的单一任务卡。

Worker agent 必须输出：

- 做了什么
- 改了哪些文件
- 如何验证
- 遗留问题
- 是否需要用户决策

Worker agent 禁止：

- 自行扩大阶段范围
- 自行改变技术栈
- 自行引入外部服务
- 在未获主管 agent 指派时修改其他 worker 的文件
- 把未验证的结论当成最终结论
- 自行执行全局 git 操作，例如 `git add .`、跨任务 commit、branch rename、reset、rebase、push

### 5.3 任务卡模板

```markdown
## Task: <短名称>

Owner: <worker agent 名称或会话>
Stage: <阶段编号>
Status: todo | in_progress | blocked | partial | done

Goal:
- <本任务要达成什么>

Allowed scope:
- <允许改哪些文件/模块>

Forbidden scope:
- <不能碰哪些区域>

Required context:
- <必须先读的文档/文件>

Acceptance criteria:
- <完成判定>

Verification:
- <必须运行或手工验证的项目>

Report back:
- <worker 完成后给主管的摘要格式>
```

### 5.4 本地 Git 管理规则

本项目需要主管 agent 管理本地 git，目的是方便多 agent 并行开发、阶段回滚、用户验证版本固定。

默认策略：

- `main` 或 `master` 保持用户可验证的稳定状态。
- 主管 agent 在阶段开始前创建阶段分支，例如 `phase/1-window-routing`、`phase/2-broker-mvp`。
- worker agent 如果需要独立开发，使用任务分支，例如 `task/A-window-routing`、`task/B-broker-skeleton`。
- worker 完成后只提交自己任务范围内的文件，由主管 agent 合并或手动搬运。
- 每个阶段至少有一个 checkpoint commit。
- 用户验证通过后，主管 agent 再把阶段结果合回稳定分支。

提交规则：

- commit message 使用清晰前缀：
  - `docs: ...`
  - `feat: ...`
  - `fix: ...`
  - `test: ...`
  - `chore: ...`
- 每个 commit 应该对应一个明确任务或阶段 checkpoint。
- 不允许把无关格式化、临时日志、依赖缓存、编辑器状态混进功能提交。
- 不允许 worker 自行提交主管未分配的范围。

主管 agent 每轮 git 操作前后必须检查：

```powershell
git status --short
git diff --stat
git diff --cached --name-only
```

禁止操作：

- 未经用户明确要求，不执行 `git reset --hard`。
- 未经用户明确要求，不执行清理未跟踪文件的破坏性命令。
- 不使用 `git add .` 处理多 worker 工作区。
- 不在用户未确认远程仓库前执行 `git push`。
- 不把本地实验分支当作用户已验证版本。

需要询问用户的情况：

- 是否创建远程仓库或绑定 remote。
- 是否推送到 GitHub/GitLab/私有仓库。
- 是否保留某个实验分支。
- 是否合并存在冲突的 worker 输出。
- 是否执行 rebase、reset、force push、删除分支等高风险操作。

建议主管 agent 维护的 git 记录：

```text
当前稳定分支：
当前阶段分支：
活跃 worker 分支：
最近 checkpoint commit：
未合并任务：
用户已验证版本：
```

## 6. 项目阶段

### Phase 0: 需求和技术验证基线

目标：

- 固化项目目标、角色分工、阶段路线。
- 明确第一版只做监控和跳转，不做自动审批。
- 验证 Codex / Claude / Kiro 的官方接入点是否足够支撑 MVP。

交付物：

- 本 `PROJECT_PLAN.md`。
- 主管 agent 后续执行时维护的阶段状态。
- 一份 MVP 需求确认清单。

验收标准：

- 用户确认项目方向和协作模式。
- 用户确认 MVP 优先级：状态监控、窗口跳转、轻量悬浮。

状态：

- `partial`
- 市场和官方接入点已经完成初步调查。
- 第一轮主管推进已经创建阶段分支和任务卡。
- 还需要第一轮 spike 产出后进入可验证节点。

### Phase 1: Windows 工作流低代码验证

目标：

- 不写完整应用，先验证当前 Windows 工作流能否被稳定识别和切换。
- 建立 Codex / Claude / Kiro session 命名规范。
- 确定窗口匹配策略。

建议验证项：

- Windows Terminal 或 WezTerm 是否能稳定设置 tab/window title。
- Codex session 标题能否包含项目名，例如 `Codex-Mecho`。
- Claude session 标题能否包含项目名，例如 `Claude-project_mining`。
- Kiro 窗口或 IDE 标题是否能被 Win32/AutoHotkey/Fluent Search 稳定匹配。
- PowerToys Always On Top 是否满足临时悬浮需求。
- Fluent Search 是否能作为备用快速切换方案。

交付物：

- `docs/window-routing-notes.md`
- 标题命名规范
- 窗口匹配策略表

验收标准：

- 至少 3 个不同窗口能通过标题或进程名准确切换。
- 用户认为窗口跳转体验方向可接受。

### Phase 2: Local Broker MVP

目标：

- 创建本地 `agent-monitor-broker`。
- 接收 Codex / Claude / Kiro adapter 的状态事件。
- 提供统一状态 API 给悬浮窗读取。

建议实现：

- 本地 HTTP 服务：`127.0.0.1:<port>`
- 状态存储：先用 JSON 文件或 SQLite，优先简单可靠
- API:
  - `GET /api/sessions`
  - `POST /api/events`
  - `POST /api/sessions/:id/heartbeat`

统一 session model:

```json
{
  "tool": "codex",
  "sessionId": "string",
  "cwd": "G:\\PROJECT\\Mecho",
  "title": "Codex - Mecho",
  "state": "starting|running|waiting_permission|waiting_user|idle|completed|failed|cancelled",
  "lastEvent": "PostToolUse",
  "lastMessage": "short text",
  "needsAttention": false,
  "windowHint": {
    "process": "WindowsTerminal.exe",
    "title": "Codex - Mecho"
  },
  "updatedAt": "2026-05-07T00:00:00+08:00"
}
```

交付物：

- 本地 broker 源码
- 简单命令行验证脚本
- mock event 示例

验收标准：

- 能手工 POST 3 条不同工具事件。
- `GET /api/sessions` 能返回统一状态。
- broker 重启后不会丢失最近状态，或有明确的重建策略。

### Phase 3: Tauri 悬浮窗 MVP

目标：

- 创建 Windows 桌面悬浮窗。
- 从 broker 读取 session 状态。
- 显示状态卡片。
- 点击卡片切换到目标窗口。

UI 行为：

- 默认小窗，always on top。
- 可拖动。
- 可折叠。
- 不遮挡主工作区。
- 显示 3-8 条 session 时仍清晰。
- 等待用户处理的 session 有明显但不过度打扰的提示。

第一版状态视觉：

- Running: 绿色或蓝绿色点
- Waiting user: 黄色点
- Waiting permission: 橙色或红色点
- Completed: 灰绿色点
- Failed: 红色点
- Stale/unknown: 灰色点

交付物：

- Tauri app
- 基本 UI
- broker 轮询或订阅
- Windows 窗口激活能力

验收标准：

- 悬浮窗能保持置顶。
- 能显示 mock 的 Codex / Claude / Kiro session。
- 点击 session 能切到目标窗口。
- 用户确认第一版 vibe 是否正确。

### Phase 4: Tool Adapters

目标：

- 接入真实 Codex / Claude / Kiro 事件。
- 将三类工具状态统一上报给 broker。

Codex adapter:

- Phase 4.1: Codex hooks 上报基础事件。
- Phase 4.2: Codex transcript/session 恢复。
- Phase 4.3: Codex App Server 或 SDK 深度接入。

Claude adapter:

- Phase 4.4: Claude hooks 上报基础事件。
- Phase 4.5: Claude statusline 或 transcript 辅助状态。
- Phase 4.6: Claude stream-json 或 Agent SDK 用于新建受控任务。

Kiro adapter:

- Phase 4.7: Kiro CLI hooks 上报基础事件。
- Phase 4.8: Kiro IDE Agent Hooks 上报事件。
- Phase 4.9: Kiro ACP 托管新会话。

验收标准：

- 至少 Codex 和 Claude 能在真实 CLI 会话中上报状态。
- Kiro 至少能通过 hook 或手动模拟进入统一状态表。
- 用户能在真实开发工作流中看到状态变化。

### Phase 5: Hook-to-Obsidian Bridge MVP

目标：

- 让 overlay 保留悬浮状态监控和窗口跳转，同时拉起一个本地 bridge server 作为 hooks、Obsidian vault、canvas flow 和 CLI sync-back 的中转。
- hook/adapter 部署改为手动 workspace enrollment：用户先选定项目文件夹，AMO 根据文件夹内容识别可用 CLI/TUI 接入方式，再写入项目本地配置。
- 部署流程必须尽量脚本化和确定性，不依赖 LLM 临场判断；扩展新 CLI/TUI 时通过 adapter deployment registry 和维护文档完成。
- 每个已部署工程文件夹创建项目本地 `.amo/`，用于保存 workspace 配置、adapter 配置、本地状态、日志和专属 Obsidian vault。
- 使用已验证的 Codex `Stop` hook MVP，把 `last_assistant_message` 缓存并转发给 AMO bridge。
- 使用已验证的 Obsidian `[!anno]...[/anno]` 插件 MVP，在 Markdown 中批注长回复并一键提取批注。
- 第一版闭环是：用户选定工作区 -> AMO 检测并安装项目本地 adapter/hook -> adapter 捕获回复 -> bridge 写 Obsidian note/canvas -> 用户在 Obsidian 批注 -> plugin 发送批注到 bridge -> overlay 复制 prompt 并聚焦目标 CLI。

核心能力：

- 点击切换窗口
- hook-only 状态标记
- 手动 workspace inspect/enroll
- 部署计划 inspect / apply / repair / uninstall
- `.amo/` workspace state 和专属 Obsidian vault
- Codex reply note 生成
- append-only Obsidian canvas flow
- `Open Note` / `Open Canvas`
- `Copy Pending Prompt + Focus CLI`
- Obsidian annotation extraction bridge

完整目标工作流：

1. 用户开启 monitor。
2. 用户点击一键部署并选择工程文件夹。
3. AMO 通过脚本 inspect 文件夹状态，展示可部署 adapter、将写入的文件、风险和缺口。
4. 用户勾选 adapter，目标支持 Codex CLI、Codex App、Claude CLI、Kiro IDE。
5. AMO 创建 `.amo/` 和专属 Obsidian vault，安装项目本地 hook/adapter。
6. 用户从 monitor 拉起 CLI/TUI，或手动启动。
7. CLI/TUI 完成一轮回复后触发 hook/adapter。
8. hook/adapter 向 bridge 提供最后回复、session/cwd/turn metadata 和可选 window hint。
9. monitor task card 显示窗口绑定、任务状态、CLI 类型和操作按钮。
10. 用户可直接跳回 CLI 处理继续输入或权限请求。
11. 用户可跳到 Obsidian work canvas；若未绑定，则创建或选择 work canvas 并绑定。
12. Bridge 创建 reply note，并把 note 作为 file node 插入 work canvas。
13. 单个 work canvas 可关联多个 CLI/TUI 窗口。
14. 用户通过 Obsidian 插件添加 `[!anno]...[/anno]` 批注。
15. 插件汇总批注并发送给 bridge。
16. Bridge 生成 pending prompt，复制并聚焦目标 CLI。
17. 如果 work canvas 关联多个 CLI/TUI，插件或 monitor 提供多 CLI 快捷跳转。

身份模型：

- `workspaceId`：选定工程文件夹和 `.amo/` 状态。
- `agentInstanceId`：一个 CLI/TUI 进程或窗口实例。
- `sessionId`：工具自身会话 id。
- `workCanvasId`：Obsidian canvas 绑定 id。
- `replyNoteId`：一次 assistant 回复生成的 note。
- `pendingPromptId`：一次批注汇总后的回传 prompt。
- `windowHint.pid/hwnd/titleToken`：只做窗口路由 hint，不做长期主键。

安全规则：

- MVP 不做自动审批。
- MVP 不自动粘贴、不自动按 Enter、不自动发送 prompt。
- shell 执行能力默认关闭。
- 所有高风险操作必须在 UI 中标记。
- Phase 5 不做全局 hook 部署。
- hook/adapter 安装必须从用户选定的项目文件夹开始，并且默认只写入该文件夹下的项目本地配置。
- AMO 必须根据文件夹内容选择或建议 adapter；不要假设所有 CLI/TUI 都有同一种 hook 机制。
- 部署必须先生成计划再 apply，且要支持修复、禁用、卸载和配置备份。
- 不能把 hook runner pid 当成窗口 owner pid；PID/HWND 必须作为经过验证的 window hint 使用。
- hook 必须短、快、stdout 协议干净；失败时不能阻塞 Codex。
- vault 写入必须限制在配置的 vault root 内。

验收标准：

- overlay 启动或确认 bridge server 可用。
- 用户能手动选择一个项目文件夹，AMO 能展示检测到的本地 adapter/hook 方案。
- AMO 能创建 `.amo/` 和专属 `.amo/obsidian-vault/`。
- Codex `Stop` hook 或等价项目本地 adapter 能同时写本地 cache 兜底并 POST `/api/replies`。
- bridge 能在测试 vault 中创建 reply note，并在 canvas 中追加 file node。
- overlay session 卡片能打开关联 note/canvas。
- Obsidian 插件能提取 `[!anno]...[/anno]` 并 POST 到 bridge。
- overlay 能显示 pending continuation，并完成 `copy + focus target CLI`。

当前 MVP 工作流：

1. 只支持 Codex CLI adapter。
2. 只支持一个手动选择的工程文件夹。
3. `.amo/obsidian-vault/AgentFlow.canvas` 是唯一默认 work canvas。
4. Codex `Stop` hook 捕获最后回复并 POST `/api/replies`。
5. Bridge 写 `.amo/obsidian-vault/Replies/` 下的 reply note。
6. Bridge 把 reply note 追加到 `AgentFlow.canvas`。
7. Overlay task card 提供 `Focus CLI`、`Open Canvas`、`Open Note`。
8. Obsidian 插件发送批注，bridge 生成 pending prompt。
9. 用户点击 `Copy + Focus CLI`，然后手动粘贴/发送。

Note/canvas tab 复用规则归 Obsidian 插件阶段处理：如果目标 note/canvas 已打开则聚焦既有 tab，未打开才新建 tab。Overlay 的 `obsidian://open` 只作为当前 fallback，不继续在 URI 层堆精确 tab 控制。

当前 MVP 暂不做：

- Codex App 直接接入。
- Claude CLI reply capture。
- Kiro IDE 部署。
- 多 CLI canvas 快捷跳转。
- 权限请求 task card 托管。
- 自动粘贴、自动发送或自动审批。
- 用户既有 Obsidian vault 的深度集成。
- 复杂 canvas 布局和重排。

### Phase 6: 长期增强

长期增强方向：

- Session 历史和搜索
- 项目分组，例如 Mecho / project_mining / CommonProject
- 多显示器位置记忆
- Workspace profile，一键打开某套 agent 工作区
- 通知策略：轻提示、强提醒、免打扰
- 权限审批面板
- Codex App Server 深度状态：plan、diff、token、review
- Claude SDK/stream-json 深度状态
- Kiro ACP 托管任务
- 插件化 adapter：Gemini CLI、OpenCode、Cursor、Windsurf、Aider
- 手机/局域网只读查看
- 任务摘要和日报
- 与 Mecho/Ruflo/agent workflow 文档系统联动

#### Obsidian Workflow Boundary

这个方向现在进入 Phase 5 bridge MVP，但仍然是 sidecar workflow，不是 AMO 的主数据模型。

边界要求：

- Agent Monitor Overlay 负责 session 聚合、窗口跳转、显式用户动作和安全门。
- Obsidian 插件负责 vault-native note/canvas 变更、注释模型和汇总。
- 本地 bridge server 负责把 hooks、reply notes、canvas flow、annotation payload 和 overlay session state 接在一起。
- 第一版 sync-back 应优先 `copy + focus target session`，不要直接自动发送。
- 不要把 Obsidian/canvas 变成当前项目的主数据模型；它们是 sidecar enhancement。

长期不优先：

- 云端账号系统
- 团队协作 SaaS
- 远程执行高权限命令
- 一开始就做完整 Kanban
- 一开始就做复杂 agent 编排平台

## 7. 第一版 MVP 范围

第一版只做：

- 本地 broker
- mock events
- Tauri 悬浮窗
- session 列表
- 状态点
- 点击切窗口
- Codex / Claude 至少一种真实 hook 接入
- Kiro 先允许 mock 或 hook 验证

第一版不做：

- 自动审批
- 云同步
- 多用户
- 远程控制
- 完整历史搜索
- agent 自动调度
- 复杂任务看板

## 8. 第一批任务拆分建议

### Task A: Window Routing Spike

目标：

- 验证 Windows 上如何稳定找到并激活 Codex / Claude / Kiro 窗口。

Owner:

- worker-window-routing

产出：

- `docs/window-routing-notes.md`
- 3 种窗口匹配方案对比
- 推荐方案和失败兜底

### Task B: Broker Skeleton

目标：

- 实现本地 broker 的最小服务。

Owner:

- worker-broker

产出：

- broker 源码
- mock event API
- session list API
- 本地验证命令

### Task C: Overlay UI Prototype

目标：

- 实现 Tauri 悬浮窗原型。

Owner:

- worker-overlay-ui

产出：

- Tauri app
- mock session UI
- always-on-top / frameless / draggable 验证

### Task D: Codex/Claude Hook Spike

目标：

- 分别验证 Codex 和 Claude 的 hook 能否把 session_id、cwd、event、transcript_path 上报给 broker。

Owner:

- worker-tool-adapters

产出：

- hook 配置示例
- hook 上报脚本
- 真实 CLI 事件样例
- 接入风险

### Task E: Supervisor Integration

目标：

- 主管 agent 汇总 Task A-D，决定 Phase 2/3 的正式实现路径。

Owner:

- supervisor-agent

产出：

- 阶段汇报
- 用户验证清单
- 下一阶段任务卡

## 9. 当前状态

```text
Project: Agent Monitor Overlay
Location: D:\Projects\commonproject\agentmonitoroverlay
Current phase: Phase 5 Hook-to-Obsidian Bridge planning
Status: runnable overlay/broker prototype plus validated external hook and Obsidian annotation MVP inputs
Created: 2026-05-07
Updated: 2026-05-13
Owner role: user validates vibe and requirements only
Execution role: supervisor agent manages workers
```

已完成：

- 市场类似产品初步调查
- 官方接入能力初步判断
- 项目协作模式定义
- 阶段路线定义
- Task A-D 第一轮 spike 已完成并由主管本地复验
- broker MVP 已实现并通过隔离验证
- Tauri overlay 原型已实现，React build 和 Rust cargo check 已通过
- broker CORS 已修正，Tauri/WebView 能读取 live broker 数据
- 工具图标、attention 排序、header 拖拽、窗口激活反馈已进入 overlay
- Claude live hook smoke 已通过；Codex / Claude / Kiro adapter 合同验证已通过
- GitHub remote 已配置，阶段分支和 `master` 交接分支已推送
- 用户在 `D:\Projects\CommonProject\obsidianplugintest` 跑通了两个可对接 MVP：
  - Codex `Stop` hook 读取 `last_assistant_message` 并缓存为 Markdown/JSON note。
  - Obsidian `Markdown Annotation Tools` 插件支持 `[!anno]...[/anno]` 渲染、包裹选区、追加批注和复制批注。
- Phase 5 bridge 设计已整理到 `docs/amo-obsidian-bridge-mvp.md`。

当前已由用户 smoke 验证：

- 原生悬浮窗可以出现
- header 显示 `broker live`，mock `NoHeartbeat` fallback 不再出现
- 工具图标识别基本可接受
- header 拖动会移动悬浮窗
- Codex/Mecho 窗口跳转可用
- Claude demo 在只有一个匹配目标窗口时可跳转
- 两个重复 Claude demo 窗口会被判定为 ambiguous，这个拒绝跳转是当前预期行为

仍未完成/缺口：

- row handle 目前只保留为视觉占位，卡片拖拽已经临时停用，不再作为当前 Phase 3/4 closeout gate
- 重复窗口/ambiguous routing 已经有候选/debug 面板，但还需要在真实 session 上继续验证 exact-route 与回退解释性
- Codex live hook 路线已实现项目本地 enroll、Stop reply capture adapter、bridge `/api/replies`、reply note 和 canvas append；仍需用真实 Codex CLI session 做端到端 smoke。
- Kiro 仍处在 mock/hook-spike 级别
- 卡片顺序和 overlay 位置目前是本地 UI 状态，尚未决定是否持久化
- AMO bridge 已实现 `/api/replies`、vault note 写入、canvas append、`/api/obsidian/annotations` pending prompt 和 `/api/sync-back` 标记；Obsidian 插件本体和插件侧 note/canvas tab 复用仍未实现。

下一步建议：

1. 用真实 Codex CLI session 验证 project-local Stop hook -> `/api/replies` -> overlay task card。
2. 验证 `Open Note` / `Open Canvas` URI fallback 的可用边界；精确 tab 复用留到 Obsidian 插件阶段。
3. 给 Obsidian 插件新增显式 `Open AMO note/canvas with tab reuse` 和 `Send current note annotations to AMO` 命令。
4. 将插件部署纳入 workspace enroll，安装到 `.amo/obsidian-vault/.obsidian/plugins/`。
5. 做端到端 smoke：reply note -> canvas -> annotation -> pending prompt -> `Copy + Focus CLI`。

当前主管状态：

- 稳定/交接分支：`master`
- 阶段 checkpoint 分支：`phase/1-2-spikes`
- remote：`origin https://github.com/kadhygh/AgentMonitorOverlay.git`
- 任务卡目录：`docs/tasks/`
- 主管状态板：`docs/supervisor-status.md`
- 第一轮 spike：Task A-D 已完成并由主管本地复验
- 第一轮 vibe：用户已确认通过，小细节后续再调
- 悬浮窗 smoke：用户已确认 overlay 出现、broker live、无 mock fallback、header drag、Codex/Mecho 跳转、Claude 单目标跳转
- Overlay 交互优化：card 拖拽排序已改为 window 级 pointer 监听，用户确认拖拽丝滑；列表过长时改为内部滚动，resize handle 保持可达。
- 后续设置项：把窗口 resize 能力做成 settings toggle。默认隐藏 resize 边界指示器且不允许改 size；只有 toggle 激活后才显示底边/右边/右下角 resize handle 并允许调整窗口大小。
- 部署入口：overlay 已有紧凑 deploy panel，点击部署图标会打开 Windows 文件夹选择器，选定 workspace 后执行 inspect/enroll；后续要增加 settings 入口。
- 后续部署 UX 优化：把 deploy panel 做成更清晰的分步流程，明确 `Check` 是只读检测、`Deploy` 才会写入文件，并补充部署历史、repair/disable/uninstall、adapter 选择和风险预览。
- 真实 hook live smoke：Claude 已通过；Codex provider 可运行，但 hook 加载路径仍待验证；adapter->broker 合同验证已通过
- 新阶段方向：Obsidian workflow integration 已由两个外部 MVP 证明可进入 Phase 5 bridge 主线，但仍保持 sidecar 边界。

## 10. 给下一位主管 Agent 的启动提示

```text
你现在是 Agent Monitor Overlay 项目的主管 agent。

项目路径：
D:\Projects\commonproject\agentmonitoroverlay

先阅读：
DEVELOPMENT.md
docs/supervisor-status.md
PROJECT_PLAN.md
docs/amo-obsidian-bridge-mvp.md
docs/adapter-deployment-guide.md
docs/reference-mvps/obsidianplugintest/README.md
外部 MVP 文档：
D:\Projects\CommonProject\obsidianplugintest\docs\CODEX_REPLY_NOTE_HOOK_INTEGRATION.md
D:\Projects\CommonProject\obsidianplugintest\docs\OBSIDIAN_ANNOTATION_PLUGIN_DEVELOPMENT.md

用户角色：
用户只负责验证、vibe 判断、需求细节确认。不要让用户承担任务拆分、worker 协调、实现审查、冲突合并。

你的职责：
你是唯一对用户汇报的角色。你需要拆分任务、调度 worker agent、汇总结果、维护计划状态，并在每个阶段给用户清晰的验证项和需要确认的问题。

当前阶段：
Phase 5 Hook-to-Obsidian Bridge planning / implementation prep。

优先任务：
1. 从 `master` 开始，不要退回旧的 Phase 0 结论。
2. 保留 overlay 悬浮窗、broker session 状态和 CLI window focus 能力。
3. 不做全局 hook 部署；接入从用户手动选择项目文件夹开始，根据文件夹内容选择项目本地 adapter/hook。
4. 复用现有 Node broker，把它升级为 AMO bridge；第一步实现脚本化 workspace inspect/enroll 和 `/api/replies`。
5. 当前 MVP 只支持 `codex-cli`，创建项目本地 `.amo/` 和 `.amo/obsidian-vault/AgentFlow.canvas`。
6. 使用外部 Codex Stop hook MVP 的 `last_assistant_message` capture 思路，保持 hook stdout 只输出 `{"continue":true}`，并保留 `.codex/cache/` 兜底。
7. 使用外部 Obsidian plugin MVP 的 `[!anno]...[/anno]` 语法；第一版只做显式提取和发送，不做复杂 anchored comments。
8. Obsidian 插件阶段接管 note/canvas 打开与 tab 复用：已打开则聚焦，未打开才新建 tab。
9. Sync-back 第一版只做 `copy + focus target CLI`，不要自动粘贴、自动回车或自动审批。

汇报格式：
当前阶段：
本轮完成：
需要你验证：
需要你确认：
下一步计划：
风险/阻塞：
```
