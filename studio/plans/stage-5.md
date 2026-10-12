# 阶段 5 · 可写 MCP 与协作

分支：`studio/stage-5`（从 `studio/main` 创建）。目标、验收和关卡见 `ROADMAP.md`：会话之间通过 AMO 交接信息，节奏由人掌控。

依据：ROADMAP 阶段 5；`docs/next-gen-vision-architecture-2026-10.md` 第 6 节（MCP 权限分级）；`design/interaction-notes.md` 的总原则（agent 不会自动把卡片移到别的列，由人掌控）；阶段 4 的实际结果（只读 MCP、Codex 走 HTTP、Claude 走进程内服务）。

## 已确定的做法

| 项目 | 做法 | 说明 |
|---|---|---|
| 调用者身份 | 写入类工具都按"调用它的会话"限定范围，不让 agent 自己传会话 id | Claude：每个查询一个进程内 MCP 服务，直接绑定会话。Codex：`thread/start` 时带 `mcp_servers.amo.http_headers.X-AMO-Session-Token = <会话的随机令牌>`，重新订阅和 fork 时也带；没有身份的调用只能用只读工具（S5-00） |
| Codex 写入工具的批准 | 非只读 MCP 工具会触发 `mcpServer/elicitation/request`，`CodexRuntime` 把它转成审批卡片（批准/拒绝），否则回合会卡住 | S5-00 发现 |
| 写自身 | 只能改自己所属任务：追加进度备注、提交交接摘要；**不能**移动看板列、不能改别的任务 | 列由人调整（interaction-notes 总原则） |
| 信箱 | agent 给其他会话或任务留言；接收方在工作台里看到"有 N 条留言"，由人决定是否转进对话；agent 下一轮也可以用工具读自己的留言 | 不自动插进对方的对话 |
| 请求决策 | agent 提出需要人决定的问题（可带选项）；显示在工作台和 Focus；人回答后，答复作为一条留言回到提问的会话 | 不阻塞回合 |
| 画布写入 | 建组、连依赖（拒绝成环）、把任务放进分组 | 坐标由 Studio 自动排，不让 agent 写坐标 |
| 派发 | 新建会话、向其他会话投递任务——**不在本阶段开放**，S5-10 单独评审（必须等你） | |
| 额度 | 开发与 e2e 用 mock；S5-08 冒烟用 GLM 和 DeepSeek，预计 GLM 约 10 次、DeepSeek 约 5 次 | |

## 任务

### S5-00 预研：Codex 会话的调用者身份 · done（结论见 `spikes/RESULTS.md` 第 j 节）
- 依赖：无
- 内容：用 mock 确认 Codex 0.161 能否按会话（thread）给 MCP 带不同的身份，候选做法：`thread/start` 的 `config` 里覆盖 `mcp_servers.amo.http_headers`；按会话下发不同的令牌；或者把会话 id 写进会话的开发者指令里，再由服务端核对。选定做法，写进 `spikes/RESULTS.md`。
- 验收：结论与 mock 实测结果。

### S5-01 数据：进度备注、交接摘要、留言、决策请求 · done
- 依赖：无
- 内容：protocol 实体与 Store 表（迁移 v3），Host 接口与事件。
- 验收：Store 与接口单测。

### S5-02 写自身的 MCP 工具 · todo
- 依赖：S5-00、S5-01
- 内容：`task_note_add`（给自己所属任务追加进度备注）、`handoff_submit`（提交交接摘要）；只作用于调用者自己的任务。
- 验收：单测覆盖"只能写自己的任务"；mock 会话里调用。

### S5-03 信箱 · todo
- 依赖：S5-01、S5-02
- 内容：`mailbox_send`（发给某个会话或任务）、`mailbox_read`（读自己的留言，读后标记已读）；工作台里接收方显示未读数和留言卡片，人可以"转进对话"或"忽略"。
- 验收：单测与 e2e。

### S5-04 请求决策 · todo
- 依赖：S5-01
- 内容：`decision_request`（问题与可选项）；工作台和 Focus 显示待决策，人选择或输入答复，答复作为留言回到提问的会话。
- 验收：e2e（含 Focus 窗口）。

### S5-05 画布写入 · todo
- 依赖：S5-00
- 内容：`canvas_group_create`、`canvas_depend`（拒绝成环）、`canvas_place`（把任务放进分组，坐标自动排）；画布版本冲突时重试。
- 验收：单测与 e2e。

### S5-06 工作台显示 · todo
- 依赖：S5-02～S5-05
- 内容：任务页显示进度备注和交接摘要；看板卡片上的未读留言和待决策提示（遵守"一个状态只显示一次"）。
- 验收：e2e 与截图。

### S5-07 交接的端到端测试 · todo
- 依赖：S5-02～S5-06
- 内容：两个会话（一个 Codex、一个 Claude）通过信箱完成一次交接：A 提交交接摘要并给 B 留言，人把留言转进 B 的对话，B 读到并继续。
- 验收：ROADMAP 阶段 5 的验收。

### S5-08 真实冒烟 · todo
- 依赖：S5-07
- 内容：GLM 与 DeepSeek 各跑一次写自身、留言和请求决策。
- 验收：结果写进日志；用量记入 `budget.json`。

### S5-09 阶段验收与收尾 · todo
- 依赖：S5-00～S5-08
- 内容：`LOOP_RULES` 第 6 节收尾；"请你过目"附截图与试用方式。

### S5-10 【必须等你】派发类能力是否开放、如何限权 · todo
- 内容：写入 NEEDS_YOU（必须等你）：是否开放"新建会话""向其他会话投递任务"，以及限权方式（例如只能在同一任务内、每次都要人批准）。等待期间继续后续阶段中不依赖它的部分。

## 预算预估

GLM 约 10 次，DeepSeek 约 5 次。

## 带过来的待办

- `server-manager` 与 Codex 集成测试的临时目录在加载时创建，偶尔留下。
- 交接终端里的 Claude 不带 AMO MCP。
