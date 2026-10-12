# 阶段 1 · 地基：Host + Codex 会话 + 最小工作台

分支：`studio/stage-1`（从 `studio/main` 创建）。目标、验收和关卡见 `ROADMAP.md`。

## 已确定的技术选择

| 项目 | 选择 | 说明 |
|---|---|---|
| 语言 | TypeScript（strict） | 全部包统一 |
| 包管理 | npm workspaces，根目录为 `studio/` | 不引入 pnpm |
| 目录 | `packages/protocol`、`packages/host`、`packages/app`（Electron 主进程与 preload）、`packages/ui`（React + Vite）、`packages/testkit`（mock 模型、fake app-server、沙盒工具），以及 `e2e/`（Playwright） | |
| 存储 | 优先使用 `node:sqlite`（Node 24 内置），不可用时退回 JSON 加 JSONL 事件日志 | 在 S1-03 确认 |
| Host 进程 | 独立的常驻进程，由 Electron 主进程按需拉起（`ELECTRON_RUN_AS_NODE=1` 复用 Electron 自带的 Node，或者用系统 Node）。用锁文件加端口文件保证单实例 | 在 S1-08 确认 |
| 端口 | Host 默认 47900，Codex app-server 47910～47949 | 见 `LOOP_RULES` 红线第 6 条 |
| 数据目录 | 开发期为 `studio/.data/`（已加入 gitignore）；测试为 `%TEMP%\amo-studio-test-<随机>\` | Portable 的数据目录在阶段 8 处理 |
| 测试 | Vitest 跑单元测试；Playwright 驱动 Electron 跑端到端测试 | 端到端测试一律使用 fake app-server 或 mock 模型 |
| 参考 | DSH 的 `apps/desktop*`、`packages/client/ui-conversation`、`ui-tool`、`ui-subagent`、`ui-permission-presets` | 只参考思路；复制代码要注明出处 |

## 任务

状态值：`todo` | `in_progress` | `done` | `blocked`。每个任务完成后，提交一个 commit。

### S1-00 协议补测 · done（拆成 S1-00a～e；e 的用户验证结果回来后补进 RESULTS）

- 依赖：S1-01（真实调用要先经过 `budget.ts` 计数，2026-10-12 调整）
- 内容：在 `studio/spikes/` 下写脚本，结论记录到 `studio/spikes/RESULTS.md`。
  - a. **审批路由**：两个客户端同时订阅一个 thread，用 `approvalPolicy` 让模型请求执行命令。观察审批请求发给了哪个客户端，先回应的是否生效，另一方收到什么。
  - b. **单 server 多 provider**：同一个 app-server，不带 provider 启动参数，在 `thread/start` 时通过 `modelProvider` 加 `config` 指定 DeepSeek，看能否运行，从而决定是"一个 server 多 provider"还是"每个 provider 一个进程"。
  - c. **重启重连**：app-server 用同一端口和同一 token 重启后，WS 客户端重新连接并 `thread/resume`，能否继续收到事件。
  - d. **其他客户端发起的 fork**：在客户端 A 上 `thread/fork`，客户端 B 能否收到 `thread/started` 之类的事件，以及能否拿到 `forkedFromId`。
- 需要用户配合的部分：在 TUI 里输入 `/fork` 或打开 side chat 后，AMO 侧收到的事件，以及 TUI 自动重连后能否回到原 thread。脚本准备好以后，写入 `NEEDS_YOU.md`（请你过目），不阻塞后续任务。
- 预算：DeepSeek 约 8 次（实际 a～d 计数 16 次，其中 2 次请求打到 OpenAI 被 401，未消耗额度）
- 验收：`RESULTS.md` 对 a～d 各有明确结论，并写清楚对 S1-06 设计的影响。
- 子任务（2026-10-12 拆分，按顺序做）：
  - S1-00a 审批路由 · done
  - S1-00b 单 server 多 provider · done
  - S1-00c 重启重连（顺带测：审批挂起后才订阅的客户端能否补收请求；按 thread 指定 provider 的会话在重启后 `thread/resume` 不带 config 能否恢复路由） · done
  - S1-00d 其他客户端发起的 fork · done
  - S1-00e 准备需要用户配合的 TUI 脚本（`/fork`、side chat、自动重连），写入 NEEDS_YOU · done

### S1-01 脚手架 · done

- 依赖：无
- 内容：
  - npm workspaces 和五个包的骨架；
  - `tsconfig` 基础配置；
  - 脚本：`dev`、`build`、`typecheck`、`test`、`verify`，其中 `verify` 依次执行 typecheck、test、build；
  - `.gitignore`（`.data`、`node_modules`、`dist`、`out`、`screenshots` 之外的临时文件）；
  - `studio/budget.json` 计数工具 `packages/testkit/src/budget.ts`：先检查额度再加计数，超出额度时抛错。
- 验收：在 `studio/` 下 `npm install && npm run verify` 通过，产出空包的构建结果。

### S1-02 数据模型与协议类型 · done

- 依赖：S1-01
- 内容：
  - 在 `packages/protocol` 中定义实体：
    - `Workspace`（id、name、path）
    - `Task`（id、title、scope：工作区 id 或 `area`、column、createdAt、updatedAt）
    - `Session`（id、taskId、parentId、kind：`main` | `fork` | `sub`、runtime：`codex` | `claude`、model profile、workspaceId、archivedAt、runtime 侧 threadId、writer 状态）
    - `SessionItem`：user、agent、tool、approval、subagent 摘要、error 等，并保留原始事件引用
    - `Annotation`、`CanvasDoc`（groups、nodes、edges、notes）、`TodoItem`
  - 定义 Host API 的请求、响应和事件类型。
  - 生成 Codex app-server 的 TS 绑定（`codex app-server generate-ts`，版本号写进文件头），放在 `packages/protocol/src/codex/`，并提供重新生成的脚本。
- 验收：类型检查通过；为实体编写示例数据的单元测试。

### S1-03 存储 · done

- 依赖：S1-02
- 内容：
  - 实现存储层，包括迁移和各实体的 repository；
  - session item 只追加写入；
  - 事件序号保证单调递增；
  - 确认 `node:sqlite` 在当前 Node 和 Electron 环境下可用，不可用则退回备选方案，并在日志里写明。
- 验收：单元测试覆盖增删改查、会话树查询（含归档时连同子孙一起归档）、重启后数据仍在。

### S1-04 测试工具：fake app-server 与 mock 模型 · done（拆成 a、b）

- 依赖：S1-02
- 内容：
  - **fake app-server**：实现 Host 用到的 JSON-RPC 子集，包括 initialize、thread 的 start、resume、fork、archive、read，turn 的 start、steer、interrupt，以及审批类的服务端请求。通过剧本驱动它推送 item 和 delta 事件，用于单元测试和端到端测试。
  - **mock 模型**：在本地实现一个兼容 OpenAI Responses 接口的流式服务，作为 Codex 的 `model_provider`。验证真实的 `codex app-server` 能用它完成一轮对话，从而做到零成本的集成测试。
- 验收：
  - fake app-server 的剧本测试通过；
  - 真实 Codex 加 mock 模型完成一轮对话，不消耗额度。
- 子任务（2026-10-12 拆分）：
  - S1-04a mock 模型（`packages/testkit/src/mock-model.ts`，`npm run test:codex-mock` 用真实 app-server 验证） · done
  - S1-04b fake app-server（剧本驱动的 JSON-RPC 子集） · done

### S1-05 凭据与模型路由 · done

- 依赖：S1-01
- 内容：
  - 只读访问 Windows 凭据管理器，目标名为 `AgentMonitorOverlay/model-provider/<id>`，凭据以 UTF-8 存储。
  - 定义模型 profile：Codex 默认（GPT），以及 Codex DeepSeek Flash。DeepSeek 的 provider 参数参考旧 AMO，但**不要生成 `agents.default_subagent_*`**，Codex 0.161 不支持。
  - Key 只放进子进程的环境变量。
- 验收：单元测试中凭据读取用 mock；用真实凭据做一次只检查长度的冒烟测试，不打印 Key。

### S1-06 Codex runtime · in_progress（拆成 a～d）

- 依赖：S1-00、S1-03、S1-04、S1-05
- 内容：
  - **进程管理**：按 S1-00 的结论（`spikes/RESULTS.md`）：每个模型 profile 一个 app-server，该 profile 设为 server 默认，所有 provider 定义都在启动参数里；fork 显式带 provider；`thread/started` 的 provider 与父 thread 不一致时告警。WS 监听加 capability token，token 文件放在数据目录，权限尽量收紧。崩溃后退避重启，重启后用原端口和原 token。
  - **JSON-RPC 客户端**。
  - **会话操作**：start、resume、fork、archive，turn 的 start、steer、interrupt。
  - **审批**：把审批请求转给 Host，等待人的决定。
  - **事件写入**：事件规范化后写入存储。
  - **父子关系**：fork 时从响应里的 `forkedFromId` 获得；子 agent 从 `subAgentActivity.agentThreadId` 获得。创建时就写入会话树。
  - 列表查询要带上 `modelProviders`。
- 验收：基于 fake app-server 的单元测试和集成测试；基于真实 Codex 加 mock 模型的集成测试。
- 子任务（2026-10-13 拆分）：
  - S1-06a JSON-RPC 客户端（`runtime/codex/rpc-client.ts`） · done
  - S1-06b app-server 进程管理：每个 profile 一个进程，端口和 token 存数据目录，崩溃后退避重启并沿用端口和 token · todo
  - S1-06c 会话操作、事件规范化入库、审批转交、父子关系、provider 不一致告警 · todo
  - S1-06d 集成测试：真实 `codex app-server` 加 mock 模型跑通 start / 审批 / fork / 归档 / 重启恢复 · todo

### S1-07 Host API · todo

- 依赖：S1-06
- 内容：
  - HTTP REST 接口：工作区（登记路径）、任务、会话（新建、恢复、归档、恢复归档）、发消息、插话、打断、审批、生成终端接入命令。
  - WS 事件流。
  - 终端接入：生成 `codex --remote <ws> --remote-auth-token-env <ENV> resume <threadId>`，并在新的终端窗口里执行（token 只通过环境变量传递）。测试模式下只返回命令，不打开窗口。
  - 会话的写入状态。
- 验收：API 集成测试（基于 fake app-server）；Host 重启后数据恢复。

### S1-08 Electron 外壳 · todo

- 依赖：S1-01
- 内容：
  - 主进程：单实例、主窗口、按需拉起或连接 Host；
  - preload 暴露最少的 IPC；
  - 开发模式接入 Vite；
  - 测试模式下窗口不抢焦点（红线第 7 条）。
- 验收：Playwright 能启动应用并截图，窗口不跳到前台。

### S1-09 界面基础 · todo

- 依赖：S1-07、S1-08
- 内容：
  - 设计 token（来自 `interaction-notes` 的视觉一节）；
  - 顶栏（看板 | 画布，画布先占位；"需要你"计数；"+ 新任务"）；
  - 左栏（范围：全部、跨工作区、各工作区；登记工作区的入口）；
  - 看板（四列；卡片显示状态点、状态词、更新时间、会话数）。

  严格按 `design/prototype/Main.dc.html` 和 `interaction-notes` 实现。
- 验收：端到端测试：登记沙盒工作区 → 看板显示；截图。

### S1-10 新建任务页 · todo

- 依赖：S1-09
- 内容：DSH 式空白任务页，布局见 `interaction-notes` 的"新建任务"一节：
  - 标题编辑区在"要推进什么？"下面；
  - 范围选择，包含跨工作区；
  - 底部输入框和模型选择。
- 验收：端到端测试：新建任务 → 进入任务页，第一个会话开始流式回复（fake app-server）。

### S1-11 任务页与对话面板 · todo

- 依赖：S1-10
- 内容：
  - 会话列表：会话树缩进、+新会话、归档区；
  - 对话：markdown（基础渲染，完整审阅留到阶段 2）、流式输出、工具卡片、审批、子 agent 跳转、插话、打断；
  - 写入状态；
  - 在终端打开；
  - 归档与恢复；
  - 任务状态下拉框。
- 验收：端到端测试覆盖审批、插话与打断、fork 和子 agent 的父子关系展示、归档与恢复、终端命令；截图。

### S1-12 真实冒烟与阶段验收 · todo

- 依赖：S1-11
- 内容：
  - 在沙盒工作区用 DeepSeek 真实跑两轮对话（预算约 3 次）；
  - 启动 `codex --remote` 的终端进程，验证能连上，验证完关闭；
  - 验证 Host 重启后会话恢复；
  - 执行 `LOOP_RULES` 第 6 节的阶段收尾。
- 验收：`ROADMAP` 阶段 1 的验收全部通过。写入 `NEEDS_YOU.md`（请你过目）：
  - 截图；
  - 试用说明：如何启动、如何登记一个真实工作区并用一天。登记真实工作区由用户自己操作。

## 预算预估

DeepSeek 约 11 次（S1-00 约 8 次，S1-12 约 3 次），GLM 0 次。
