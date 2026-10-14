# 交接：继续开发 AMO Studio（2026-10-14）

给下一个会话看的起点。先读这份，再按需读下面列出的文件。

> **2026-10-14 深夜更新：阶段 13 验收 22/23 通过（A5 有问题），阶段 14 三条线做完并合进 `studio/main`，等用户重启开发版后验收。** 计划、用户决定和每条线的做法在 `plans/stage-14.md`；记忆 `studio-stage14-decisions`。合并后单测 538/539（失败的是已知不稳定的 server-manager 端口测试，单独跑通过），e2e 82/83（questions 计划审阅在负载下偶发，已加固测试 `4cbb346`，单独跑通过）。
> - S14-A：A5 草稿存在窗口级 `gitreview/drafts.ts`、切换后按锚点滚回（`gitreview/anchor.ts`）；有总览条时隐藏竖向滚动条；Ctrl+F（查看器两种模式 + Review）、Ctrl+G；查看器文件模式按行批注（`GitCommentRange = GitRange | "file"`，查看器地址带 `session=` 作默认发送对象）。
> - S14-B：设置 → 便签：页数、复制时的换行（常规 / 安全换行，默认常规，kv `scratchpadSafeNewlines`）；便签窗口去掉页数、标题加图标；任务页右栏不再显示便签。
> - S14-C：搜索框（Ctrl+K）；置顶开关（存在外壳 `shell-prefs.json`）；任务页 / 新建任务记住来源（`shell/views.ts` 的 `withOrigin`）；归档任务弹框 + 横幅；已归档会话重新设计。
> - 验收清单同一个链接已换成阶段 14（16 条），结果在 db 集合 `s14`。工作树 s13-*、s14-* 都还在，等用户同意再删。开发版还没重启（要问用户时间）。
>
> **2026-10-14 晚更新：阶段 13 全部做完并合进 `studio/main`（`79ceaaa`），等用户验收。** 合并后单测 522/522、e2e 78/78 通过。每条线的做法、查明的原因和取舍都在 `plans/stage-13.md` 进度表；截图 `screenshots/stage-13/`。
> - S13-A 查看器：新窗口 `#viewer?…`（`app/src/viewer-window.ts`、`viewer-rules.ts`、`ui/src/viewer/`），文件模式和嵌入的改动模式；对话里单击文件链接打开它，右键菜单含右栏快速查看、用 git diff 看、标记。固定不能撤销；文件改动后不自动刷新。
> - S13-B：闪烁原因是整份文件一次画出来，改成 64 行一块 + `content-visibility: auto`（真窗口拖动需用户确认）；总览条；「历史」选提交，另开只读的提交窗口（`#review?workspace=…&commit=…`，窗口按 项目@提交 区分）。
> - S13-C：GPT Fast（真实 `model/list`：GPT 订阅各型号都有 id `priority`、名字 Fast 的档，说明因型号而异，见 `spikes/RESULTS.md` s13-00）；批注用 CSS Custom Highlight 只高亮选中文字；Focus 慢的真正原因是 Codex 异步提问要等一轮结束才标「等你回答」，现在问题一到就标。
> - 三个工作树 `G:\PROJECT\AgentMonitorOverlay-s13-{viewer,review,chat}` 还在，等用户同意再删。
> - 开发版已按用户要求在 10-14 19:43 重启（Host 和窗口都是阶段 13 的）。验收清单网页同一个链接已换成阶段 13（23 条，每条有「怎么做 / 期望」），结果在 db 集合 `s13`；阶段 12 的结果仍在集合 `results`。
>
> **2026-10-14 傍晚更新：用户验收了阶段 12（27 通过、5 有问题、4 跳过），开始阶段 13。** 计划和用户的决定在 `plans/stage-13.md`。S13-0（Codex `/G:/` 链接点不开、Review 列表可以拖得更宽、标记按钮显示「已标记」并跳到那条）已提交（`8c62308`）。下一步是三条线：S13-A 查看器（独立窗口，没固定的那个被复用，只有点「固定」才保留；对话里单击文件链接打开查看器，右栏快速查看挪进右键菜单）、S13-B Review 补强（竖向调整窗口闪烁、总览条、提交历史）、S13-C 对话（GPT Fast 开关、批注只高亮选中的文字、Focus 响应慢）。阶段 11、12 的工作树已按用户同意删除，分支保留。验收清单网页：https://claude.ai/artifact/CsZnNKcuGnjQxX7W1XtVr2 （结果在它的 db 集合 `results` 里）。
>
> **2026-10-14 更新：阶段 12 全部做完并合进 `studio/main`，等用户验收。** 计划、调查结果、每条线的做法和取舍都在 `plans/stage-12.md`；截图在 `screenshots/stage-12/`。
> - Review：代码按语言变色（Shiki，`lib/highlight.ts`）、目录树（宽度可拖）、左右对照（用户确认"diff 模式"就是它）、VS Code 打开 / 在资源管理器中显示（Host `features/openin/`）。
> - 对话：Claude 提问和计划审阅能回答了（新条目 `question`、状态「等你回答」）；文件路径能点、右侧快速查看、本轮改动的文件；`/` 命令菜单、上下文压缩行和「压缩」按钮、重试和各类提示、后台命令、工具进度和图片、建议的下一句（**默认关**，每轮多一次模型请求）。
> - 文件标记：独立窗口（标题栏「标记」、Ctrl+Shift+M），`@ 标记的文件`、拖进输入框，迁移 9；agent 可用 MCP `list_file_marks` 读。
> - 标题栏：标记 / 便签 / Focus（图标）在标题行；看板·画布切换和「+ 新任务」在下一行；设置在左栏底部。
> - 顺带修了：Claude 会话的权限模式（只做计划 / 自动接受编辑 / 全部允许）以前要中途切换一次才生效。
> - 五条线在工作树 `G:\PROJECT\AgentMonitorOverlay-s12-{review,questions,chatfiles,marks,cli}` 里并行开发，分支 `studio/s12-*` 保留。阶段 11 的四个工作树也还在，等用户同意再删。
> - 用户数据迁移前备份在 `.data/backup-before-stage12-20261014/`。
> - 撤销某一轮的文件改动：用户 2026-10-14 决定**不做**（平时很少用）。
> - 等用户的：跨窗口真实拖动标记要手动试一次（用户 2026-10-14 开始验收阶段 12）；Codex 的提问只在 Codex 计划协作模式下出现，Studio 没开这个模式。
> - 之后追加 S12-F：Review 提速（diff 一次 git 调用、读过的留着、预读、高亮挪进 Web Worker）和 Fork 样式的文件列表（整条路径、彩色状态方块、文件类型图标，平铺为默认）。详见 `plans/stage-12.md` 进度表。
> - 再追加 S12-G：Codex 的异步提问（`request_user_input_async`，模型目录 `send_user_message_async` 打开）显示成卡片，回答作为下一条消息；崩溃隔离（Host 兜底不退出、会话内错误提示、外壳自动重启 Host、窗口崩溃自动重载、界面错误边界）。**不要在用户使用时重启开发版**：`host:stop` 会停掉正在跑的会话。
> - 又追加 S12-H（决策卡放进会话、对话上方）和 S12-I（设置分页；模型页里 Claude 订阅可选「令牌」或「本机 Claude Code 的登录」，后者要先确认风险，每个会话记住开始时的方式）。
> - 再追加 S12-J 到 S12-N（用户 2026-10-14 的九条反馈）：Claude 额度按 /api/oauth/usage 查（只有本机登录能查，setup-token 没权限）并显示重置倒计时；型号顺序和默认；显示具体型号名；提问卡改弹窗；通用浮动提示 `lib/toast.tsx`；已归档任务入口；速率按 DSH 的方式；Claude 改用 Claude Code 自己的系统提示词（Studio 专属提示词按用户要求撤回，两边都用各自 CLI 的常规方式）；批注气泡。
> - S12-O：Claude 会话改成和终端一样加载 CLAUDE.md、settings、hooks、命令和 skills（`settingSources` 三项都开）；工程里没有 CLAUDE.md 但有 AGENTS.md 时，把 AGENTS.md 加到系统提示词后面（`project-instructions.ts`）。

> **2026-10-13 深夜更新：阶段 11 的六项都做完并合进 `studio/main`，等用户验收。** 计划、用户的决定和每项的做法、取舍都在 `plans/stage-11.md`；截图在 `screenshots/stage-11/`。
> - 画布：引用卡片、每个任务可选是否上画布（**行为变化**：看板里建的专题任务不再自动出现在画布上）、从画布进出返回画布、空分组删不掉的 bug（原因是画布里有已归档任务的卡片）。
> - 对话：粘贴/拖入图片和文件、`@` 分组（任务/会话/最近文件/找文件）、Ctrl+P 找项目文件。
> - 便签小窗：全局快捷键 Ctrl+Alt+Space，多页、可贴图。Git Review：独立窗口，逐行批注发给会话（迁移 8）。速度 tok/s 和上下文占用。
> - 四条线是在工作树 `G:\PROJECT\AgentMonitorOverlay-s11-{canvas,attach,scratchpad,gitreview}` 里由子 agent 并行开发的；分支 `studio/s11-*` 保留，工作树可以在用户验收后删除。
> - 用户数据迁移前备份在 `.data/backup-before-stage11-20261013/`。
> - 已知：高负载下 e2e 偶尔在关闭应用时超时（测试本身已通过），空闲时全量 60/60 通过。

> **2026-10-13 晚更新：阶段 10 的界面改版和反馈都做完了，模块化重构也做完并合回了 `studio/main`（`4826929`）。**
> - 阶段 10：组织结构 v2、编辑部风格界面、草稿任务页、改名、@ 任务、左栏置顶和折叠、订阅用量都已提交到 `studio/main`（最后是 `a847158`，新图标"取景框"）。剩下的见 `plans/stage-10.md`（S10-06 专题页、S10-08 留言实测、S10-09 草稿区）。
> - 重构：用户同意 `design/architecture-review-2026-10.md` 的 R1–R4，文末"实际做法"写了结果。**代码现在按功能分目录**：Host 在 `packages/host/src/features/<名字>/`（`service.ts`、`routes.ts`、`mcp.ts`），清单 `features/index.ts`；界面在 `packages/ui/src/<名字>/`（页面、`view.tsx`、样式），清单 `ui/src/features.ts`，样式顺序在 `main.tsx`。设置 → 功能 可以关掉扩展包、整体待办与调度。
> - 重构由用户同意直接合回（2026-10-13），用户之后自己验证，有问题再改。分支 `studio/stage-11-modules` 保留未删。
> - 图标源文件 `design/icon/viewfinder.svg`，改完运行 `node scripts/make-icons.mjs` 生成应用、窗口和 exe 图标。

## 1. 在哪、怎么跑

| 项目 | 内容 |
|---|---|
| 开发目录 | `G:\PROJECT\AgentMonitorOverlay-studio\studio`（git worktree） |
| 分支 | `studio/main`（阶段 12 合并后）。**没有合并到 master，没有推送**；master 仍在 `ac93b81`（等用户决定，见 NEEDS_YOU S8-07） |
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
| DSH 对齐里没做的 | 轮次导航轨道、从某一轮分支对话（图片附件、文件链接、上下文压缩已在阶段 11/12 做了） |
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
