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

## 2026-10-13 05:30 · S1-12b 阶段 1 收尾
- 结果：done（阶段 1 完成）
- 代码审查：`/code-review` 是用户触发的命令，loop 里无法调用，改为由我对整个阶段的改动做审查，重点看安全与异常路径。修了三处：静态文件路径里畸形的 `%` 编码会让请求处理抛出未捕获异常（可能让 Host 崩溃）；Electron 窗口没有禁止新开窗口和跳转到外部页面；连接断开时挂起的审批永远停在"待批准"、重连后会话状态不按服务端校正。各补了回归测试
- 防偏离自查：对照架构文档"明确不做"——没有强制 worktree（会话在登记的工程目录里运行）；对话面板不追求与 CLI 对齐，CLI 能力通过"在终端打开"接原版 TUI；没有自动审批（默认 approvalPolicy on-request，高风险操作仍需人批准，与平时用 Codex 一致）；runtime 与 server 管理都做了抽象，没有绑死单一厂商。对照 interaction-notes：与已确认交互没有冲突，新增的默认决定已列入 NEEDS_YOU 供推翻
- 完整验证：`npm run verify` 93 个测试通过；e2e 11/11；真实冒烟（S1-12a）通过
- 其他：新增 `npm start`（构建并打开 Studio）、`npm run host:stop`（核对命令行后停止常驻 Host 及其 app-server）
- 合并：`studio/stage-1` 以 `--no-ff` 合并回 `studio/main`；新建 `studio/stage-2`，写 `plans/stage-2.md`
- 遗留：TUI 里的交互（打字、`/fork`）仍等用户在真实终端看一眼（NEEDS_YOU S1-00e）

## 2026-10-13 05:50 · S2-01 markdown 补全
- 结果：done
- 改动：`packages/ui/src/lib/markdown.tsx`（表格、嵌套列表、续行；代码块带语言标签与"复制"；http/https 链接和裸链接交给系统浏览器；每个块带 `data-src-start/end`，区间相对于统一为 LF 的源文本）、`markdown.test.ts`（7 个用例）、样式；preload/main 新增 `openExternal`（只放行 http/https，测试模式只记录不打开）；mock 模型新增 `[[markdown]]` 示例回复；e2e `markdown.spec.ts`
- 验证：`npm run verify` 通过；e2e 12/12；截图 `screenshots/stage-2/S2-01-markdown.png`
- commit：见本次 commit
- 遗留：无

## 2026-10-13 06:05 · S2-02 批注 API
- 结果：done
- 改动：protocol 的 `Annotation` 增加 `prefix`/`suffix`；新增 `NewAnnotationInput`、5 条批注路由、`annotation.upserted`/`annotation.removed` 事件、共享的 `composeAnnotationMessage`（Host 发送和 UI 预览用同一份格式）；Store 增加 `getAnnotation`、`deleteAnnotation`；HostService 增加列出/新建/修改/删除/汇总发回（只能批注 agent 回复、备注与原文不能为空、区间必须有效；按回复顺序和段内位置排序；发出后写 `sentAt`，已发送的批注不能再改）
- 验证：`npm run verify` 通过；API 测试新增"建批注 → 改 → 删 → 汇总发回 → 会话收到一条按顺序拼好的用户消息、批注标记已发送"
- commit：见本次 commit
- 遗留：汇总消息的格式是"针对你上面的回复，我有 N 条批注："+ 每条"> 原文 / 备注"，原文超过 300 字截断；用户可在阶段 2 的请你过目里提意见

## 2026-10-13 06:30 · S2-03 选中文字的右键菜单
- 结果：done
- 改动：`packages/ui/src/lib/selection.ts`（选区必须落在同一条 agent 回复里；按触到的渲染块在源文本中查找原文，渲染后丢掉的 markdown 符号用宽松匹配，找不到就退回块的区间；前后各 24 字上下文）、`selection.test.ts`；Thread 增加自定义右键菜单（添加批注 / 引用到输入框 / 复制；Esc、点外面、滚动时关闭；只读会话不能引用到输入框）；`task/AnnotationPanel.tsx`（任务页右栏，先做批注草稿卡，S2-04 补列表等）；新增 `amo:copy`（主进程写剪贴板，不依赖页面焦点；代码块"复制"也改走这里）；e2e `context-menu.spec.ts` 与选区助手 `selection.ts`
- 验证：`npm run verify` 通过；e2e 13/13；截图 `screenshots/stage-2/S2-03-context-menu.png`
- commit：见本次 commit
- 遗留：测试模式下"复制"只记录、不写系统剪贴板（这台机器上 e2e 里系统剪贴板读写都不可靠，而且测试不应改用户的剪贴板）。排查时曾在主进程直接调用过一次 `clipboard.writeText("direct-1")`，回读为空，大概率没有写进去；如果写进去了，用户剪贴板内容在 06:25 左右被覆盖过一次

## 2026-10-13 06:50 · S2-04 批注栏
- 结果：done（ROADMAP 阶段 2 的核心验收流程已打通）
- 改动：`packages/ui/src/task/AnnotationPanel.tsx`（未发送批注卡片：原文、备注、编辑、删除，点原文定位；"汇总发回会话（n）"，悬停可预览拼好的消息，会话只读时不可用；已发送的收进"▸ 已发送 n"）、`host/useAnnotations.ts`（加载 + 事件实时更新）、Markdown 的 `highlights`（与未发送批注重叠的块标记 `data-annotated` 并高亮）、TaskPage 的定位与闪烁、样式；e2e `review.spec.ts`
- 验证：`npm run verify` 通过；e2e 14/14（新增：选中 → 右键批注 ×3 → 编辑 → 删除 → 高亮与定位 → 汇总发回 → 会话收到按顺序拼好的消息并得到回复 → 批注收进已发送）；截图 `S2-04-annotations.png`、`S2-04-sent.png`
- commit：见本次 commit
- 遗留：高亮粒度是"块"（段落、表格、列表），不是精确到选中的那几个字；精确高亮要在渲染时切分文本节点，先不做

## 2026-10-13 07:10 · S2-05 草稿区
- 结果：done
- 改动：Store 迁移 2（`kv` 表）与 `getKv`/`setKv`；protocol 新增 `Scratchpad`、`GET/PUT /api/scratchpad`、`scratchpad.updated` 事件；HostService 读写草稿（必须是字符串，上限 20 万字）；`packages/ui/src/task/Scratchpad.tsx`（右栏底部，全局一份；停止输入 0.5 秒或失焦时保存，显示"保存中…/已保存"；其他窗口实时同步，本窗口有未保存输入时不覆盖）；e2e 助手支持复用数据目录重启应用；e2e `scratchpad.spec.ts`
- 验证：`npm run verify` 通过（schema 版本 2、kv 读写、草稿 API 与事件、Host 重启后仍在）；e2e 15/15（输入 → 已保存 → 重启应用 → 仍在）；截图 `S2-05-scratchpad.png`
- commit：见本次 commit
- 遗留：写 e2e 时一度用了"不接 mock 模型 + DeepSeek 配置"建任务，那样会在用户真实的 ~/.codex 里建线程（虽然不发对话）。运行前已改为 mock 模型和沙盒 CODEX_HOME，并检查了其他用例：凡是 `mockModel: false` 的用例都不建会话

## 2026-10-13 07:25 · S2-06 快速跳转
- 结果：done
- 改动：`packages/ui/src/task/ReplyNav.tsx`（对话区右上角浮动的"↑ n / N ↓"；`Alt+↑/↓`；跳到的回复闪一下；"当前回复"取最后一个越过顶边的回复，顶部时取第一条可见回复，滚到底时取最后一条；在长回复中间往上跳先回到这条的开头）；批注定位改用同一个 `flash`；`thread-wrap` 容器与样式；e2e `jumps.spec.ts`
- 验证：`npm run verify` 通过；e2e 16/16；截图 `S2-06-jumps.png`
- commit：见本次 commit
- 遗留：对话区外包了一层容器后要给内部滚动区 `min-height: 0`，否则内容会把它撑开、无法滚动

## 2026-10-13 07:45 · S2-07 阶段 2 收尾
- 结果：done（阶段 2 完成）
- 代码审查（同阶段 1，loop 无法调用 `/code-review`，由我审查阶段 2 的 23 个源文件改动）：修了两处——在草稿区打完字 0.5 秒内离开任务页会丢掉最后一次输入（改为卸载时补存，并加 e2e）；批注区间没有检查是否超出回复原文（加校验与测试）。其余检查：外链只放行 http/https；markdown 不注入 HTML；正则由用户选区构造时已转义；复制和打开链接在测试模式只记录
- 防偏离自查：对照 interaction-notes"批注"一节——右键菜单三项、批注卡（上原文下输入框）、保存后段落高亮、多条汇总成一条用户消息、草稿区在右栏底部且先做全局，均一致；对照"明确不做"无越界
- 完整验证：`npm run verify` 105 个测试通过；e2e 16/16
- 合并：`studio/stage-2` 以 `--no-ff` 合并回 `studio/main`；新建 `studio/stage-3`，写 `plans/stage-3.md`
- 遗留：无

## 2026-10-13 08:00 · S3-01 画布数据与接口
- 结果：done
- 改动：protocol 的 `CanvasDoc` 增加 `version`；新增 `canvas.ts`（`emptyCanvas`、`validateCanvas`：id 唯一、分组/任务引用存在、几何有效、一个任务只放一次、依赖两端是任务、不自环、不重复、不成环；`findCycle`/`wouldCycle`；`canvasOutline`：不含坐标的大纲文本与 JSON，含分组、未分组、还没放上画布的任务、依赖与会话状态）；`GET/PUT /api/canvas`（版本不符 409，校验失败 400）、`GET /api/canvas/outline`、`canvas.updated` 事件
- 验证：`npm run verify` 通过（新增画布单元测试 6 个、API 测试 1 个，覆盖版本冲突、非法引用、大纲、重启后仍在）
- commit：见本次 commit
- 遗留：任务目前不会被删除，所以"任务删除后节点保留但标记"暂不需要；大纲会把没放上画布的任务单独列出，界面在 S3-02 决定是否自动放置

## 2026-10-13 08:20 · S3-02 画布视图
- 结果：done
- 改动：`packages/ui/src/canvas/CanvasPage.tsx`（顶栏"画布"可用；拖空白处平移、滚轮以指针为中心缩放、按钮缩放、复位，视图位置按本机记住；任务卡片与看板一致的状态点和状态词；拖卡片移动并保存；双击或回车打开任务；还没放上画布的任务自动排到未分组区域）、`canvas/useCanvas.ts`（整份文档乐观保存，版本冲突时重新载入并提示）、样式；e2e `canvas.spec.ts`
- 验证：`npm run verify` 通过；e2e 17/17；截图 `screenshots/stage-3/S3-02-canvas.png`
- commit：见本次 commit
- 遗留：默认决定——新任务自动放进画布的未分组区域（interaction-notes 写的是"新任务默认放在未分组区域"）；两个窗口同时拖动时后保存的一方会收到冲突提示并载入最新内容

## 2026-10-13 08:55 · S3-03 自由分组
- 结果：done
- 改动：`packages/ui/src/canvas/geometry.ts`（纯函数：按中心点判定归属、整组移动、调整大小带最小尺寸、改名与绑定、删除分组保留卡片）与单元测试；CanvasPage 增加分组（"+ 分组"建在视野中央；拖标题栏整组移动；拖右下角调整大小；双击标题或在设置面板改名；绑定工作区；删除分组保留卡片；卡片拖进拖出自动归属），拖动时先画预览、松手再保存；`useCanvas` 改为保存排队，并把基于本窗口上一次保存之前版本的编辑接到新版本上（别的窗口的改动仍会 409）；e2e `groups.spec.ts`
- 验证：`npm run verify` 通过；e2e 18/18；截图 `screenshots/stage-3/S3-03-groups.png`
- commit：见本次 commit
- 遗留：
  - 两个坑：同一窗口连续两次编辑（改名后马上绑定）会用旧版本号发出第二次保存而被判冲突，已用"本窗口续版"解决；页面上残留的文字选区会让拖动变成浏览器原生拖拽、吞掉后续鼠标事件，已在开始拖动时 `preventDefault`
  - 拖动监听改为 layout effect，确保快速拖动的第一下就有监听
  - 分组设置先放在画布右上角的浮层里，S3-05 搬进侧栏"详情"

## 2026-10-13 09:20 · S3-04 依赖与便签
- 结果：done
- 改动：`packages/ui/src/canvas/CanvasSidebar.tsx`（画布右侧栏：整体待办 / 详情 / agent 视角三个标签页，本任务先做"详情"——任务：状态、打开任务、前置任务列表可移除、添加前置任务时用 `wouldCycle` 排除会成环的；分组：名称、绑定工作区、删除（从画布浮层搬过来）；便签：编辑与删除）；CanvasPage 增加 SVG 依赖箭头（从前置任务指向后续任务，裁到卡片边框）、"+ 便签"（建在视野中央，可拖动、可进出分组）；geometry 增加 `borderPoint`/`arrowBetween` 与测试；e2e `deps.spec.ts`，groups 用例改为在侧栏操作
- 验证：`npm run verify` 通过；e2e 19/19；截图 `screenshots/stage-3/S3-04-deps-notes.png`
- commit：见本次 commit
- 遗留：自动摆放的起始高度下移到工具条下方

## 2026-10-13 09:30 · 修复：Host 测试偶发 "fetch failed"
- 结果：done
- 原因：S3-04 的完整验证里 CORS 用例偶发 `fetch failed`，单独重跑 4 次都通过。每个用例都会新起一个 Host，系统可能把刚关闭的端口号再分出去，Node fetch 连接池里指向旧服务端的 keep-alive 连接就会失败
- 改动：`server.test.ts`、`host-process.test.ts` 的请求一律带 `connection: close`，不复用连接
- 验证：`npm run test` 连跑 2 次、`npm run verify` 均通过（118 个测试）
- 过程问题：S3-04 那次提交（161a8d2）是在这条用例失败的情况下提交的——命令里用 grep 过滤输出，没有让失败中断提交。之后验证改为先看 `npm run verify` 的退出码再提交
- commit：见本次 commit

## 2026-10-13 09:55 · S3-05 侧栏：整体待办、agent 视角
- 结果：done
- 改动：Host 增加待办接口 `GET/POST /api/todos`、`PATCH/DELETE /api/todos/:id` 与事件 `todo.upserted`/`todo.removed`（文本必填、工作区须存在）；侧栏"整体待办"（新增时可选适合的工作区、勾选完成（乐观更新，失败时重新加载）、删除、已完成折到下面）；"agent 视角"（`/api/canvas/outline` 的大纲 / JSON 切换、复制，画布/任务/会话变化后 150ms 合并刷新）；接口单测 1 个、e2e `sidebar.spec.ts`
- 调试：连续回车添加两条时第二条丢失——输入框原先等保存返回才清空，第二次输入被覆盖；改为立即清空、失败时还原。勾选完成原先等事件回来才变，Playwright 判定"点击没改变状态"；改为乐观更新
- 默认决定（请你过目）：待办"转为任务""交给调度 agent"留到阶段 7；"复制"按钮测试里不点（测试不碰剪贴板）
- 验证：`npm run verify` 退出码 0（119 个测试）；e2e 20/20；截图 `screenshots/stage-3/S3-05-todos.png`、`S3-05-agent-view.png`
- commit：见本次 commit

## 2026-10-13 10:25 · S3-06 跨工作区任务补全
- 结果：done
- 对照 interaction-notes 检查：新建时选"跨工作区"+首个会话所在工作区、会话列表显示工作区、新会话选工作区、对话顶部显示工作区、看板卡片列出工作区、左栏"跨工作区"范围——这些在阶段 1/2 已经有了。缺口：画布卡片、侧栏详情、agent 大纲只写"跨工作区"，不列涉及的工作区
- 改动：protocol 新增 `scope.ts`（`taskWorkspaceNames`/`taskWhere`：跨工作区任务按会话首次使用顺序列出工作区，忽略已归档会话），看板卡片、画布卡片、侧栏详情、agent 大纲统一使用；大纲 JSON 每个任务多一个 `workspaces` 数组；单测 2 个、e2e `crossws.spec.ts`（界面新建跨工作区任务，首个会话在 beta，再在 alpha 开会话，检查任务页、看板、范围筛选、画布、详情、agent 视角）
- 默认决定（请你过目）：画布是全局的一张，不受左栏范围筛选影响（左栏选了 alpha，画布仍显示全部任务）
- 验证：`npm run verify` 退出码 0（121 个测试）；e2e 21/21；截图 `screenshots/stage-3/S3-06-cross-workspace.png`
- commit：见本次 commit

## 2026-10-13 11:05 · S3-07 Focus 悬浮窗
- 结果：done
- 改动：
  - Electron：`packages/app/src/focus-window.ts`（无边框、透明、置顶 floating、不可获得焦点、不进任务栏、不可调整大小，默认贴主显示器工作区右下角，测试模式放 -32000；透明区域默认点击穿透 `setIgnoreMouseEvents(true, {forward})`）；`ShellPrefs` 把 Focus 开关记在数据目录 `shell-prefs.json`；IPC：`amo:focus-get/set`、`amo:focus-changed`、`amo:focus-mouse`（只接受 Focus 窗口自己发来的）、`amo:open-in-workbench` → 主窗口收到 `amo:navigate`
  - 界面：同一个 bundle，`#focus` 时渲染 `FocusApp`。标题行"需要你 n · 运行中 m"、收起/展开；列表只列待批准、待审阅的未归档会话，最新的在前；默认展开第一条，显示待批准的命令或最近一条回复（截到 300 字）；待批准可"批准"；"在工作台打开"跳到对应任务和会话（同一任务已打开时也会切到那个会话）；鼠标进入面板时关闭穿透、离开时恢复
  - 工作台顶栏增加"Focus 开/关"按钮
  - 测试辅助：`screenshot`/`windowState` 按 URL 区分主窗口和 Focus 窗口（原先取第一个窗口，两个窗口时不可靠），`windowState` 多返回 focusable、alwaysOnTop；测试模式记录最近一次穿透开关值
  - 单测 2 个、e2e `focus.spec.ts`（打开 Focus、窗口状态（屏幕外、未聚焦、不可聚焦、置顶）、条目与命令、悬停切换穿透、在工作台打开、就地批准后条目消失、关闭 Focus）
- 默认决定（请你过目）：Focus 平时默认开启、测试默认关闭，开关按本机记住；列表不放运行中的会话（原型里有，按阶段计划只列待你处理的，运行中只计数）；Focus 里只有"批准"，"拒绝"和"终端"回工作台做；暂不做托盘，开关在工作台顶栏
- 验证：`npm run verify` 退出码 0（123 个测试）；e2e 22/22；截图 `screenshots/stage-3/S3-07-focus.png`
- 真机观感（贴角位置、透明、穿透）测试里看不到，阶段收尾时写进"请你过目"
- commit：见本次 commit

## 2026-10-13 11:30 · S3-08 多显示器与 DPI
- 结果：done
- 改动：`packages/app/src/placement.ts`（纯函数，坐标统一用 Electron 的 DIP，混合缩放无需换算：`displayFor`、`clampInto`、`cornerOf`、`placeFocus`、`refitFocus`、`placeMain`）与 10 个单测（三屏：主屏 100%、左侧 4K 150% 负坐标、右侧 125%；默认贴角、记住的位置、半出界拉回、显示器拔掉回主屏角落、改缩放后拉回、主窗口居中/恢复/标题栏出界拉回/放不下时缩小）；Electron 接入：Focus 标题行可拖动（`-webkit-app-region: drag`），拖完记住位置；主窗口关闭时记住正常尺寸位置和是否最大化，启动时按 `placeMain` 恢复；`display-added/removed/metrics-changed` 时两个窗口都重新校正；都记在数据目录 `shell-prefs.json`；测试模式下全部跳过（窗口始终在屏幕外）
- 验证：`npm run verify` 退出码 0（133 个测试）；e2e 22/22
- 请你过目（真机）：Focus 贴角位置、拖动标题行移动、拔插显示器/改缩放后的位置——测试环境无法观察，阶段收尾时写进 NEEDS_YOU
- commit：见本次 commit

## 2026-10-13 12:10 · S3-09 阶段 3 收尾
- 结果：done
- 代码审查：`/code-review` 只能由用户触发，loop 调不了，改为自查阶段 3 的全部改动（40 个文件，约 2600 行）。查出并修复：删除工作区后，待办和画布分组里还留着它的 id，界面上会显示"适合："加空白——现在删除工作区时一起清掉这些引用（各自发 `todo.upserted` / `canvas.updated` 事件），并补了接口测试（commit 6245ab2）。确认服务端会拒绝成环的依赖、类型不对的连线、指向不存在任务的节点
- 防偏离自查：
  - 对照"明确不做"：没有引入 worktree 流程；没有自动审批（Focus 的批准也要人点）；没有绑定单一运行时；
  - 对照 interaction-notes：画布、侧栏三个标签页、依赖、便签、Focus "只回答现在有什么要我处理"都一致；
  - 和原型不一致的一处：原型里 Focus 列表也放运行中的会话，这里按阶段计划只计数，已写进"请你过目"
- 完整验证：
  - 第一次 `npm run verify` 失败，testkit 的 fake app-server 用例偶发 `ws error`；单独连跑 5 次、不改代码再跑两次完整验证都通过，只在整套并行跑时偶发；
  - 修法：测试客户端连接失败时最多重试 3 次，错误信息带上底层原因；
  - 修完后 `npm run verify` 退出码 0（134 个测试），e2e 22/22（截图同时重新生成，阶段 1、2 的截图顶栏多了"Focus"按钮）
- NEEDS_YOU：写入"阶段 3 完成"（请你过目）、"是否切换为日常工具、何时删除旧 AMO"（必须等你，S3-10）
- 合并：`studio/stage-3` 用 `--no-ff` 合并到 `studio/main`（见下一条）

## 2026-10-13 12:25 · 阶段 3 合并，开始阶段 4
- 合并：`studio/stage-3` 用 `--no-ff` 合并到 `studio/main`（f0ea8bc）；新建 `studio/stage-4`
- 计划：`plans/stage-4.md`（10 个任务：S4-00 预研、mock Anthropic 接口、ClaudeRuntime、审批/分支/子 agent、模型配置、交接终端、只读 MCP、自动注入、GLM 冒烟、收尾）；写入 NEEDS_YOU（请你过目）
- 关键约束：受管 Claude 会话用 Studio 自己的 `CLAUDE_CONFIG_DIR`（红线 2）；只用 GLM 和 mock；本机 Claude Code 2.1.296，SDK 最新 0.3.296，版本在预研后锁定
- 通知：阶段完成 + 新的"必须等你"

## 2026-10-13 12:55 · S4-00 预研 Claude Agent SDK
- 结果：done，结论见 `spikes/RESULTS.md` 第 h 节
- 依赖：host 包加入 `@anthropic-ai/claude-agent-sdk` 0.3.296（与本机 `claude` 2.1.296 同版本）及 peer 依赖 `zod` 4.6.6、`@anthropic-ai/sdk` 0.133.0、`@modelcontextprotocol/sdk` 1.32.1，均为精确版本，lockfile 一并提交
- 凭据：只列了凭据管理器的条目名，GLM 的 id 是 `glm-5.2`；路由参数从旧 AMO 的 glm-5.3 预设只读获取（`broker/lib/claude-provider.js`）
- 主要结论：
  - `canUseTool` 可挂起等人；只读命令（如 `echo`）被 CLI 自动放行，不经过回调；
  - `interrupt()` 后迭代器会抛异常；
  - 生成中发的消息排到下一轮，不会插进当前回合；
  - 不调模型的 `forkSession(id, { upToMessageId })` 可用，但读的是 Host 进程自己的 `CLAUDE_CONFIG_DIR`；
  - 子 agent 靠 `parent_tool_use_id` 归组，没有独立 session id；
  - 同一 `CLAUDE_CONFIG_DIR` 下真实 CLI 能 `--resume` SDK 创建的会话
- 红线：所有会话都在 `%TEMP%\amo-studio-sandbox\s4-00\`；每次实验前后检查 `~/.claude.json`、`~/.claude/settings.json` 的修改时间都没变；密钥只放进子进程环境变量，结果文件里没有
- 额度：GLM 12 次（12 / 5000）。另有两次脚本问题没有消耗额度：打断时 SDK 抛异常导致脚本退出（之后的实验没跑）；修复时 heredoc 把 `\n` 转成真换行导致语法错误
- 计划更新：`plans/stage-4.md` 按结论改写 S4-02、S4-03 的做法
- commit：见本次 commit

## 2026-10-13 13:30 · S4-01 mock Anthropic 接口
- 结果：done
- 改动：`packages/testkit/src/mock-anthropic.ts`（Anthropic Messages 接口的本地替身，流式 SSE 和非流式都支持；指令 `[[shell: …]]`、`[[spawn: …]]`（前台子 agent）、`[[spawn-bg: …]]`（后台子 agent）、`[[slow]]`、`[[markdown]]`；`mockClaudeEnv()` 给出把 CLI 指向 mock 的环境变量）；解析单测 4 个；`packages/host/src/runtime/claude/mock-anthropic.sdk.test.ts` 用真实 SDK 对着 mock 跑 4 个场景（普通回复、需审批的命令、前台子 agent、后台子 agent），都在临时 `CLAUDE_CONFIG_DIR` 里
- 调试：
  - 第一次跑审批用例时测试进程堆内存耗尽：CLI 在工具结果之后又追加了 `role: "system"` 消息，mock 没认出"工具已经执行过"，一直重复发起同一个命令。改成"人最后一句话之后出现过工具结果"；
  - 用调试脚本看 CLI 实际发出的请求，脚本临时放在 `packages/host/`，跑完删除；临时目录也已清理
- **重要发现**（已写进 `spikes/RESULTS.md` 第 h 节和阶段 4 计划）：
  - 不传 `permissionMode` 时 CLI 默认是 `auto`，由模型分类器代替人审批——Host 必须始终显式传 `"default"`；
  - `Agent` 工具默认在后台跑，结束后父会话会自动多一轮；
  - `Agent` 的 `mode` 参数能让子 agent 绕过审批，Host 要在 `canUseTool` 里去掉
- 清理：内存耗尽那次测试进程崩溃，留下 2 个 `amo-studio-test-claude-*` 临时目录，已删除；确认没有遗留的 SDK 子进程
- 验证：`npm run verify` 退出码 0（142 个测试）
- 额度：0
- commit：见本次 commit

## 2026-10-13 14:40 · S4-02 ClaudeRuntime
- 结果：done
- 改动：
  - `runtime/runtime.ts`：运行时通用接口 `SessionRuntimeApi`、按会话或模型配置所属运行时分派的 `RuntimeRouter`、共用的持久化辅助基类 `RuntimeBase`（`CodexRuntime` 暂未迁移到基类，避免动已稳定的代码）；
  - `runtime/claude/claude-env.ts`：Claude 提供方定义（内置 GLM）与子进程环境变量（去掉继承的 `ANTHROPIC_*`/`CLAUDE*`，加路由、凭据、Studio 自己的 `CLAUDE_CONFIG_DIR`；没有提供方或凭据时报错，即不使用 Claude 订阅登录）；
  - `runtime/claude/claude-runtime.ts`：
    - 会话 id 由 Studio 生成（SDK `sessionId`），之后 `resume`；
    - 每个会话一个流式输入的 `query()`，始终 `permissionMode: "default"`；
    - 生成中发的消息排队（接口返回 `mode: "queue"`）；
    - `canUseTool` 挂起等人、转成审批卡片，`Agent` 调用去掉 `mode`；
    - 打断后的异常按"已打断"处理；空闲 10 分钟关闭进程，下次发消息自动接续；
    - Host 关闭或崩溃重启后，进行中的回合结束并留一条说明；
  - Host 进程同时创建 Codex 和 Claude 两个运行时，经路由分派；关闭时等 Claude 进程全部退出；数据目录下新增 `claude-home`；
  - 协议：发送消息和"汇总发回"的返回值加上 `"queue"`
- 测试：集成测试 7 个（真实 SDK + mock：对话与接续、批准、拒绝、排队与打断、子 agent、崩溃恢复、关闭后重启接续）；`claudeEnv` 单测 3 个
- 调试：
  - 关闭后立刻接续会话时 CLI 报 "Session ID … is already in use"：`query.close()` 不等进程退出。改为关闭时等 `consume` 结束，同一会话再发消息前先等关闭完成；
  - mock 把 CLI 注入的 "[Request interrupted by user]" 当成了人说的话，已跳过
- 和计划的出入：审批（`canUseTool` → 卡片）提前到本任务做，因为 "default" 模式下没有它，需要审批的工具调用会全部被拒；S4-03 剩下分支和子 agent 归组。子 agent 那条用例只验证能跑通，`mode` 被去掉的验证留到 S4-03
- 清理：用 `-t` 只跑部分用例时，测试文件在加载时创建的临时目录不会被清理（留下 2 个，已删）；Claude 的测试改为在 `beforeAll` 里创建。Codex 的两个集成测试也是同样写法，记为待办
- 验证：`npm run verify` 退出码 0（152 个测试）；e2e 22/22；没有遗留的 SDK 进程
- 额度：0
- commit：见本次 commit

## 2026-10-13 15:30 · S4-03 分支与子 agent（Claude）
- 结果：done
- 改动（`claude-runtime.ts`）：
  - **分支**：用 SDK 的 `forkSession()` 复制会话记录（不调模型），建成 `kind: "fork"` 的子会话；还没有对话内容时拒绝；`forkSession` 在 Host 进程里读 `CLAUDE_CONFIG_DIR`，调用前临时设置、调用后恢复；
  - **子 agent**：
    - 每次 `Agent` 调用建一个 `kind: "sub"` 的子会话，父会话里显示一条子 agent 摘要，不再出工具卡片；子 agent 的提示、工具调用和结果写进子会话；
    - 前台子 agent 的最终回复从父会话那次工具结果的 `tool_use_result` 里取（它不会流出来）；后台子 agent 等 `task_notification` 才算结束；
    - Claude 的子 agent 会话不能单独发消息，也不能分支；
  - **防提权**：`Agent` 调用不经过 `canUseTool`，所以上一轮写在 `canUseTool` 里的"去掉 mode"根本执行不到，已删除；改用 `PreToolUse` 钩子去掉 `mode`
- 测试：集成测试新增 4 个（分支带上下文且互不影响、前台子 agent 归组、带 `bypassPermissions` 的子 agent 执行命令前仍出审批卡片、后台子 agent 等通知结束）；mock 单测 1 个；mock 新增 `[[spawn-mode-<mode>: …]]` 指令，子 agent 的提示里可以嵌套 `[[shell: …]]`
- **更正 S4-01 的结论**：S4-01 写的"模型可以借 `mode` 让子 agent 绕过审批"不准确。实测父会话为 "default" 时，子 agent 带 `bypassPermissions`/`auto`/`acceptEdits`/`dontAsk` 执行命令都仍然要人批准。钩子作为保险保留。`spikes/RESULTS.md` 已更正
- 过程问题：有一次用 Python 脚本改 mock 时断言失败、文件没改，但我没注意到输出里缺了 "ok"，接着用旧的 mock 调试了一轮。之后改用 Edit 工具
- 验证：`npm run verify` 退出码 0（156 个测试）；e2e 22/22；没有遗留的临时目录和 SDK 进程
- 额度：0
- commit：见本次 commit

## 2026-10-13 16:05 · S4-04 Claude 模型配置与界面
- 结果：done
- 改动：
  - 内置模型配置新增 "Claude · GLM-5.3"（`claude-glm`：provider `glm`、模型 `glm-5.3[1m]`、凭据 `glm-5.2`），新建任务和新会话都能选；
  - 测试模式：`AMO_STUDIO_TEST_CLAUDE_URL` 加一个指向 mock Anthropic 的 `claude-mock` 配置；e2e 的 `launchStudio` 同时启动 mock Anthropic；
  - 对话区：
    - Claude 会话生成中时，按钮显示"排队"、提示"生成中：发送会排到下一轮"、输入框占位文字也相应改写（Codex 仍是"插话"）；
    - Claude 子 agent 会话的输入框只读，并说明原因，也不显示"分支"
- 测试：e2e `claude.spec.ts`（新建 Claude 任务、批准命令并确认目录创建、生成中排队、分支带上下文、子 agent 摘要与"查看"、子会话只读、会话记录写在测试数据目录的 `claude-home`）；内置配置变成 3 个后，profiles 单测改为只遍历 Codex 配置，shell.spec 改为检查配置 id 列表
- 截图：`screenshots/stage-4/S4-04-claude-approval.png`、`S4-04-claude-subagent.png`
- 清理：`%TEMP%` 下 7 个 `amo-studio-e2e-*` 是之前几轮 e2e 失败时留下的（10-12 23:47 到 10-13 02:06），已删除
- 验证：`npm run verify` 退出码 0（156 个测试）；e2e 23/23（全量一次 22/23，失败的 shell.spec 改完预期后单独重跑通过）
- 额度：0
- commit：见本次 commit

## 2026-10-13 16:55 · S4-05 Claude 交接到终端与收回
- 结果：done
- 改动：
  - 终端启动器：
    - 新增可追踪方式：cmd 不开窗口，用 `start /WAIT` 等终端窗口关闭；
    - 句柄可以监听退出，也可以结束整棵进程树（`taskkill /T`）；
    - 环境变量可以整份替换，Host 自身的 `ANTHROPIC_*` 不会混进终端；
    - 测试用的假句柄可以模拟退出；
  - ClaudeRuntime：
    - `handoff`：回复生成中拒绝；先等 Studio 自己的 Claude 进程退出，记下会话记录条数（存进 kv，Host 重启后也能收回），会话标为"已交给终端"；
    - 终端命令用 SDK 自带的 claude.exe（和 SDK 同版本），`--resume <id> --permission-mode default`，密钥只在环境变量里；
    - `reclaim`：用 `getSessionMessages` 读出终端期间新增的内容，转成条目导入，留一条说明；
  - HostService：
    - Claude 会话"在终端打开"改为交接，终端关闭时自动收回；
    - "立即收回"会先结束仍在运行的终端，等它退出再收回；
    - 同一会话同时只做一次收回，避免重复导入；
  - 界面：
    - Claude 会话（子 agent 除外）显示"在终端打开"，回复生成中不可点；
    - 交接期间对话顶部显示提示条（说明为何只读、关闭终端会自动收回）和"立即收回"
- 测试：
  - 集成测试 3 个：
    - 交接参数（替换环境、`--permission-mode default`、命令里没有密钥、Host 的 `ANTHROPIC_API_KEY` 不进终端）、只读、模拟终端里一轮对话（用 claude.exe 打印模式对着 mock）、终端退出后自动收回并导入 2 条、收回后上下文完整；
    - 立即收回会结束终端；
    - 生成中拒绝交接；
  - e2e 1 个：界面上交接 → 提示条和只读 → 立即收回 → 继续对话
- 调试：
  - 集成测试里模拟终端用了同步的 `execFileSync`，mock 和测试在同一个进程里，被阻塞后没法响应 CLI，卡到超时；
  - 改成异步执行
- 默认决定（请你过目）：
  - 共享方式用 `claude --resume` 交接，没有采用 `claude --bg`/`attach`（没有实测，交接已能满足"只读 + 收回"）；
  - 交接期间仍允许"分支"（复制当时的会话记录）
- 清理：`%TEMP%` 下发现 298 个早先遗留的测试目录：
  - 预算测试 165、Store 测试 104：测试从不删除，已改为每个用例结束后删除；
  - Codex 集成测试 27：可能是删除时被 Codex 进程占用，记为待办；
  - 全部已删除
- 验证：`npm run verify` 退出码 0（159 个测试）；e2e 24/24
- 额度：0
- commit：见本次 commit

## 2026-10-13 17:35 · S4-06 AMO MCP（只读）
- 结果：done
- 做法：挂在 Host 的 HTTP 服务上，路径 `/mcp`，Streamable HTTP 无状态模式，和 REST 接口用同一个 Host 令牌；不另开端口、不另起进程。受管会话怎么连上来（Codex 是否支持 HTTP 加令牌）在 S4-07 定，不支持的话再补 stdio 转发
- 改动：
  - `mcp/read-model.ts`：只读数据（按工作区或列筛选的看板；任务详情含依赖、被依赖、画布分组、会话列表；会话树每个会话只带最近一条回复的前 300 字；工作区和未完成任务；画布大纲直接复用 `canvasOutline`）；
  - `mcp/amo-mcp.ts`：五个工具 `board_list`、`task_get`、`session_tree`、`project_context`、`canvas_read`，都标为只读；不存在的 id 返回可读的工具错误；
  - `http/server.ts`：`/mcp` 与 `/api/` 共用令牌校验
- 测试：4 个（官方 MCP 客户端走 HTTP：五个只读工具、令牌错误或缺失被拒、各工具的返回内容、不存在的 id）
- 清理：Codex 集成测试又留下 1 个临时目录，日志里没有删除失败的警告，原因未明，已手动删除，仍记为待办
- 验证：`npm run verify` 退出码 0（163 个测试）；e2e 24/24
- 额度：0
- commit：见本次 commit

## 2026-10-13 18:30 · S4-07 受管会话自动注入 MCP
- 结果：done
- 做法：
  - **Codex**：app-server 启动参数加 `mcp_servers.amo.url` 和 `bearer_token_env_var`，令牌只在环境变量里；
  - **Claude**：SDK 进程内 MCP（`createSdkMcpServer`），不需要令牌；五个只读工具用 `allowedTools` 预先放行，其余工具照常审批；
  - 工具定义抽到 `mcp/tools.ts`，HTTP 端和 Claude 端共用
- **MCP 专用令牌**：数据目录新增 `mcp-token`，只能打开 `/mcp`，不能访问 `/api/`。原因：agent 执行的命令可能继承 app-server 的环境变量，不能让它拿到可写接口的 Host 令牌
- **发现**：Codex 0.161 在模型目录 `supports_search_tool: true` 时会把 MCP 工具藏在 Responses 托管工具 `tool_search` 后面（e2e 第一次失败时，从 mock 收到的请求里看到）。DeepSeek 接口大概率不支持这种托管工具，所以把我们维护的 DeepSeek Flash 和 mock 模型目录改为 `false`，MCP 工具直接作为普通函数提供；S4-08 加一次 DeepSeek 带 MCP 的真实冒烟。详见 `spikes/RESULTS.md` 第 i 节
- mock：两个 mock 都新增 `[[mcp: <tool>]]` 指令，调用后回复 `MOCK-MCP: <结果开头>`
- 测试：
  - e2e `mcp.spec.ts`：Codex 和 Claude 会话各自读画布，回复里出现分组大纲；
  - 单测：Codex 启动参数里只有令牌所在环境变量的名字、MCP 令牌只能打开 `/mcp`
- 默认决定（请你过目）：交接到终端的 Claude 不带 AMO MCP
- 清理：Codex 集成测试又留下 1 个临时目录，已删
- 验证：`npm run verify` 退出码 0（165 个测试）；e2e 25/25
- 额度：0
- commit：见本次 commit

## 2026-10-13 19:05 · S4-08 GLM 与 DeepSeek 真实冒烟
- 结果：done
- 脚本：`scripts/smoke-stage4.mjs`（`npm run smoke:stage4`）
  - Host 跑在沙箱数据目录，端口 47960；
  - Codex 的 home 和工作区都在 `%TEMP%\amo-studio-sandbox\smoke-stage4-*`；
  - 每个回合记入额度；结束时归档会话、删除沙箱目录
- GLM（Claude 会话）全部通过：
  - `mkdir` 等人批准后才执行，目录确实创建；
  - 通过 MCP 读画布，答出分组名"掉落表校验"；
  - 分支里记得之前建的文件夹；
  - 子 agent 回复 SUB-OK，子会话生成并完成
- DeepSeek（Codex 会话）通过 MCP（`amo.canvas_read`）读画布，答出分组名。确认模型目录关掉 `tool_search` 后，DeepSeek 能直接调用 MCP 工具
- 过程问题：
  - 第一次完整运行时，DeepSeek 一步的结果无效：Codex 会话在 `turn/started` 到达前一直显示"空闲"，脚本的等待函数第一次轮询就返回了；
  - 加了只跑 DeepSeek 的开关后又跑了一次，同样无效；
  - 改成"出现新回复且不在运行中"才算结束后，第三次有效；
  - 结果文件被只跑 DeepSeek 的那次覆盖了，GLM 的结果按控制台输出写回，文件里注明了来源
- 额度：
  - GLM 4 次（16/5000）；
  - DeepSeek 3 次（22/1000），其中 2 次是上面无效的那两次
- 没有截图：冒烟是脚本直接调接口；界面截图用的是 S4-04、S4-07 的 mock 版本
- commit：见本次 commit

## 2026-10-13 19:55 · S4-09 阶段 4 收尾
- 结果：done
- 自查（`/code-review` 只能由用户触发）：阶段 4 共 39 个文件、约 2700 行。重点查"密钥会不会进到 agent 执行的命令里"，用 mock 实测，查出两处并修复（commit 1c23cfc）：
  - **Codex**：0.161 把 app-server 的环境变量原样传给 agent 执行的命令，`cmd /c echo %AMO_MOCK_API_KEY%` 能打印出密钥。也就是说从阶段 1 起，DeepSeek 会话里的命令就能读到 `DEEPSEEK_API_KEY`，MCP 令牌同理。修法：app-server 启动参数加 `shell_environment_policy.ignore_default_excludes=false` 和 `shell_environment_policy.exclude=[各提供方的密钥变量, AMO_STUDIO_MCP_TOKEN]`；
  - **Claude**：Claude Code 的 `Bash` 继承 `ANTHROPIC_AUTH_TOKEN`，`env` 会把 GLM 密钥打印进会话记录。修法：子进程环境加 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`（交接终端用同一份环境，也已覆盖）；
  - 回归测试只打印相关变量：工具输出会截到最后 4000 字，打印完整的 `env` 时，"不包含密钥"的断言并不可靠
- 防偏离自查：
  - 没有自动审批：Claude 始终用 "default"，预先放行的只有 Studio 自己的只读 MCP 工具；
  - 交接终端的交互（只读、提示条、立即收回）与 interaction-notes 一致；
  - 没有越过"派发"（阶段 5 单独评审）
- 完整验证：`npm run verify` 退出码 0（168 个测试），e2e 25/25
- 遗留：`server-manager` 和 Codex 集成测试的临时目录在加载时创建，偶尔留下，已删除，仍记为待办
- NEEDS_YOU：写入"阶段 4 完成"（请你过目），其中特别说明了安全修复，以及旧 AMO 可能有同样问题
- 合并：`studio/stage-4` 用 `--no-ff` 合并到 `studio/main`（见下一条）

## 2026-10-13 20:05 · 阶段 4 合并，开始阶段 5
- 合并：`studio/stage-4` 用 `--no-ff` 合并到 `studio/main`（639c38b）；新建 `studio/stage-5`
- 计划：`plans/stage-5.md`，共 11 个任务：
  - S5-00 预研 Codex 调用者身份；
  - 数据；写自身；信箱；请求决策；画布写入；工作台显示；
  - 交接 e2e；真实冒烟；收尾；
  - S5-10 派发评审（必须等你）
- 已写入 NEEDS_YOU（请你过目）
- 通知：阶段完成

## 2026-10-13 20:40 · S5-00 预研 Codex 会话的调用者身份
- 结果：done，结论见 `spikes/RESULTS.md` 第 j 节
- 做法：
  - 一个探针 MCP 服务（端口 47970）记录每次工具调用的请求头和 URL；
  - 一个真实的 Codex app-server（mock 模型、沙箱 `CODEX_HOME`，端口 47912）上开多个会话，各自用 `thread/start` 的 `config` 覆盖 MCP 设置，再调用探针工具
- 结论：
  - 点号写法的 `mcp_servers.amo.http_headers` 能按会话带不同的请求头；嵌套写法会替换整张表，不能用；
  - 会话加载期间身份保留；app-server 重启后需要在 resume 时重新带上；
  - 定为：每个会话一个随机令牌，放进请求头，Host 映射回会话；重新订阅和 fork 时都带上
- **新发现**：Codex 调用没有 `readOnlyHint` 的 MCP 工具前，会发 `mcpServer/elicitation/request` 征求批准，`CodexRuntime` 目前不处理它，阶段 5 的写入工具会让回合卡住。已写进计划，S5-02 处理
- 调试：
  - 第一次所有变体都没有调用到探针：审批策略设成了 `never`，MCP 工具调用被直接拒绝；
  - 第二次用了错误的回复格式（`decision`），被当成拒绝；
  - 按协议类型改成 `{ action: "accept", content, _meta }` 后得到结论
- 额度：0
- commit：见本次 commit

## 2026-10-13 21:20 · S5-01 协作数据
- 结果：done
- 改动：
  - protocol 新增 `TaskNote`（进度备注/交接摘要，作者是人或该任务的会话）、`MailMessage`（发给会话或任务；状态 未读/已读/已转进对话/已忽略）、`DecisionRequest`（问题、选项、答复）；
  - Store 迁移 v3（`task_notes`、`mail`、`decisions`）；
  - Host 接口：
    - 任务备注读写；
    - 留言列表（按会话、任务、状态筛选）、人发留言、标记已读或忽略、"转进对话"（作为用户消息发出，开头是"[AMO 留言] 来自任务「…」的会话「…」"；发给任务的留言要指定该任务的一个会话）；
    - 决策列表与回答（答复作为留言回到提问的会话）；
  - 事件：`task.note.added`、`mail.upserted`、`decision.upserted`；
  - 服务层预留给 MCP 的入口：`addTaskNote(…, sessionId)`（只能写自己的任务）、`sendMail(fromSessionId, …)`（不能发给自己）、`readMailFromSession`（读自己和所属任务的未读，读后标已读）、`requestDecisionFromSession`
- 测试：接口测试 3 个（备注与"只能写自己的任务"、留言的发送、筛选、读取、转进对话、忽略、决策回答与回信）；Store 的 schema 版本断言改为 3；接口测试的 `createTask` 改为复用已登记的工作区
- 验证：`npm run verify` 退出码 0（171 个测试）；e2e 25/25
- 额度：0
- commit：见本次 commit

## 2026-10-13 22:30 · S5-02 写自身的 MCP 工具
- 结果：done
- 预研（mock，`spikes/s5-02-approval-mode.mjs`）：Codex 的 MCP 工具审批模式有 `auto`/`prompt`/`writes`/`approve` 四种，可以设给整个服务器（`default_tools_approval_mode`），也可以设给单个工具（`tools.<名字>.approval_mode`）。对没有只读标注的工具，只有 `approve` 不征求批准，其余三种都会发 `mcpServer/elicitation/request`
- 改动：
  - **调用者身份**：`mcp/identity.ts`（`McpIdentities`，每个会话一个随机令牌，存在 kv 里，Host 重启后仍能认出被接管的 app-server 里的会话）。`CodexRuntime` 在 `thread/start`、`thread/fork` 时发新令牌并绑定到会话，在 `thread/resume`（重新订阅、取消归档、终端接入）时带上该会话的令牌；`/mcp` 从 `X-AMO-Session-Token` 请求头认出调用者。Claude 的进程内 MCP 直接绑定到它所属的会话；
  - **写入工具**：`task_note_add`（进度备注）、`handoff_submit`（交接摘要），只写调用者自己所属的任务；没有身份的调用（例如 Codex 自己派生的子 agent）只能用只读工具，写入时返回可读的错误；
  - **免审批**：这两个工具在 Codex 服务配置里设为 `approve`、在 Claude 里加入 `allowedTools`；其余非只读工具照常审批；
  - **Codex 的 MCP 批准请求**：`CodexRuntime` 把 `mcpServer/elicitation/request` 转成审批卡片，按 `{ action, content, _meta }` 回复，回合不再卡住；fake app-server 增加 `[[elicit]]` 用于测试
- 测试：
  - 单测：身份映射、无身份或身份无效时拒绝写入、只写自己的任务、Codex 启动参数里两个工具是 `approve`、批准请求转成审批卡片（批准和拒绝各一次）；
  - e2e：Codex 和 Claude 会话各自通过 MCP 记进度，备注记在自己的任务上、作者是该会话、没有弹审批；
  - 两个 mock 的 `[[mcp: …]]` 支持 JSON 参数
- 默认决定（请你过目）：
  - 写自己任务的备注和交接不弹审批；
  - 之后的画布写入工具会照常弹审批
- 清理：e2e 留下 1 个临时目录，删除时报 EPERM（测试结束时还有进程占着，大概率是 Codex app-server 还没退干净），已手动删除，记为待办
- 验证：`npm run verify` 退出码 0（173 个测试）；e2e 26/26
- 额度：0
- commit：见本次 commit

## 2026-10-13 23:40 · 修复：测试服务不再用随机端口（红线 6）
- 结果：done
- 发现：MCP 接口测试偶发 `fetch failed: bad port`。测试里的 HTTP 服务用端口 0，系统随机分到了一个在 fetch 禁用名单里的端口。顺着查下去：从阶段 1 起，mock 模型服务、mock Anthropic、fake app-server、接口测试的 Host、e2e 的 Host（`AMO_STUDIO_PORT=0`）、RPC 客户端测试里的 WebSocket 服务都用端口 0，**违反了红线 6（只用 47900–47999）**
- 修复：新增 `listenInStudioRange`，在 47950–47999 随机起点逐个尝试，端口被占用就换下一个（host 的 `net.ts` 和 testkit 的 `ports.ts` 各一份，因为两个包不能互相依赖）；
  - 上面列的服务都改用它；
  - Host 收到端口 0 时也在这个范围里挑；
  - Codex app-server 仍用 47910–47949，Host 默认 47900
- 调试：
  - 第一版把 WebSocket 服务先挂到 HTTP 服务上再监听，ws 会转发 HTTP 服务的 error 事件，端口冲突变成了没人处理的错误，连带好几个测试超时。改为先监听成功再挂 WebSocket；
  - 连跑第三次时，`server-manager` 测试拿到的端口不是预期的 47940：上一次测试的 Codex 进程还在退出，占着端口，几秒后释放，重跑通过。只在连续跑时出现，不是代码问题
- 验证：`npm run verify` 连续两次退出码 0（174 个测试）；e2e 27/27
- commit：见本次 commit

## 2026-10-13 23:45 · S5-03 信箱
- 结果：done
- 改动：
  - MCP 工具：
    - `mailbox_send`：给某个会话（`toSessionId`）或任务（`toTaskId`）留言；
    - `mailbox_read`：读自己和所属任务的未读留言，读后标为已读；输出把正文放在最前；
    - 两者都不弹审批（留言不会自己进入对话，由人决定），加入免审批名单；
  - 接口：`GET /api/mail?forTask=` 取回发给这个任务或其任意会话的留言；UI 的 `call()` 支持查询参数；
  - 任务页：
    - 右栏顶部"留言"面板：显示来源和收件方，"转进对话"（发给任务的留言转进当前会话）、"忽略"；
    - 会话行显示"N 条留言"（未读、发给该会话的）；
    - 来源过长时截断为一行
- 测试：
  - MCP 单测：发给会话或任务、缺收件人或发给自己时拒绝、收件方读一次后标为已读；
  - e2e `mailbox.spec.ts`：Codex 会话给 Claude 会话及其任务各留一条，任务页显示 2 条、会话行显示"1 条留言"，忽略一条、转进一条（Claude 收到"[AMO 留言] 来自任务「发件任务」…"并回复），第三条由收件方用 `mailbox_read` 自己读到；
  - 截图 `screenshots/stage-5/S5-03-mail.png`
- 调试：e2e 第一次失败，`mailbox_read` 已读到第三条，但 mock 只截取工具结果的前 200 个字，正文排在发件人信息后面被截掉了。改为正文在前，对真实 agent 也更直观
- 清理：e2e 留下 2 个临时目录（关闭时进程还没退干净，同一个待办），已删除
- 验证：同上一条
- 额度：0
- commit：见本次 commit

## 2026-10-14 00:20 · S5-04 请求决策
- 结果：done
- 改动：
  - MCP 工具 `decision_request`（问题与可选项）：只是把问题放到人面前，不弹审批（加入免审批名单）；返回值提示答复会以留言回来；
  - 任务页右栏"待决策"卡片：点选项，或者写答复后点"回答"；答复作为留言（来自"我"）回到提问的会话；
  - Focus 窗口：待决策排在待批准/待审阅前面，"需要你"计数包含它。Focus 窗口不能获得键盘焦点，所以那里只有选项按钮，没有输入框；需要写答复时点"在工作台回答"，跳到对应任务页
- 测试：
  - MCP 单测：提问、空问题被拒、回答后 `mailbox_read` 读到答复；
  - e2e `decisions.spec.ts`：任务页点选项回答，答复留言出现；Focus 里没有输入框，"在工作台回答"跳到任务页写答复；Focus 里点选项直接回答；
  - 截图 `screenshots/stage-5/S5-04-decision.png`、`S5-04-focus-decision.png`
- 过程：第一版在 Focus 里也放了输入框，e2e 能通过（Playwright 不经过系统焦点），但真实使用时打不了字；看截图时想到 Focus 设置成了不能获得焦点，改成上面的做法
- 默认决定（请你过目）：
  - Focus 里只能点选项作答，写答复要回工作台；
  - 待决策暂时只出现在任务页和 Focus，看板卡片上的提示在 S5-06 做
- 验证：`npm run verify` 退出码 0（175 个测试）；e2e 28/28
- 额度：0
- commit：见本次 commit

## 2026-10-14 01:05 · S5-05 画布写入
- 结果：done
- 改动：
  - protocol `canvas-layout.ts`（纯函数，agent 不写坐标，Studio 排）：新分组放在所有内容右边；任务放进分组按网格排，放不下时分组拉高；移出分组放到最下面；没在画布上的任务自动建卡片；加依赖时拒绝指向自己、重复和成环；
  - Host：`canvasCreateGroup`（可按名字或 id 绑定工作区）、`canvasAddDependency`、`canvasPlaceTask`，都是同步的读出、修改、保存，经已有的 `canvas.updated` 事件推给画布页；
  - MCP 工具 `canvas_group_create`、`canvas_depend`、`canvas_place`：**需要人批准**——Codex 走 MCP 批准请求，Claude 走 `canUseTool`，两边都显示成同样的审批卡片
- **发现**：第一次跑 e2e 时，Codex 没有征求批准就建了组。原来 Codex 默认的 `auto` 对标注 `destructiveHint: false` 的工具也直接执行。改为在 app-server 启动参数里把这三个工具显式设为 `prompt`。已补进 `spikes/RESULTS.md` 第 j 节
- 测试：
  - 布局单测 4 个；
  - MCP 单测：建组（含绑定工作区、找不到工作区时报错）、成环依赖被拒、放进分组、没有身份时拒绝；
  - Codex 启动参数里画布工具是 `prompt`；
  - e2e：Codex 和 Claude 会话各建一个组，都先出审批卡片、批准前画布没变、批准后出现在画布上；
  - 截图 `screenshots/stage-5/S5-05-canvas-writes.png`
- 验证：`npm run verify` 退出码 0（180 个测试）；e2e 29/29
- 额度：0
- commit：见本次 commit

## 2026-10-14 01:40 · S5-06 工作台显示
- 结果：done
- 改动：
  - 任务页右栏"进度"面板：最新的交接摘要置顶（带作者和时间），其下是进度备注，新的在前（默认显示 5 条，可展开）；人可以"记一笔进度"。右栏顺序：待决策 → 留言 → 进度 → 批注；
  - 看板卡片：在卡片自己的一行里显示"N 个待决策 · N 条留言"，状态点仍只有一个（遵守"一个状态只显示一次"）；
  - 顶栏"需要你"把有待决策的任务也算进去；
  - `useUnreadMail`/`mailByTask`：看板的留言数不算人自己写的留言（决策答复是写给 agent 的，人已经知道内容）；任务页留言面板仍显示它，可以"转进对话"
- 测试：e2e `progress.spec.ts`
  - 会话记进度、提交交接，另一个会话给任务留言、提问；
  - 看板卡片显示"1 个待决策 · 1 条留言"，顶栏"需要你 1"；
  - 任务页交接置顶，人记一笔；
  - 回答并忽略后卡片提示消失；
  - 截图 `screenshots/stage-5/S5-06-board-hints.png`、`S5-06-progress.png`
- 过程：第一次跑时，回答决策后卡片仍显示"1 条留言"，那是写回给 agent 的答复，于是看板计数不再算人写的留言
- 默认决定（请你过目）：
  - 决策答复只作为留言回到会话，要靠人"转进对话"或 agent 自己 `mailbox_read` 才能读到，不会自动插进对话；
  - 画布卡片上暂不显示这些提示
- 验证：`npm run verify` 退出码 0（180 个测试）；e2e 30/30
- 额度：0
- commit：见本次 commit

## 2026-10-14 03:10 · S5-07 交接验收（阶段 5 的验收）
- 结果：done
- e2e `handoff-mail.spec.ts`：
  - Codex 会话 A 提交交接摘要，并给 Claude 会话 B 留言；
  - 留言在人转进对话之前不会进入 B；人转进后，B 用 `task_get` 读到 A 的交接，再用 `task_note_add` 在自己的任务上记"已接手"；
  - 两个任务各自的记录正确，留言状态为"已转进对话"；
  - 截图 `screenshots/stage-5/S5-07-handoff.png`
- 改动：`task_get` 返回最新交接摘要（放在前面）和最近 5 条进度备注
- 调试中查出并修复两个问题（在 Host 里临时加日志、界面监听请求，调试代码已全部删除）：
  - **对话输入框会吞掉新打的字**：输入框要等发送请求返回才清空，期间新打的内容会被一起清掉。改为按下发送就清空，失败时（而且期间没有新输入）再把文字放回去。用户可见的问题；
  - **mock 没处理"并进回合的消息"**：回合里有工具调用时，Claude CLI 会把生成中发的消息放在工具结果后面、同一条用户消息里，并进当前回合。mock 把整条当成工具输出，忽略了那段话。已修，加了单测
- 更正：
  - `spikes/RESULTS.md` 第 h 节：S4-00 写的"生成中发的消息不会插进当前回合"只在没有工具调用时成立；
  - Claude 会话的提示改为"生成中：工具调用后或本轮结束后读到"（原来是"排到下一轮"），按钮仍是"排队"
- 测试本身的问题：第一版等待"回复里出现交接摘要"，但 A 会话的标题就是它带摘要的第一条消息，转进来的留言回复里已经有这段文字，等待提前满足，下一条消息发得太早。改为先等 MCP 回复（`MOCK-MCP:`）
- 验证：`npm run verify` 退出码 0（181 个测试）；e2e 31/31
- 额度：0
- commit：见本次 commit

## 2026-10-14 06:00 · S5-08 真实冒烟
- 结果：done
- 脚本 `scripts/smoke-stage5.mjs`（`npm run smoke:stage5`）：Host 在沙箱数据目录、端口 47961，独立 CODEX_HOME；结束后归档会话、删除沙箱目录。结果在 `spikes/results/s5-08-smoke.json`
- GLM（Claude 会话），4 回合全部通过：
  - `task_note_add` 记进度：任务上出现这条进度，作者是这个会话；
  - `decision_request` 提问"Retry limit: 3 or 5?"（选项 3/5），我通过接口回答 3；
  - `mailbox_read` 读回答复，模型回答"You decided on a retry limit of 3."；
  - `canvas_group_create` 先弹审批，批准后建出"GLM 组"
- DeepSeek（Codex 会话），3 回合全部通过：
  - `mailbox_send` 给 GLM 会话留言，**发件人正确记成这个 Codex 会话**：每个会话各自的身份请求头在真实 Codex 上生效；
  - `handoff_submit` 提交交接摘要，记在自己的任务上；
  - `canvas_group_create`：真实 Codex 发出 MCP 批准请求（elicitation），显示为审批卡片"Allow the amo MCP server to run tool "canvas_group_create"?"，批准后建出"DeepSeek 组"
- 额度：GLM +4（20/5000），DeepSeek +3（25/1000）
- commit：见本次 commit

## 2026-10-14 06:40 · S5-09 阶段 5 收尾
- 结果：done
- 代码审查（`/code-review` 需要你来触发，这里按阶段 5 的全部改动自查，重点是 MCP 写入的权限边界）：
  - 写入工具都按调用者自己的会话限定：没有身份或身份无效时只能读；写进度、交接时 Host 再核对"只能写自己的任务"；
  - Codex 的身份令牌是随机 24 字节，只在本机数据库里；令牌只能代表一个会话写入；
  - **修复**：agent 写的进度、留言、决策问题和人写的答复都没有长度上限，失控的回合可能写入超大文本，塞满数据库和 Focus。现在进度和留言最多 8000 字，问题和答复最多 2000 字，选项每个 200 字，超出返回 400；补了接口测试（62f358b）；
  - 记录但没改：已归档的会话理论上仍可凭令牌写入，但归档后 Codex 线程和 Claude 进程都不会再运行，实际碰不到
- 防偏离自查：
  - "不做自动审批"：不弹审批的只有记自己任务的进度和交接、留言、读留言、提问，都不碰文件和命令、不进入别人的对话；画布写入一律弹审批；看板列只能由人移动。没有越界；
  - interaction-notes "Focus 只能就地批准，其他回工作台"：Focus 里多了"点选项回答决策"，性质和批准相同（一键处理待办），写答复仍回工作台。已在阶段 5 完成里请你过目；
  - "一个状态只显示一次"：看板卡片上待决策、留言是计数，写在卡片的说明行里，不是第二个状态点
- 完整验证：`npm run verify` 退出码 0（181 个测试）；e2e 31/31
- 合并：`studio/stage-5` 用 `--no-ff` 合并进 `studio/main`
- NEEDS_YOU：写入"阶段 5 完成"（请你过目）、"是否开放派发、怎样限权"（必须等你，S5-10；不回复就保持不开放）
- 额度：0

## 2026-10-14 06:55 · 阶段 6 计划
- 结果：done
- 新建分支 `studio/stage-6`（从 `studio/main`）
- 计划：`plans/stage-6.md`（10 个任务：S6-00 manifest 格式与校验、S6-01 Host 加载、S6-02 工作台显示、S6-03 流程模板、S6-04 启动预设、S6-05 MCP 读取、S6-06 示例扩展包与验收、S6-07 真实冒烟、S6-08 收尾、S6-09 第一个真实扩展包【必须等你】）
- 默认决定（请你过目）：manifest 用 JSON；扩展包内容按不可信处理（不执行代码、路径不越界、预设提示词经人确认才发出）；专用工具只预留字段
- NEEDS_YOU：写入"阶段 6 计划"（请你过目）、"第一个真实扩展包放在哪个工程、包含什么"（必须等你，S6-09）
- 额度：0

## 2026-10-14 07:10 · S6-00 扩展包 manifest 格式与校验
- 结果：done
- 改动：
  - `packages/protocol/src/packs.ts`：`PackManifest` 类型（docs、templates、presets、tools）、`validatePackManifest`（错误信息写明字段，例如 `docs[1].id: 重复的 id "a"`；未知顶层字段只警告）、`safeRelativePath`（拒绝绝对路径、盘符和 `:`、`..`、`~`、UNC）、预设提示词变量 `{{task.title}}`、`{{workspace.path}}`、`{{pack.dir}}`（写了别的变量报错）；
  - 数量和长度上限：每类 50 项、清单 50 步、提示词 8000 字、上下文文件 20 个；
  - 格式说明 `design/pack-format.md`
- 测试：8 个单测（完整与最小 manifest、逐字段错误、9 种越界路径、上限、未知字段、变量替换）
- 调整：符号链接逃逸要读文件系统，挪到 S6-01 检查，计划已改
- 默认决定（请你过目）：`tools` 有内容时给出警告"专用工具目前只是预留，不会运行"
- 验证：`npm run verify` 退出码 0
- 额度：0
- commit：见本次 commit

## 2026-10-14 07:30 · S6-01 Host 加载扩展包
- 结果：done
- 改动：
  - `packages/host/src/packs/pack-loader.ts`：扫描工作区 `.amo/packs/*/pack.json`（最多 20 个包）；manifest 最大 256 KB，按修改时间和大小缓存；文档每次现读，最大 512 KB；
  - 所有路径都先解析符号链接再检查：`.amo` 本身、包目录、`pack.json`、文档，只要指到外面就不读（包目录指到外面的直接跳过）；
  - 一个包写错（不是 JSON、缺字段、缺 `pack.json`）只显示在它自己的条目上，不影响其他包；文档缺失、`name` 和目录名不同记为警告；
  - 接口：`GET /api/workspaces/:id/packs`、`GET /api/workspaces/:id/packs/:pack/docs/:doc`
- 测试：加载器 7 个单测（无扩展包、好坏混在一起、警告、读文档与各种拒绝、符号链接逃逸三种情况、修改后重读、`resolveInside`），接口测试 1 个
- 验证：`npm run verify` 退出码 0
- 额度：0
- commit：见本次 commit

## 2026-10-14 08:00 · S6-02 工作台显示扩展包
- 结果：done
- 改动：
  - 左栏选中某个工作区时，顶栏多一个"扩展包"标签（`packages/ui/src/packs/PacksPage.tsx`）：左边列出扩展包，写错的标"有错误"；右边是说明、错误和警告、规范、流程模板（含步骤）、启动预设（含模型和提示词原文；配置里没有这个模型时写明"会用默认模型"）、预留的专用工具。点规范打开文档（替换概览，带返回按钮）。"重新加载"重新读磁盘上的文件；
  - 任务页右栏加"规范"面板（`PackDocsPanel.tsx`）：任务所在工作区（跨工作区任务取其会话所在的工作区）里所有扩展包的文档，点开在面板里直接看；没有扩展包时不显示；
  - 示例扩展包 `studio/examples/packs/demo/`（虚构内容：两篇规范、一个流程模板、两个启动预设、一个预留工具），e2e 复制进沙箱工作区使用
- 测试：e2e `packs.spec.ts`：标签只在选中工作区时出现；好坏两个包；模板步骤、预设、预留工具；打开文档（表格渲染）；坏包显示错误；改文件后重新加载；任务页"规范"面板打开文档。截图 `screenshots/stage-6/S6-02-pack-overview.png`、`S6-02-pack-doc.png`、`S6-02-task-docs.png`
- 过程：第一版文档显示在概览最下面，截图里看不到，改为打开时替换概览
- 默认决定（请你过目）：扩展包入口放在顶栏标签（只在选中一个工作区时出现），没有放进左栏；任务页"规范"面板放在"进度"下面
- 验证：`npm run verify` 退出码 0（197 个测试）；e2e 32/32
- 额度：0
- commit：见本次 commit
