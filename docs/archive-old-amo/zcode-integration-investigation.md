# ZCode 与 Agent Monitor Overlay 集成调查

> 调查日期：2026-08-13
> 调查范围：ZCode Desktop、ZCode Agent、Hooks、Plugin、任务管理、Remote Control、Bot Channel、模型供应商，以及公开可见的 CLI / Deep Link 线索。
> 当前决策：暂不实施 ZCode 集成；保留本报告供后续评估。

## 结论摘要

ZCode 适合作为 GLM-5.2 与 DeepSeek V4 Pro 的统一桌面 Agent 容器。它原生支持 GLM-5.2，也允许通过兼容 OpenAI / Anthropic 协议的自定义供应商接入 DeepSeek。官方 Hooks 协议在设计上足以覆盖 AMO Task Card 的大部分生命周期状态。

目前最大的缺口不是模型接入，而是桌面任务路由：公开文档没有提供稳定的 task URI、CLI 参数或本地 API，让外部程序根据 ZCode task ID 精确切换到一个已有任务。因此，现阶段可以可靠完成“监控 ZCode 会话”和“打开或激活 ZCode / 工作区”，但不能承诺达到 Codex App 那种从 Card 精确跳转到对应 task 的体验。

此外，官方反馈仓库中存在一条尚未关闭的报告，称原生 ZCode Agent 曾不触发配置好的 Hooks。虽然最新官方文档完整描述了主模型 Hook 生命周期，但在正式接入前仍需用当前版本进行实机验证。

## 能力矩阵

| 能力 | 调查结论 | 对 AMO 的意义 |
| --- | --- | --- |
| GLM-5.2 | ZCode / BigModel / Z.ai 原生支持 | 可作为一等模型使用 |
| DeepSeek V4 Pro | 支持兼容 OpenAI / Anthropic 的自定义供应商，官方文档直接提供 DeepSeek 示例 | 可作为 ZCode 自定义模型使用 |
| Session Hook | 官方提供完整本地子进程协议 | 设计上可接 AMO |
| Prompt 与工具活动 | 有 `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`PostToolUseFailure` | 可驱动 Card 活动状态 |
| 权限等待 | 有 `PermissionRequest` | 可映射为 `attention` |
| Agent 停止 | 有 `Stop` | 可映射为 `review` / `finished` |
| Session 标识 | Hook 提供 `session_id` | 可做会话关联键，但不一定等于 task ID |
| 工作区标识 | Hook 提供 `cwd` | 可关联 AMO workspace |
| 会话内容 | Hook 提供临时 `transcript_path` | Hook 执行期间可读取，不能只保存路径 |
| ZCode task ID | 桌面内部明确存在 | 尚未发现公开跳转接口 |
| 打开或激活 ZCode | 桌面程序和目录关联可实现 | 可提供基础 Card 按钮 |
| 外部创建任务 | Remote / Bot 内部可以创建，但没有公开本地 API | 暂不能作为稳定集成依赖 |
| 精确打开已有任务 | 未发现公开 task URI / CLI / API | 尚不能达到 Codex App 跳转体验 |
| Headless / CLI | 存在应用内 headless 和非官方 CLI 线索 | 必须实机验证，不能直接作为生产协议 |

## 模型部署

### GLM-5.2

ZCode 将 GLM-5.2 作为内置模型提供。国内可以通过 BigModel Coding Plan 或 API Key 连接；海外可以通过 Z.ai 连接。官方文档列出的 Coding Plan OpenAI 端点为：

```text
BigModel: https://open.bigmodel.cn/api/coding/paas/v4
Z.ai:     https://api.z.ai/api/coding/paas/v4
```

也可以使用通用 API 余额端点，但 Coding Plan 专用端点与通用端点不可互换。

### DeepSeek V4 Pro

ZCode 官方配置文档说明，可以添加任何兼容 Anthropic / OpenAI 协议的服务作为自定义供应商，并直接给出了 DeepSeek 配置示例：

```text
Provider name: DeepSeek
OpenAI URL:    https://api.deepseek.com/v1
Anthropic URL: https://api.deepseek.com/anthropic
Model ID:      deepseek-v4-pro
```

DeepSeek 官方 API 文档确认 `deepseek-v4-pro` 支持 Tool Calls、思考模式和 OpenAI / Anthropic 兼容接口。因此，把 GLM-5.2 和 DeepSeek V4 Pro 放在同一个 ZCode App 中切换，在模型连接层面是可行的。

尚需实测 ZCode 是否完整传递 `thinking`、`reasoning_effort` 等 DeepSeek 专属参数。基础 Tool Calling 与常规 Agent 工作流的可行性较高，但专属推理参数不能仅凭兼容协议推定。

## Hooks 协议

ZCode Hook 是本地子进程协议。ZCode 向 Hook 进程的 stdin 写入一行 JSON，Hook 通过 stdout JSON 和退出码返回结果。

官方事件顺序为：

```text
新 session -> SessionStart
用户提交   -> UserPromptSubmit -> 主模型
工具请求   -> PreToolUse -> PermissionRequest（需要确认时）
工具成功   -> PostToolUse
工具失败   -> PostToolUseFailure
模型结束   -> Stop
```

典型输入字段：

```json
{
  "session_id": "session-123",
  "transcript_path": "/tmp/zcode-hook/transcript.jsonl",
  "cwd": "/workspace/demo",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Write",
  "tool_input": {},
  "tool_use_id": "tool-123"
}
```

支持以下配置来源：

```text
~/.zcode/cli/config.json
<workspace>/.zcode/config.json
ZCode Plugin: hooks/hooks.json
```

推荐最终以一个 `amo-zcode-bridge` Plugin 分发 Hook，而不是要求用户逐项目手工配置。Plugin Hook 可以把事件转发到 AMO 本地 ingest endpoint，由 AMO 完成 session reconciliation 和 Card 状态更新。

### 建议的 Card 状态映射

| ZCode 事件 | AMO 动作 |
| --- | --- |
| `SessionStart` | 创建或认领 Card，记录 session、workspace、model |
| `UserPromptSubmit` | 标记 `running`，记录最新任务摘要 |
| `PreToolUse` | 更新活动时间和当前工具 |
| `PermissionRequest` | 标记 `attention` / `needs approval` |
| `PostToolUse` | 更新活动和工具结果摘要 |
| `PostToolUseFailure` | 记录失败并提高 Card 可见性 |
| `Stop` | 标记 `review` / `finished` |
| 长时间没有事件 | 由 AMO 超时策略推断 idle / stale |

### Hook 限制

- `transcript_path` 指向临时 JSONL；ZCode 会在 Hook 结束后清理临时目录。需要的内容必须当场读取并转发或复制。
- 官方事件中没有明确的 `SessionEnd`、Task Rename、Archive、Read/Unread 事件。
- Hook 配置在 session 启动时形成快照；修改配置后要新建 session 验证。
- `session_id` 是否等于桌面 task ID 没有官方说明。

## Hook 实际可用性的风险

ZCode 官方反馈仓库 Issue #32（2026-06-22）报告：配置在 `~/.zcode/cli/config.json` 和 Plugin 中的 Hooks 没有被原生 ZCode Agent 触发。该 Issue 在调查时仍为 Open / P2，尚未看到维护者给出明确结论。

当前官方 Hooks 文档又明确描述了“用户提交 -> 主模型”和“主模型准备结束 -> Stop”的生命周期，因此可能是旧版本缺陷、特定执行路径缺陷，或者文档与实现曾有时间差。

在正式实现前，应在当时最新版本上配置一个只写日志的最小 Hook，并验证：

```text
SessionStart
UserPromptSubmit
PreToolUse
PostToolUse / PostToolUseFailure
PermissionRequest
Stop
```

只有实机验证通过后，才能把 ZCode Hook 视为生产级 Card 数据源。

## Task、Session 与桌面跳转

官方反馈文档说明，从 Task 菜单提交反馈时会自动附带 task title、task ID、workspace 和 session file path。这证明 ZCode 内部存在持久 task ID 和 session 文件。

但公开文档没有说明：

```text
Hook session_id 是否等于 task ID
一次 task 是否包含多个 session
compact / resume 后 session ID 是否变化
如何通过外部 URI 或 CLI 打开 task ID
```

建议的数据模型是：

```text
AMO Card
└── ZCode task ID
    ├── latest session ID
    ├── workspace path
    ├── session file path
    └── model / provider
```

不应在没有实测的情况下直接把 Hook `session_id` 当成桌面 task ID。

### Remote Control 与 Bot Channel

Remote Control 和 Bot Channel 可以列出已打开工作区及任务、进入任务、新建任务、发送指令、停止或继续任务。这证明 ZCode 内部具备任务路由能力。

但是这些能力目前通过 ZCode 自己的远程界面和聊天渠道暴露，没有公开为稳定的本地 REST、WebSocket、IPC 或 CLI API。Remote Control 还是临时、受桌面当前打开工作区约束的入口，不适合作为 AMO 的稳定 deep link。

### `zcode://`、CLI 与 app-server 线索

官方文档没有公布 `zcode://task/...`、`zcode://conversation/...` 或类似路由语法。官方反馈仓库中有用户报告某些 macOS 版本注册了 `zcode://` scheme，但报告中的 workspace URL 是建议形式，不是已确认的官方协议。

另有用户报告应用包中曾包含 `Resources/glm/zcode.cjs`，第三方集成调查还提到过：

```text
zcode -p "<prompt>"
zcode app-server --stdio
session/create
session/resume
session/messages
session/event
```

这些属于实测或逆向线索，不是官方稳定接口。必须在目标版本和 Windows 安装包上验证，且不能在确认桌面 Task 同步、恢复和跳转语义之前用于生产集成。

## 与 Codex App 集成的差距

Codex App 的关键优势是稳定 thread ID 可以被 AMO 保存，并能从 Card 直接打开指定 task。ZCode 当前确认的链路只能达到：

```text
Hook 提供 session ID 和 cwd
-> AMO 创建并更新 Card
-> Card 打开或激活 ZCode / workspace
-> 用户在 ZCode 内选择对应 Task
```

要达到完整对等体验，ZCode 至少需要确认一种正式能力：

```text
ZCode task deep link
ZCode CLI --open-task <id>
公开本地 task API
app-server 驱动桌面 UI 聚焦指定 session
```

截至调查日期，公开资料没有确认上述任一种。

## 后续实机验证清单

如果未来恢复 ZCode 集成，建议按以下顺序做一次只读或最小变更 Spike：

1. 在最新 ZCode 上验证原生 ZCode Agent 是否触发全部 Hooks。
2. 对比 Hook `session_id`、反馈界面 task ID 和 session 文件 ID。
3. 测试 compact、resume、模型切换后各 ID 的稳定性。
4. 检查 Windows 注册表中的 `zcode://` handler 和实际启动参数。
5. 检查安装目录中的 CLI shim、`zcode.cjs` 和 app-server。
6. 只运行 `--help` 等只读命令，记录当前版本协议。
7. 验证 CLI / app-server 创建的 session 是否出现在桌面任务列表。
8. 验证 `session/resume` 是否能让桌面 UI 聚焦对应 Task。
9. 分别以 GLM-5.2 和 `deepseek-v4-pro` 运行 Tool Call 与权限请求。
10. 如果没有 task 接口，评估“激活 ZCode + 打开 workspace + 任务搜索”的降级方案。

## 推荐架构（如果未来实施）

```text
Agent Monitor Overlay
├── Codex App Adapter
├── Codex CLI Adapter
├── Claude CLI Adapter
└── ZCode App Adapter
    ├── Hook Ingress
    ├── Session / Task Reconciler
    ├── ZCode Launcher
    ├── GLM-5.2 Provider
    └── DeepSeek V4 Pro Provider
```

Card 可保存：

```ts
{
  runtime: "zcode-app",
  provider: "deepseek" | "bigmodel" | "z-ai",
  model: "deepseek-v4-pro" | "glm-5.2",
  workspacePath: "...",
  zcodeTaskId: "...",
  zcodeSessionId: "...",
  zcodeSessionPath: "..."
}
```

其中 `zcodeTaskId` 与 `zcodeSessionId` 的赋值和关联必须以实机验证结果为准。

## 参考资料

官方资料：

- [ZCode Hooks](https://zcode.z.ai/cn/docs/hooks)
- [ZCode 连接模型](https://zcode.z.ai/cn/docs/configuration)
- [ZCode Task 与文件管理](https://zcode.z.ai/cn/docs/task-management)
- [ZCode Remote Control](https://zcode.z.ai/cn/docs/remote-control)
- [ZCode Bot Channel](https://zcode.z.ai/cn/docs/bot-channel)
- [ZCode Plugin](https://zcode.z.ai/cn/docs/plugin)
- [ZCode Automations](https://zcode.z.ai/cn/docs/automations)
- [ZCode 用户反馈与支持](https://zcode.z.ai/en/docs/feedback)
- [ZCode Releases](https://zcode.z.ai/en/changelog)
- [DeepSeek API 首次调用](https://api-docs.deepseek.com/zh-cn/)
- [DeepSeek 模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)

实现风险和非官方线索：

- [zai-org/feedback Issue #32：原生 ZCode Agent Hook 报告](https://github.com/zai-org/feedback/issues/32)
- [zai-org/feedback Issue #51：应用包内 CLI 线索](https://github.com/zai-org/feedback/issues/51)
- [zai-org/feedback Issue #118：URL scheme / CLI 建议](https://github.com/zai-org/feedback/issues/118)
- [Multica Issue #5361：app-server 第三方调查](https://github.com/multica-ai/multica/issues/5361)
