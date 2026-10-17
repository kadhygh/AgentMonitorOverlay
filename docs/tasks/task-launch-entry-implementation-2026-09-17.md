# 独立任务启动入口：第一轮实现

## 第二轮：视觉与布局（2026-09-17）

用户实际试用反馈“能够正常拉起任务”，同时要求重做视觉。真实拉起成功属于用户反馈，不等于所有登录/信任、终端种类和失响应情形已实测。

本轮集中修改TaskLaunchApp展示与局部CSS，不改启动、Card绑定、首问传递或重试逻辑：去掉嵌套大卡片的外壳，使用轻量窗口标题；工程与分支形成一行上下文，首问为主输入区域；模型与Run位于同一行，高级参数在宽窗右侧、窄窗下方；回执用三步事实进度和操作区展示，不把Session接入称为首问执行成功。启动器纳入AMO明暗主题广播，模拟页增加明暗切换。

构建通过；完整隔离启动smoke通过，产物 `tmp/task-launch-preview-HmX1Bo`，页面错误为0。额外视觉检查覆盖明暗、360px展开无横向溢出、正常Run回执，产物 `tmp/launcher-redesign-qa/`。新的隔离体验页 `http://127.0.0.1:1097/`（CLI/凭据/原生均模拟），数据 `tmp/task-launch-preview-5vUIwf`。未重启真实AMO，没有自动启动真实任务。

日期：2026-09-17。依据：[已确认交互与任务方向](managed-codex-first-prompt-focus-2026-09-14.md)。

工作分支 `codex/task-launch-entry`，隔离目录 `G:/PROJECT/AgentMonitorOverlay/tmp/worktrees/task-launch-entry`，基线 `a20295b`。主目录有模型/provider配置等其他未提交工作，本轮没有复制或修改它们。实现未提交、未合入主线、未 push。用户要求重启体验后，已于2026-09-17 16:24（香港时间）从本worktree启动真实本机体验实例，沿用原生产数据；见下方运行记录。

## 交付范围

这一轮只贯通新入口及其启动关联，不改旧主窗口 TaskCard 布局、旧工作区启动入口、priority、Canvas 或归档生命周期。

原生入口位于托盘菜单 **新任务…**，打开独立非模态 `task-launch` 窗口（可在任务栏找回）。默认紧凑显示工程副本、当前分支、首问和模型；首问为空时按钮是“打开 CLI”，非空时为“Run”。展开后有标题、思考强度、Focus 分组、启动后去向、记忆副本配置和应急预留标记。快捷键 Ctrl/Command+Enter；展开收起保留内容。

工程列表只读取已注册位置，不扫描磁盘；未完成 Codex 接入的副本不能受管启动，并可返回旧工作区中心接入。分组必须来自现有 Focus 注册表，没有默认造组。已有记忆失效时明确要求重选。

应急预留目前是新入口按本地副本路径保存的偏好，需要用户标记并逐次确认使用；不是全局工程占用系统，不从空闲 Session 推断可用性。不切分支、不建 Unity worktree、不合并代码。

模型与凭据复用已提交的 provider 路由。官方默认选项沿用本机 Codex 配置；其他预设沿用各自模型设置。API Key 只在本次请求和启动环境中传递，不写入 Card/launch 配置、日志或前端草稿。

## 启动与身份

- 新增内置受控 `amo.launch` 组件保存稳定 operationId、launchId、工作区身份、首问、非秘密模型设置及有界重试记录。它是启动关联元数据，真实执行仍由 Session/LaunchStore 提供，不复制一套 TaskStore。
- 受管 Launch 创建后、终端派发前，在 CardStore 的同一 writer 中保存新 Card（launch/processing/notes/group 组件）。此时没有伪造 Session。
- 首个真实 owner Session 按 launchId、工作区 ID/规范化路径、框架和 owner 关系绑定。绑定与默认来源索引更新发生在同一次 CardStore 观察事务中，早到 Hook 不会先生成另一张默认 Card。子会话/外来工作目录不能抢占绑定。
- 通用接口不能伪造、覆盖或删除受控 launch 组件。等待接入期间移除 processing、改变源或填满组件等情况不会导致整个观察队列失败，也不会擅自补回用户移除的关联。
- 相同 operationId 的重复请求和重启后重放只返回现有 Card，不重新派发终端或首问。终端返回只证明派发已返回，不证明 CLI 登录、信任流程或模型执行完成。
- 只有底层明确报告 `not-spawned` 的失败才能显式重试；保留 Card、创建新 launchId，重试本身也有持久 operationId。未知结果不提供自动重试。
- 本轮首问状态保守地保持 `unconfirmed`（空问题为 `empty`）。Session 接入不被当作“首问已被模型处理”；尚未接入精确首问确认协议。后续 UI 可根据真实 Session 执行状态继续呈现事实。

## 接口

| 接口 | 用途 |
|---|---|
| GET `/api/task-launch-context` | 已注册副本、当前分支、接入可用性、Focus groups及Review目标 |
| POST `/api/task-launches` | `{operationId,workspacePath,groupId,title?,prompt,codexProvider,reasoningEffort,launchEnvironment?,afterLaunch}`；创建并派发一次 |
| GET `/api/task-launches/:cardId` | 启动回执及真实 Session 关联，不执行任务 |
| POST `/api/task-launches/:cardId/retry` | `{operationId,apiKey?}`；只重试明确未派发的失败 |

状态包括 launching、waiting_session、connected、archived、failed_retryable、unknown。回执不返回原生参数、环境或凭据。Mutation路由要求JSON并复用Card的Origin校验。分支探测最多4并发，总预算4.5秒，超过预算的分支显示未确认；不会悄悄切分支。

前端提交前保存不带凭据的请求身份；本地存储不可用时拒绝派发，避免刷新后无法核对。失响应时只允许显式核对同一请求。刷新和重新显示入口只做GET；隐藏停止回执查询，显示时立即刷新，查询串行且可取消。关闭窗口保留草稿，不结束CLI。

“打开对应 CLI”委托现有主窗口动作 owner，先重新核对 Card/Session/Conversation；只对已经接入的会话提供，委托反馈不冒充聚焦成功。接入前可直接查看已打开的终端，但本轮不猜测无Session目标。

## Windows 首问参数

本机 Codex CLI 帮助确认支持交互式初始 PROMPT。新入口在参数尾部使用 `--` 后传单个首问参数，不采用键盘粘贴或自动按回车。旧启动器没有改变参数行为。

Windows PowerShell 5.1 的普通 native 参数绑定会丢失嵌入引号，本轮为新入口增加 exactArguments 路径：用JSON保留参数、通过 .NET ProcessStartInfo 按Windows规则引用参数后直接启动，保留交互控制台。原生可执行文件和标准npm Codex shim支持；npm shim直接定位同目录Codex JS并用Node启动。任意自定义ps1/cmd包装器暂不保证，错误不会导致自动重发。

首问上限8000字符；实际编码后的Windows命令长度另做派发前检查，超限明确为未启动并提示缩短首问。凭据不进入参数正文。不能把对真实参数传递的验证当作真实模型执行验证。

## 验证与体验

- Broker完整回归 **238/238** 通过，包含开启 `AMO_TEST_NATIVE_ARGV=1` 的Windows参数回显测试；LOCALAPPDATA与数据均隔离到worktree/tmp。
- 前端完整回归 **120/120** 通过；生产构建通过；`cargo check --offline` 通过。没有启动生产原生程序。
- Windows PowerShell 5.1 → 原生Node参数捕获 **12/12** 原样，标准npm shim模拟 **5/5**；覆盖中文/emoji、换行、引号、反斜杠、空参数、前导连字符、`$()`。旧方式对照仅收到9/12参数，修正后注入哨兵没有执行。
- `scripts/performance/task-launch-smoke.cjs` 使用真实React、HTTP路由、任务服务、CardStore、LaunchStore和SessionCollection，只模拟终端/原生/凭据。验证空首问、双击、早到owner Hook、延迟接入、同Card绑定、提交响应丢失、页面刷新无重发、未知结果保护、明确失败重试、无组和错误副本。截图覆盖360/610/760。
- `scripts/performance/task-launch-preview.cjs` 提供安全可交互体验。三个工程副本和Work/Review组都是临时fixture；顶部场景选择器不是产品控件。所有请求走本地同源，不能访问生产Broker，也不会调用真实CLI/API。`--check`只验证启动与隔离后退出。

运行预览：`node scripts/performance/task-launch-preview.cjs`。运行smoke需设置 `AMO_PLAYWRIGHT_MODULE` 为已有Playwright模块路径。输出都保存在worktree下tmp目录，不随Git同步。

本轮最终smoke产物：`tmp/task-launch-preview-BEB9SE/evidence.json`，页面错误为0。可从“查看 Focus”切换到真实FocusPanelApp，读取同一CardStore；返回入口保留回执且不再次派发。当前留下的最终体验页为 `http://127.0.0.1:9602/`，临时数据目录 `tmp/task-launch-preview-MN0hWl`。该地址随服务进程退出失效；下次运行runner会创建新的独立数据。

构建与回归日志：`tmp/task-entry-build.log`、`tmp/task-entry-runtime-tests.log`（120/120）、`tmp/task-entry-broker-tests.log`（238/238，含启用原生argv测试）。Windows标准npm shim的额外回显审计脚本保留在 `tmp/prompt-transport-audit/`，属于本机产物，不随Git同步。

## 下一轮由使用反馈推进

先审核入口体验：选择副本、紧凑/展开、首问、分组和回执是否顺手。需要调整时在新入口内迭代，不同步重做旧界面。

未验证：真实Codex登录/信任/首问执行、真实终端自动聚焦、不同terminal及自定义安装方式、原生托盘入口实际点击。未对真实任务发送任何消息。用户本机体验实例已启动，但不能视为真实CLI任务验证完成。

## 本机体验实例（2026-09-17）

用户要求“重启amo，我体验一下”后，先完成本worktree前端与原生构建，再替换旧AMO的窗口、前端和Broker进程。主目录代码未合并、未覆盖，正在进行的模型路由改动保持原样。本次运行模型路由采用worktree基线，不包含主目录未提交的provider更新。

- 源码：本worktree。可执行文件：`tmp/trial-runtime/agent-monitor-overlay.exe`，使用编译好的开发原生程序；前端以Vite preview提供，无Tauri文件监听器。
- 数据：`G:/PROJECT/AgentMonitorOverlay/broker/data/`，Session/Card/workspaces/launches/canvas均显式指定为原数据路径。
- 切换前备份：主目录 `tmp/task-entry-data-backup-20260917-162433/`。
- 运行信息及日志：本worktree `tmp/trial-runtime/deployment.json`、`app.err.log`、`broker.*.log`、`vite.*.log`。
- 检查：原生启动达到interactive/firstVisibleFrame；Broker healthy，保留149个Session；新task-launch-context接口成功返回4个已注册副本、3个分组。没有点击Run或执行真实首问。
- 入口：系统托盘AMO菜单中的“新任务…”。此处Run是真实启动；浏览器隔离体验页仍为模拟，两者须区分。

本次启动未更改机器的主目录launcher配置。桌面原Source快捷方式仍可能切回主目录旧源码；继续此轮时先核对进程路径，避免把主目录HEAD当成当前运行版本。

仍待进一步设计：启动前卡片在Focus详情的专用启动状态展示、精确首问处理确认、启动结果未知时的恢复核对、多工作副本共享身份/占用、任务完成/归档语义。第一轮没有宣称完整生命周期管理已经完成。
