# User Session Manual

这份手册给用户在频繁开启新 Codex / Claude / Kiro session 时使用。

核心原则：

- 用户只负责验证、vibe 判断、需求细节确认。
- 主管 agent 负责管理项目、拆任务、调度 worker、维护文档和本地 git。
- worker agent 只执行主管 agent 分配的单一任务。
- 新 session 不应该从零理解项目，必须先读取 `PROJECT_PLAN.md` 和本手册。

## 1. 开启主管 Agent Session

适用场景：

- 准备继续推进整个项目。
- 需要梳理当前进度。
- 需要创建或调度多个 worker agent。
- 需要更新阶段计划、任务卡、git 状态。
- 需要把多个 session 的结果收敛成一个用户可验证版本。

推荐对话：

```text
你现在是 Agent Monitor Overlay 项目的主管 agent。

项目路径：
G:\PROJECT\AgentMonitorOverlay

请先读取：
1. PROJECT_PLAN.md
2. USER_SESSION_MANUAL.md

我的角色：
我只负责验证、vibe 判断、需求细节确认。不要让我承担任务拆分、worker 协调、实现审查或冲突合并。

你的职责：
你是唯一对我汇报的角色。你负责维护计划、拆分任务、调度 worker、多 agent 结果收敛、本地 git 管理、阶段 checkpoint、验证清单。

请先做：
1. 梳理当前项目状态。
2. 检查本地 git 状态。
3. 告诉我当前阶段、已完成、下一步任务、需要我确认的问题。

汇报格式：
当前阶段：
本轮状态：
git 状态：
需要我验证：
需要我确认：
下一步计划：
风险/阻塞：
```

## 2. 我要梳理当前内容

适用场景：

- 用户回到项目后不记得当前进展。
- 多个 agent session 跑完后，需要主管 agent 汇总。
- 准备开启新阶段前，需要整理上下文。

推荐对话：

```text
请作为主管 agent 梳理当前 Agent Monitor Overlay 项目内容。

要求：
1. 读取 PROJECT_PLAN.md 和 USER_SESSION_MANUAL.md。
2. 检查当前目录结构和 git 状态。
3. 汇总当前阶段、已完成内容、未完成任务、活跃风险。
4. 不要改代码，除非你发现文档状态明显过期，并先告诉我需要更新什么。
5. 输出我接下来最应该验证或确认的 3-5 件事。
```

期望输出：

```text
当前阶段：
已完成：
未完成：
git 状态：
文档是否过期：
需要你验证：
需要你确认：
建议下一步：
```

## 3. 我要更新文档

适用场景：

- 用户确认了新需求。
- 阶段任务完成，需要更新状态。
- worker agent 完成后，需要主管 agent 回填计划。
- 项目方向有变，需要固化到文档。

推荐对话：

```text
请作为主管 agent 更新 Agent Monitor Overlay 项目文档。

项目路径：
G:\PROJECT\AgentMonitorOverlay

请先读取：
1. PROJECT_PLAN.md
2. USER_SESSION_MANUAL.md

本次要补充/修改的内容：
<在这里写具体变化>

要求：
1. 只更新相关文档，不要改实现代码。
2. 更新后检查文档是否自洽。
3. 检查 git diff，并告诉我改了哪些文件。
4. 如果适合做 checkpoint commit，先说明建议 commit message，再等我确认。
```

常见补充内容：

- 新的 UI vibe 判断
- 新的阶段目标
- 新的风险和限制
- 新的 worker task
- 用户验证结果
- 产品竞品调查结果
- git 分支和 checkpoint 规则

## 4. 我要开启新的 Worker Session

适用场景：

- 主管 agent 已经拆好任务。
- 需要单独开一个 Codex/Claude/Kiro session 去执行某个明确任务。
- 希望 worker 只做一个范围，不扩大任务。

推荐对话模板：

```text
你现在是 Agent Monitor Overlay 项目的 worker agent。

项目路径：
G:\PROJECT\AgentMonitorOverlay

请先读取：
1. PROJECT_PLAN.md
2. USER_SESSION_MANUAL.md

你的任务卡：
Task: <任务名>
Stage: <阶段>
Goal:
- <任务目标>

Allowed scope:
- <允许修改的文件或模块>

Forbidden scope:
- 不要修改未授权文件。
- 不要改变技术栈。
- 不要做 git commit / branch / push。
- 不要扩大任务范围。

Acceptance criteria:
- <完成判定>

Verification:
- <需要运行的验证>

完成后请汇报：
1. 做了什么。
2. 改了哪些文件。
3. 如何验证。
4. 遗留问题。
5. 是否需要主管 agent 或用户决策。
```

worker session 完成后，用户应把 worker 的总结交回主管 agent，而不是自己合并判断。

交回主管的推荐对话：

```text
这是 worker agent 的完成报告，请你作为主管 agent 收敛：

<粘贴 worker 报告>

请你检查：
1. 是否符合任务卡。
2. 是否需要补验证。
3. 是否需要更新 PROJECT_PLAN.md 或任务状态。
4. 是否适合合并到当前阶段分支。
5. 下一步应该调哪个 worker 或让我验证什么。
```

## 5. 我要开启新 Session 继续当前开发

适用场景：

- 当前 session 太长。
- 工具上下文快满。
- 用户想切到另一个 CLI 或 agent。

推荐对话：

```text
我要继续 Agent Monitor Overlay 项目开发。

项目路径：
G:\PROJECT\AgentMonitorOverlay

请先读取：
1. PROJECT_PLAN.md
2. USER_SESSION_MANUAL.md

然后请你：
1. 检查 git status。
2. 梳理当前阶段。
3. 读取最近修改的文档和文件。
4. 告诉我现在最合理的下一步。
5. 如果需要调 worker，请先给出任务卡，不要直接开始大范围改动。

记住：
我只负责验证、vibe、需求确认。
你负责主管汇报、多 agent 调度、本地 git 管理和阶段推进。
```

## 6. 我要做阶段验收

适用场景：

- 某个阶段的代码或文档已经完成。
- 用户准备试用。
- 需要固定一个本地 checkpoint。

推荐对话：

```text
请作为主管 agent 做当前阶段验收。

要求：
1. 读取 PROJECT_PLAN.md。
2. 检查当前阶段的验收标准。
3. 检查 git status 和 diff。
4. 运行或列出必要验证。
5. 给我一份用户验证清单。
6. 如果适合创建 checkpoint commit，请给出建议 commit message，并等我确认。
```

期望输出：

```text
当前阶段：
阶段目标：
已满足：
未满足：
已验证：
未验证：
需要你手动验证：
建议 checkpoint：
风险：
```

## 7. 我要确认 Vibe

适用场景：

- 悬浮窗 UI 做出原型。
- 交互节奏需要确认。
- 信息密度、颜色、提醒方式需要用户判断。

推荐对话：

```text
请作为主管 agent 准备一次 vibe 验证。

请给我：
1. 当前 UI/交互原型能验证什么。
2. 我需要重点感受哪些点。
3. 哪些反馈属于必须修改。
4. 哪些反馈可以进入后续阶段。
5. 你建议我用哪些真实工作流测试。
```

Vibe 验证维度：

- 是否打扰当前工作
- 状态是否一眼能看懂
- 等待用户处理是否足够明显
- 点击切换是否自然
- 小窗是否像工具而不是负担
- 展开/折叠是否符合频繁使用
- 颜色和信息密度是否舒适

## 8. 我要让主管 Agent 管理 Git

适用场景：

- 准备开始多 agent 并行开发。
- 阶段完成后需要 checkpoint。
- worker 输出需要合并。
- 用户准备验证一个版本。

推荐对话：

```text
请作为主管 agent 管理当前本地 git 状态。

要求：
1. 检查 git status --short。
2. 检查当前分支。
3. 汇总未提交变更。
4. 判断是否应该创建阶段分支或 checkpoint commit。
5. 不要执行 reset/rebase/push/删除分支，除非我明确确认。
6. 如果要 commit，先给出将要包含的文件和 commit message。
```

主管 agent 应该输出：

```text
当前分支：
未提交文件：
建议操作：
建议 commit：
需要你确认：
不建议操作：
```

## 9. 常用短句

快速梳理：

```text
主管，帮我梳理当前 Agent Monitor Overlay 的状态，检查 git，并告诉我下一步。
```

更新计划：

```text
主管，把这次确认的内容更新到项目文档里，更新后告诉我 diff 和是否建议 checkpoint。
```

开 worker：

```text
主管，给我生成一个 worker session 提示词，任务是 <任务名>，范围只限 <范围>。
```

收敛 worker：

```text
主管，这是 worker 报告，请检查是否合格，并决定是否更新文档或进入下一步。
```

阶段验收：

```text
主管，按 PROJECT_PLAN.md 做当前阶段验收，给我用户验证清单。
```

新 session：

```text
我要开新 session，请给我一段可复制的主管 agent 启动提示，包含当前阶段、git 状态、下一步任务。
```

Vibe 验证：

```text
主管，准备一次 vibe 验证，只告诉我需要体验和判断的点，不要让我看实现细节。
```

## 10. 用户不需要处理的事

以下事项默认由主管 agent 处理：

- 拆任务
- 多 agent 调度
- worker 输出收敛
- 文档更新
- 本地 git 状态检查
- 阶段 checkpoint 建议
- 验证命令整理
- 风险归纳
- 下一步任务排序
- 给新 session 生成提示词

用户只需要做：

- 说清楚想要的工作感受
- 试用可运行版本
- 判断 UI/交互 vibe
- 确认需求取舍
- 确认是否执行高风险操作

