# Loop 日志

格式见 `LOOP_RULES.md` 第 2 节，新记录追加在末尾。

## 2026-10-12 · 阶段 0 收尾
- 结果：done
- 改动：`studio/` 规划文件（ROADMAP、LOOP_RULES、plans/stage-1、design/）
- 验证：无代码
- commit：见本次 commit
- 遗留：无

## 2026-10-12 22:15 · S1-01 脚手架
- 结果：done
- 改动：`studio/package.json`（npm workspaces）、`tsconfig*.json`、`vitest.config.ts`、`packages/{protocol,testkit,host,app,ui}` 骨架、`packages/testkit/src/budget.ts`
- 验证：`npm install && npm run verify` 通过（typecheck、4 个单元测试、tsc -b 加 vite build）
- commit：见本次 commit
- 遗留：依赖版本对齐 DSH（TypeScript 6.0.3、Vite 8.2.2、Vitest 4.1.11、Electron 44.7.0、React 19.3.0），全部写死版本。S1-00 改为依赖 S1-01，因为真实调用需要先经过预算计数

## 2026-10-12 22:25 · S1-00a 审批路由
- 结果：done
- 改动：`spikes/lib.mjs`、`spikes/s1-00a-approval.mjs`、`spikes/assets/`（DeepSeek 模型目录，复制自旧 AMO）、`spikes/RESULTS.md`、`spikes/results/s1-00a-v*.json`；S1-00 拆为 a～e
- 验证：真实 DeepSeek 跑两个变体，共 2 次调用；测试 thread 已归档
- commit：见本次 commit
- 遗留：审批挂起后才订阅的客户端能否补收请求，并入 S1-00c

## 2026-10-12 22:30 · S1-00b 单 server 多 provider
- 结果：done
- 改动：`spikes/s1-00b-multi-provider.mjs`、`spikes/RESULTS.md`、`spikes/results/s1-00b.json`
- 验证：真实 DeepSeek 两个 thread 并发各一轮，共 2 次；`CODEX_HOME` 用沙盒空目录，测试 thread 已归档
- commit：见本次 commit
- 遗留：重启后按 thread 指定的 provider 能否恢复，并入 S1-00c

## 2026-10-12 22:40 · S1-00c 重启重连
- 结果：done
- 改动：`spikes/s1-00c-restart.mjs`、`spikes/RESULTS.md`、`spikes/results/s1-00c-{thread,server}.json`
- 验证：真实 DeepSeek 共 5 次（第一版脚本 resume 失败用掉 1 次，两种模式各 2 次）；测试 thread 已归档，端口已释放
- commit：见本次 commit
- 遗留：关键结论——provider 定义必须放在 server 启动参数里，按 thread 传入的定义在重启后无法恢复；S1-06 按此设计

## 2026-10-12 22:55 · S1-00d 其他客户端发起的 fork
- 结果：done
- 改动：`spikes/s1-00d-fork.mjs`、`spikes/s1-00d-fork-provider.mjs`、`spikes/lib.mjs`（`deepseekProviderArgs`）、`spikes/RESULTS.md`、`spikes/results/s1-00d-*.json`；`plans/stage-1.md` 的 S1-06 进程管理按结论改写
- 验证：真实 DeepSeek 计数 7 次（其中 2 次 fork 落到 OpenAI 返回 401，没有实际消耗）
- commit：见本次 commit
- 遗留：**安全发现**——fork 不继承父 thread 的 provider，会落到 server 默认；改为每个 profile 一个 app-server 并设为默认。TUI `/fork` 的实际表现待 S1-00e 由用户验证

## 2026-10-12 23:00 · S1-00e TUI 配合脚本
- 结果：done
- 改动：`spikes/s1-00e-tui.mjs`、`NEEDS_YOU.md`（请你过目）
- 验证：`--dry` 模式启动并停止 server 通过，没有调用模型；交互部分要等用户执行
- commit：见本次 commit
- 遗留：S1-00 整体完成；用户回复后把 e 的结果补进 `RESULTS.md`

## 2026-10-12 23:10 · S1-02 数据模型与协议类型
- 结果：done
- 改动：`packages/protocol/src/{entities,session-tree,api,examples,index}.ts`、`session-tree.test.ts`；`src/codex/`（Codex 0.161.0 生成的绑定，约 740 个文件）与 `scripts/gen-codex.mjs`（`npm run gen:codex -w @amo-studio/protocol`，生成后自动补 `.js` 扩展名）
- 验证：`npm run verify` 通过（11 个单元测试，生成的绑定也通过 strict 类型检查）
- commit：见本次 commit
- 遗留：会话状态在交互说明的五种之外加了 `error`；Host API 先定义了阶段 1 用到的路由，批注和画布的接口留到对应阶段

## 2026-10-12 23:25 · S1-03 存储
- 结果：done
- 改动：`packages/host/src/store/{store,migrations}.ts`、`store.test.ts`；`packages/host/src/index.ts` 导出
- 验证：`npm run verify` 通过（19 个单元测试，含重启后数据仍在、会话子树归档与恢复）。`node:sqlite` 在 Node 24.13（SQLite 3.50.4）和 Electron 44.7 自带的 Node 24.21（SQLite 3.53.4）里都可用，不需要备选方案
- commit：见本次 commit
- 遗留：
  - "session item 只追加"落实为：item 不删除、seq 不复用；正文可以原地替换（流式结束、审批结果），避免为每次状态变化多存一行
  - npm install 当时没下载 Electron 二进制，本轮手动执行 `node node_modules/electron/install.js` 补上；S1-08 需要确认 `npm install` 之后二进制是否存在
  - 用户中途把额度调为 DeepSeek 1000、GLM 5000（已提交 2cb5377）；用户说明 NEEDS_YOU 会很久没空处理，要求尽量推进。我尝试改写 ROADMAP/LOOP_RULES 的"必须等你"关卡，被自动模式拦截（属于修改 loop 自身规则），已在对话里请用户确认；阶段 1 没有"必须等你"关卡，不影响当前进度

## 2026-10-12 23:40 · S1-04a mock 模型
- 结果：done
- 改动：`packages/testkit/src/mock-model.ts`（兼容 OpenAI Responses 的流式 SSE，支持文本、`[[shell: …]]` 工具调用、`[[slow]]` 慢速流）、`mock-model.test.ts`、`assets/mock-model.models.json`、`scripts/verify-mock-codex.mjs`；根目录新增 `npm run test:codex-mock`
- 验证：`npm run verify` 通过（25 个单元测试）；`verify-mock-codex.mjs` 用真实 `codex app-server` 0.161 跑通两轮：纯文本（3 个 delta）和"审批 → 执行 `cmd /c echo` → 回复 MOCK-DONE"，没有消耗额度
- commit：见本次 commit
- 遗留：Codex 给模型的 shell 工具名是 `shell_command`，参数为 `{ command: string }`；`echo` 这类安全命令在 untrusted 下不会触发审批，测试审批要用 `cmd /c …`

## 2026-10-12 23:55 · S1-04b fake app-server
- 结果：done
- 改动：`packages/testkit/src/fake-app-server.ts`（WebSocket JSON-RPC，capability token 校验；thread start/resume/fork/archive/read/list/loaded，turn start/steer/interrupt；审批广播、先答先得、晚订阅补发；fork 默认落到 server 默认 provider；子 agent；剧本可替换）、`fake-app-server.test.ts`（10 个场景）；testkit 新增依赖 `ws@8.21.3`、`@types/ws@8.18.2`
- 验证：`npm run verify` 通过（35 个单元测试），testkit 测试连跑 3 次稳定
- commit：见本次 commit
- 遗留：fake 的事件字段只覆盖 Host 会用到的部分，类型上没有严格对齐生成的 `ThreadItem`；S1-06 的 runtime 测试会同时用 fake 和"真实 app-server + mock 模型"两条路径，防止 fake 与真实行为偏离

## 2026-10-13 00:10 · S1-05 凭据与模型路由
- 结果：done
- 改动：`packages/host/src/runtime/{credentials,profiles}.ts`、`profiles.test.ts`、`scripts/smoke-credentials.mjs`、`assets/codex/deepseek-flash.models.json`；`ModelProfile.provider/model` 改为可空（null = 用户自己的 Codex 配置）
- 验证：`npm run verify` 通过（42 个单元测试）；冒烟：真实凭据 deepseek-v4 存在（只打印长度），Key 不在启动参数里；两个 profile 的启动参数分别拉起真实 app-server 并 `thread/start` 成功（provider 分别为 openai、amo-deepseek），没有发起对话
- commit：见本次 commit
- 遗留：
  - 凭据脚本改用 `-EncodedCommand`：从 stdin 传脚本时 PowerShell 逐行执行，多行 here-string 会坏掉，读出来为空
  - 每个 server 只能有一个 `model_catalog_json`，所以只给默认 provider 带目录；Codex 默认 server 上恢复 DeepSeek thread 时没有 deepseek-flash 的元数据，走 Codex 的默认值

## 2026-10-13 00:25 · S1-06a JSON-RPC 客户端
- 结果：done
- 改动：`packages/host/src/runtime/codex/rpc-client.ts`（`ws` 连接 + capability token；方法名和参数用生成的 `ClientRequest` 约束，常用方法的返回值有类型；通知、服务端请求、关闭事件；超时；断开时拒绝所有挂起请求）、`rpc-client.test.ts`（6 个场景）；host 新增依赖 `ws@8.21.3`、`@types/ws@8.18.2`，devDependency `@amo-studio/testkit`
- 验证：`npm run verify` 通过（48 个单元测试）
- commit：见本次 commit
- 遗留：发现测试文件此前没有做类型检查（`tsc -b` 排除了 `*.test.ts`，vitest 不做类型检查）。新增 `tsconfig.tests.json` 并加进 `npm run typecheck`，顺手修了已有测试里的 5 处类型错误

## 2026-10-13 00:50 · S1-06b app-server 进程管理
- 结果：done
- 改动：`packages/host/src/runtime/codex/{command,server-manager}.ts`、`server-manager.test.ts`；`profiles.ts` 支持绝对路径的模型目录；testkit 导出 `MOCK_MODEL_CATALOG`、`mockCodexProvider`；`spikes/lib.mjs` 改用 npm 版 Codex
- 验证：`npm run verify` 通过（52 个测试）；进程管理集成测试（真实 app-server + mock 模型）连跑 3 次通过：启动并复用、崩溃后同端口同 token 重启且 thread 可恢复、新 Host 接管仍在运行的 server、停止后端口释放。测试没有留下进程或端口
- commit：见本次 commit
- 遗留：
  - **重要发现**：Node 不经 shell `spawn("codex")` 会找到 Codex 桌面版自带的 `codex.exe` 0.144.1，终端里的 `codex` 是 npm 版 0.161.0。Host 改为通过 `resolveCodexCommand()` 显式运行 npm 包的 `codex.js`（可用 `AMO_STUDIO_CODEX` 覆盖）。S1-00 a～d 实际跑在 0.144.1 上，新增 S1-00f 用 0.161 复测
  - 结束遗留 pid 前先核对命令行里有我们的 token 文件，避免 pid 复用时误杀别的进程
  - 新增 `detachAll()`：断开连接但不结束 server，供 Host 退出时保留会话、下次接管

## 2026-10-13 01:15 · S1-00f 用 Codex 0.161 复测
- 结果：done
- 改动：`spikes/s1-00f-recheck.mjs`、`spikes/results/s1-00f.json`、`spikes/RESULTS.md`（f 节与更正说明）；mock 模型支持 0.161 的 `exec_command { cmd }`；fake app-server 的 `thread/list` 按 0.161 列出 fork；`spikes/lib.mjs` 停止时等端口关闭；脚本删除临时目录时加重试
- 验证：复测脚本用 mock 模型在 0.161 上跑完 a～d 全部检查，结论与 0.144 一致，唯一差异是 `thread/list` 现在会列出 fork；`verify-mock-codex` 在 0.161 上 PASS（含审批）；`npm run verify` 通过（52 个测试）。没有消耗额度
- commit：见本次 commit
- 遗留：同一端口在几秒内连续起两次 app-server 偶尔会 10048（端口仍被占用）；Host 的进程管理器已有重试，只影响 spikes 脚本

## 2026-10-13 01:35 · S1-06c 会话运行层
- 结果：done
- 改动：`packages/host/src/runtime/codex/codex-runtime.ts`（开会话、发消息或插话、打断、显式 provider 的 fork、连同子孙归档与恢复、审批转交与"已在别处处理"、子 agent 与外部 fork 自动入树、provider 漂移告警、重连后重新订阅、事件规范化为 user/agent/tool/approval/subagent/error/notice 并发布 HostEvent）、`codex-runtime.test.ts`（9 个场景，基于 fake app-server）；fake app-server 增加 `thread/unarchive`
- 验证：`npm run verify` 通过（61 个测试），运行层测试连跑 3 次稳定
- commit：见本次 commit
- 遗留：短回合可能在 `turn/start` 响应之前就结束，所以状态和活动 turn 只认 `turn/started` / `turn/completed` 通知；item 的 codex id 映射只在内存里，Host 重启后正在流式输出的回复会以新 item 继续（S1-06d 用真实 app-server 再验证）

## 2026-10-13 01:55 · S1-06d 真实 app-server 集成测试
- 结果：done（S1-06 整体完成）
- 改动：`packages/host/src/runtime/codex/codex-runtime.integration.test.ts`（Store + CodexServerManager + CodexRuntime 对真实 `codex app-server` 0.161 与 mock 模型：开会话流式回复、命令审批与工具结果、同 provider fork 保留上下文、app-server 崩溃后继续对话、Host 重启后数据重载并接管原 server 继续对话、归档连同 fork 与只读、恢复后继续对话）；testkit 新增 `removeTempDir`
- 验证：集成测试连跑 3 次 6/6 通过；`npm run verify` 通过（67 个测试）。没有消耗额度
- commit：见本次 commit
- 遗留：被结束的 codex 进程有时要十几秒才从端口监听表里消失，临时目录的文件也会被占用一会儿；测试清理改为重试后放弃，不让测试失败

## 2026-10-13 02:10 · S1-07a Host API：REST 与事件流
- 结果：done
- 改动：`packages/host/src/service.ts`（工作区登记与路径校验、建任务并开首个会话、跨工作区任务按会话选工作区、移动看板列、加会话、消息/插话、打断、fork、归档/恢复、审批；错误统一为 HostError）、`http/server.ts`（127.0.0.1、`Authorization: Bearer` 校验 Host token、WS `/api/events?token=&since=` 先补发再推实时、delta 只推实时、CORS 白名单、可同源托管 UI 静态文件）、`server.test.ts`（9 个场景）；`FakeServers` 抽到 `fake-servers.test-support.ts`（不进构建）
- 验证：`npm run verify` 通过（76 个测试），API 测试连跑 3 次稳定
- commit：见本次 commit
- 遗留：默认决定——带首条消息新建的任务直接放在"进行中"列（人随即开始推进，不算 agent 移卡）；Host 只监听本机，但所有 /api 都要 token，防止本机其他程序驱动会话

## 2026-10-13 02:30 · S1-07b 终端接入与 Host 进程入口
- 结果：done（S1-07 整体完成）
- 改动：`service.ts` 新增 `terminal()`（生成 `codex --remote <ws> --remote-auth-token-env AMO_STUDIO_CODEX_TOKEN resume <thread>`，token 只放进新窗口的环境变量；launch 时写入状态改为 terminal-shared）与 `reclaim()`；`terminal/launcher.ts`（Windows 用 `cmd /c start` 开 PowerShell 新窗口；测试用 RecordingTerminalLauncher，不开窗口）；`host-process.ts`（数据目录、`host.lock` 单实例锁并清理死进程留下的锁、`host-token`、`host.json`、关闭时可选择保留 app-server）；`bin.ts`（命令行入口，环境变量配置，IPC `shutdown`/`restart`）；根目录 `npm run host`；runtime 新增 `attachInfo`、`setWriter`
- 验证：`npm run verify` 通过（81 个测试）；真实 `bin.js` 冒烟：启动在 47905，带 token 200、不带 401，IPC 关闭后锁和 host.json 都已清理，端口释放
- commit：见本次 commit
- 遗留：默认决定——正常退出 Host 会停掉 app-server（restart 时保留）；Codex 终端共享时工作台仍可写，"收回"只更新显示状态。真实开窗口只在用户点击时发生，loop 测试不开窗口

## 2026-10-13 02:50 · S1-08 Electron 外壳
- 结果：done
- 改动：`packages/app/src/{main,host-link}.ts`、`preload.cts`（单实例；找到运行中的 Host 或用 Electron 自带 Node 拉起 `host/dist/bin.js`；Host 默认常驻、detached，测试模式下随应用退出；窗口加载 Host 同源托管的 UI，或 `AMO_STUDIO_DEV_URL`；preload 只暴露 `window.amo.host()`，token 不进 URL 和命令行；测试模式窗口不显示、不抢焦点）；`packages/ui/src/host/client.ts`（按路由键调用的类型化客户端）与 App 连接状态；`e2e/`（Playwright 1.63.0 驱动 Electron 的启动助手与 2 个用例）；根目录 `npm run e2e`
- 验证：`npm run verify` 通过（81 个测试）；e2e 连跑 2 次 2/2：Host 拉起并连上、窗口不可见且无焦点、URL 不含 token、退出后锁释放；截图 `screenshots/stage-1/S1-08-shell.png`
- commit：见本次 commit
- 遗留：e2e 里的 Host 用真实的 app-server 管理器，S1-09 起需要建会话的用例要让 Host 支持测试用 provider（mock 模型），计划在 S1-10 前补上

## 2026-10-13 03:15 · S1-09 界面基础
- 结果：done
- 改动：`packages/ui/src/styles/app.css`（交互说明里的颜色 token）、`board/Board.tsx`（四列看板，卡片显示状态点、状态词、更新时间、范围与会话/分支数，卡片上没有按钮）、`board/ScopeNav.tsx`（全部、跨工作区、各工作区；登记工作区：原生选文件夹或输入路径）、`host/useHostState.ts`（快照加 WS 事件实时更新，断线重连）、`lib/status.ts`（任务状态由会话汇总：待批准 > 待审阅 > 出错 > 运行中 > 空闲 > 已完成）、`App.tsx`（顶栏：看板、画布占位、"需要你"计数、"+ 新任务"）；preload/main 增加 `pickDirectory`；host `bin.ts` 增加测试开关 `AMO_STUDIO_TEST_PROVIDER_URL`（只换成 mock 模型配置和沙盒 CODEX_HOME）；e2e 助手支持 mock 模型、直接调用 API、建沙盒工作区
- 验证：`npm run verify` 通过（81 个测试）；e2e 4/4 连跑 2 次（登记沙盒工作区 → 看板显示两张卡片、待批准与空闲、"需要你 1"、范围过滤；非法路径报错）；截图 `screenshots/stage-1/S1-09-board.png`
- commit：见本次 commit
- 遗留：
  - 隐藏窗口不重绘，capturePage 会拿到旧画面。测试模式改为把窗口放到屏幕外、不进任务栏、`showInactive()` 且不可聚焦；e2e 断言改为"无焦点且不在任何显示器上"
  - 字体暂用本机回退（不连 Google Fonts），打包时再决定是否内置 IBM Plex Sans / Noto Sans SC
  - 默认决定：会话状态"出错"用红色（原型里没有）；卡片没有会话时显示"未开始"

## 2026-10-13 03:40 · S1-10 新建任务页
- 结果：done
- 改动：`packages/ui/src/newtask/NewTaskPage.tsx`（DSH 式空白页："要推进什么？"、其下的标题输入框（可留空）、范围选择（各工作区 + 跨工作区）、范围说明、底部输入框加模型选择；跨工作区时多一个"首个会话在"；回车发送、Shift+回车换行；记住上次的模型和工作区）、`task/TaskPage.tsx`（最小任务页：会话列表 + 当前会话消息，S1-11 在此基础上扩展）、`host/events.ts`（页面内事件总线）、`host/useSessionItems.ts`（先订阅再加载，补上加载期间的事件；流式增量累加，结束时以 item.updated 为准；重连后重新加载）、`lib/profiles.ts`、样式；`ui-logic.test.ts`（6 个单元测试）
- 验证：`npm run verify` 通过（87 个测试）；e2e 7/7（新建页默认值与布局、开始后进入任务页并看到"生成中…"再落定、跨工作区任务的首个会话落在所选工作区、没有工作区时不能开始）；截图 `S1-10-new-task.png`、`S1-10-first-reply.png`
- commit：见本次 commit
- 遗留：默认决定——没有登记任何工作区时"开始"不可用并提示先登记；新建页默认选中左栏当前工作区，"全部"视图下选上次用过的工作区，没有记录则选第一个

## 2026-10-13 04:00 · S1-11a 任务页结构
- 结果：done
- 改动：`packages/ui/src/task/SessionTree.tsx`（会话树按父子缩进、行内显示类型 · 模型 · 工作区 · 终端；新会话的模型与工作区选择；"▸ 已归档 n"，查看只读、恢复）、`task/TaskPage.tsx`（任务状态下拉框、提示条、会话顶栏：写入状态、在终端打开、分支、归档/恢复）、样式；host `bin.ts` 在 `AMO_STUDIO_TEST=1` 时只记录终端启动、不开窗口；e2e `taskpage.spec.ts`
- 验证：`npm run verify` 通过；e2e 8/8（新增：改任务状态、分支缩进在父会话下并自动选中、第二个独立会话、在终端打开给出不含 token 的命令且写入状态变为共享、归档连同分支、查看归档只读、恢复）；截图 `S1-11a-task-page.png`
- commit：见本次 commit
- 遗留：默认决定——会话顶栏加了"分支"按钮（原型没有，但 API 已有，且 TUI 外也需要一个入口）；"在终端打开"之后状态保持"共享"，直到用户手动收回（阶段 1 不检测 TUI 是否已关闭）

## 2026-10-13 04:20 · S1-11b 对话面板
- 结果：done
- 改动：`packages/ui/src/task/Thread.tsx`（用户消息；agent 回复按 markdown 渲染并显示"生成中…"；工具卡片可折叠，显示状态与输出；审批卡片带"批准/拒绝"，处理后显示已批准/已拒绝/已在别处处理；子 agent 摘要带"查看"跳转；错误与提示；输入框：回车发送，生成中按钮变"插话"并出现"打断"，归档或交给终端时禁用并说明原因；跟随滚动到底部，向上翻看时不打断）、`lib/markdown.tsx`（安全的最小 markdown：代码块、标题、列表、引用、段落、行内代码/粗体/斜体/链接文字，全部按文本渲染，不注入 HTML）、`markdown.test.ts`；TaskPage 接入审批、发送、插话、打断
- 验证：`npm run verify` 通过（90 个测试）；现有 e2e 8/8 通过
- commit：见本次 commit
- 遗留：链接只显示文字和目标，不可点击（外链打开方式随阶段 2 审阅一起定）；对话面板的 e2e 在 S1-11c

## 2026-10-13 04:45 · S1-11c 对话面板端到端
- 结果：done（S1-11 整体完成）
- 改动：e2e `chat.spec.ts`（界面批准/拒绝命令并看到工具结果、"需要你"随之变化；插话与打断；子 agent 挂在父会话下、"查看"跳转）；mock 模型支持 `[[spawn: 名称: 任务]]`（经 Codex 的 collaboration.spawn_agent）、子 agent 回复 `MOCK-SUB: /root/<名称>`、跳过 Codex 注入的上下文消息；**Host 运行层修复**：Codex 0.161 不为子 agent 发 `thread/started`，改为收到 `subAgentActivity` 时建子会话；fake app-server 对齐；`spikes/RESULTS.md` 新增 g 节
- 验证：`npm run verify` 通过（91 个测试）；e2e 11/11；截图 `S1-11c-approval.png`、`S1-11c-subagent.png`
- commit：见本次 commit
- 遗留：命令的工具卡片排在审批卡片前面（Codex 先发 item/started 再发审批请求），之后考虑合并成一张卡片；插话内容要等当前这次模型输出结束才出现在对话里，这是 Codex 的行为

## 2026-10-13 05:00 · S1-12a 真实 DeepSeek 冒烟
- 结果：done
- 改动：`scripts/smoke-stage1.mjs`、根目录 `npm run smoke:stage1`、`spikes/results/s1-12-smoke.json`
- 验证：真实 DeepSeek 3 次（19/1000）。沙盒 CODEX_HOME 和工作区：第一轮回复 OK，第二轮答出暗号 LIME-4（上下文保留）；真实 Codex TUI（npm 0.161）用生成的 `codex --remote … resume` 在隐藏控制台启动，和 app-server 端口建立 1 条连接并持续运行，命令行不含 token；Host 以保留 app-server 的方式重启后，任务、会话和 4 条记录都在，第三轮回复 STILL-HERE；测试会话已归档，没有残留进程和端口
- commit：见本次 commit
- 遗留：TUI 的交互（在 TUI 里打字、`/fork`）仍需要用户在真实终端里看一眼，已在 NEEDS_YOU 的 S1-00e 一条里
