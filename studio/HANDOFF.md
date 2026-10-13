# 交接：继续开发 AMO Studio（2026-10-13）

给下一个会话看的起点。先读这份，再按需读下面列出的文件。

## 1. 在哪、怎么跑

| 项目 | 内容 |
|---|---|
| 开发目录 | `G:\PROJECT\AgentMonitorOverlay-studio\studio`（git worktree） |
| 分支 | `studio/main`，最新 `c70d51b`。**没有合并到 master，没有推送**；master 仍在 `ac93b81`（等用户决定，见 NEEDS_YOU S8-07） |
| 主仓库 | `G:\PROJECT\AgentMonitorOverlay`，停在 `chore/next-gen-planning-2026-10`；里面的 `overlay/src-tauri/Cargo.toml` 只有换行符改动，**不要碰** |
| 开发版 | `npm start`（先 build 再开窗口），数据在 `studio\.data`。Host 常驻在 47900 端口；改了 Host 代码要先 `npm run host:stop` 再 `npm start` |
| 帮用户重启开发版 | `npm run build` → `npm run host:stop` → 结束 `electron.exe packages/app` 主进程 → `Start-Process node_modules\electron\dist\electron.exe packages/app`（工作目录 `studio`） |
| 验证 | `npm run verify`（typecheck + vitest + build）；端到端 `npx playwright test -c e2e/playwright.config.ts`（约 11 分钟，先确保 build 过） |
| Portable | **不要每次都打包**，只在用户确认的发布节点打（LOOP_RULES 第 6 节） |

## 2. 规则（摘要，全文见 `LOOP_RULES.md`）

- 不碰旧 AMO 的运行时和 `broker/data/`；不改主目录文件；不改 `~/.codex/config.toml`、`~/.claude/` 设置、用户已有的凭据条目（Studio 只写一个：`claude-subscription`，由用户在设置里保存）。
- 测试只在 `%TEMP%\amo-studio-sandbox\` 和临时目录；端口只用 47900–47999；测试窗口不抢焦点、不开终端/浏览器、不碰剪贴板。
- Git 只在 studio 分支上提交；不合并 master、不推送、不 reset --hard、不删分支。
- 密钥不打印、不写日志/文件/命令行。
- **真实模型额度**（`budget.json`，用 `spikes/lib.mjs` 的 `countTurn(note, provider)` 先计数再调用）：DeepSeek 29/1000、GLM 28/5000、**GPT 订阅 6/50、Claude 订阅 0/50**（后两项是用户 2026-10-13 批准的，只用来验证这两种模型在 Studio 里能用）。平时测试用 mock。
- 工具坑：heredoc 里的 Python 会吃掉 `\n`、`\v` 等转义 → 有转义的改动用 Edit/Write 或 scratchpad 里的 `.py` 文件；Windows 文件名不分大小写（`Transcript.tsx` 和 `transcript.ts` 会撞）；跑完 e2e 用 `git checkout -- studio/screenshots/stage-*` 丢掉无意的截图变化；清理 `%TEMP%\amo-studio-test-*`、`amo-studio-e2e-*`。

## 3. 这次会话做完的事（都已提交到 studio/main）

详见 `plans/stage-9-chat.md` 和 `spikes/RESULTS.md` 的 s9-00 … s9-06。

1. **浅色主题、设置弹窗、公共空间、机器人图标**（`3f939fe`、`61bf28a`）。
2. **对话体验对齐 DSH**（`a614071`）：按"轮"组织；工作过程（思考、工具）折叠成"已完成，用时 …"；组标题按类别汇总、运行中流光；思考行；工具行展开为终端 / diff / 输入输出卡片；页脚（复制、时间、用量）；运行指示；圆角输入框和会话统计；回到底部；设置 → 工作步骤展示（简洁/标准/详细/完全展开，默认标准）。
   - Host 侧：`turn` 条目（时间、状态、用量）、`reasoning` 条目、更丰富的 `tool` 条目（kind、输入、退出码、耗时、diff）、命令输出流式、Windows 上按命令识别读/搜/列。Codex app-server 加了 `show_raw_agent_reasoning=true`，每个 turn 带 `summary: "auto"`。
   - 代码：`packages/ui/src/chat/`（`turns.ts` 纯逻辑 + 测试、`Transcript.tsx`、`ProcessRows.tsx`、`SessionOptionsBar.tsx`、`OptionsPicker.tsx`）、`styles/chat.css`、`packages/host/src/runtime/items.ts`。
3. **GPT 订阅与 Claude 订阅两个模型配置**（`682c9b7`）：`codex-default` 改名"GPT 订阅"（用户自己的 Codex 登录）；新增 `claude-subscription`（`claude setup-token` 生成的令牌，设置 → 模型凭据里保存，只作为 `CLAUDE_CODE_OAUTH_TOKEN` 传给子进程）。
4. **型号 / 思考强度 / 权限 + 常用预设**（`2ad82c3`）：新建任务、新建会话可选；会话里点输入框左下角切换（Claude 立即生效，Codex 下一轮）；设置 → 常用预设，一键切换。列表来自各 CLI：Codex `model/list`、Claude Code `supportedModels()`、GLM 内置列表。会话表新增 `options` 列（迁移 6）。
5. **帮我审批 + Windows 沙箱修好**（`c70d51b`）：
   - 用户 Codex 配置是 `[windows] sandbox = "unelevated"`；沙箱里命令失败的原因是 Codex 用了 WindowsApps 里的应用商店版 `pwsh.exe`。Studio 启动的 app-server 的 PATH 去掉了 WindowsApps，改用 Windows PowerShell 5，沙箱正常。
   - Codex 权限：逐条询问（**默认**，不进沙箱 + untrusted）/ 帮我审批（= CLI 的 Approve for me：on-request + workspace-write + `approvals_reviewer: auto_review`）/ 需要时询问 / 完全访问 / 工作区可写 / 只读。批准默认一律回到人（`approvalsReviewer: "user"`），只有"帮我审批"交给审查 agent；审查结果显示为"自动审批"行。
   - Claude 权限：每次询问 / 自动接受编辑 / 只做计划 / 全部允许。

## 4. 还没做完 / 等用户的

| 事项 | 状态 |
|---|---|
| Claude 订阅的真实测试 | 等用户运行 `claude setup-token` 并在 设置 → 模型凭据 保存令牌。之后跑 `node spikes/s9-01-subscriptions.mjs claude`（计 claude 1 次），它还会检查令牌有没有泄露进 agent 的命令环境（期望 `TOKEN-HIDDEN`）；保存令牌后 Claude 订阅的型号列表会来自 Claude Code 本身 |
| NEEDS_YOU 里 5 项"必须等你" | 合并 master（S8-07）、切换日常工具与删除旧 AMO（S3-10）、是否开放派发（S5-10）、第一个扩展包（S6-09）、调度权限与频率（S7-09）。用户说暂时没空处理，不要催 |
| 用户暂缓的 | 扩展包 `.amo/packs/` 的实际用法（做到时再说）；清理旧 AMO 在工程里部署的 Hook（用户先体验新版） |
| DSH 对齐里没做的 | 轮次导航轨道、从某一轮分支对话、图片附件、文件链接在侧栏打开、上下文压缩行 |
| 可选 | "彻底退出 Host"按钮（Portable）、`npm run dev:studio` 一键热更新脚本 |

## 5. 已知问题

- `packages/host/src/runtime/codex/server-manager.test.ts` 的"停止并释放端口 / 崩溃后同端口重启"在完整并行跑时偶发失败（端口释放慢），单独跑通过。记录在 `plans/maintenance.md`，不是功能问题。
- 端到端里 Claude 的 mock 配置没法向 Claude Code 要型号列表（会超时），所以测试模式给 mock 配了内置列表（`packages/host/src/bin.ts`）。
- 去掉 WindowsApps 后，Studio 里 agent 的命令用不到应用商店版的 `pwsh`、`python3`、`winget`（本机 `python`、`node`、`git` 不受影响）。
- 用户自己的 Codex CLI 可能也会遇到"应用商店版 PowerShell 在沙箱里起不来"的问题；没有改用户的 `~/.codex`。

## 6. 重要文件

| 文件 | 内容 |
|---|---|
| `LOOP_RULES.md` | 红线、额度、关卡 |
| `STATUS.md` / `NEEDS_YOU.md` | 状态、等用户的事项 |
| `plans/stage-9-chat.md` | 本次会话的计划与追加记录 |
| `spikes/RESULTS.md` | 所有实测结论（s9-00…s9-06 是本次的） |
| `plans/maintenance.md` | 遗留小问题与暂缓事项 |
| `design/architecture.md`、`README.md` | 架构、用户指南 |
