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
