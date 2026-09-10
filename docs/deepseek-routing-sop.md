# DeepSeek 模型更新与路由模式 SOP

DeepSeek 的发布版本与路由模式分开维护。Flash、Pro 是角色名，不代表固定的能力排名。换新模型只更新版本配置并运行生成脚本，不需要再分别修改 Codex、Claude、总入口和任务卡片快速入口。

## 当前版本

- 发布 ID：`v41-flash`
- Flash：`deepseek-flash`
- Pro：`deepseek-v4-pro`；Claude 的 Pro 槽位保持原来的 `deepseek-v4-pro[1m]`
- 默认模式：`flash-all`
- 2026-09-10 按用户提供的官方公告，将当前 Flash 模型名更新为 `deepseek-flash`。只更新模型名称，保留已有模式、端点、Pro 配置与多模态设置；0910 配置作为历史版本保留。
- Codex Responses base URL：`https://api.deepseek.com/`
- Claude Anthropic base URL：`https://api.deepseek.com/anthropic`
- 继续共用 AMO 已保存的 DeepSeek Key；脚本不读取或写入密钥，也不修改用户全局 CLI 配置。

## 两种模式的含义

| 槽位 | `flash-all` | `pro-flash` |
| --- | --- | --- |
| Codex 主模型、`/review` | Flash | Pro |
| Codex 默认子智能体 | Flash | Flash |
| Codex 模型菜单 | 只有 Flash | Pro、Flash |
| Claude 主模型、Opus、Sonnet | Flash | Pro |
| Claude Haiku、子智能体 | Flash | Flash |

主模型使用高推理配置：Codex `max`，子智能体默认 `high`；Claude 保持 `CLAUDE_CODE_EFFORT_LEVEL=max`。**推理强度与模型选择是两件事**：在主任务中调低 effort 不会自动从 Pro 换成 Flash。需要简单任务使用 Flash 时，通过子任务、Haiku 或明确的 Flash 模型选择实现。

Codex 使用 `agents.default_subagent_model` 和 `review_model` 单次启动覆盖，Claude 使用对应环境变量映射。Codex 的显式 spawn 模型和自定义智能体配置仍可覆盖默认值；这些模式配置的是 AMO 管理的槽位，不是服务端强制拦截器。`flash-all` 目录只列 Flash，并附带保持所有子任务使用 Flash 的指引。使用自定义智能体时，也应检查其中是否硬编码了其他模型。

官方配置依据：[DeepSeek Claude Code 接入说明](https://api-docs.deepseek.com/zh-cn/guides/coding_agents/)、[Codex 子智能体默认模型与覆盖规则](https://learn.chatgpt.com/zh-Hans/docs/agent-configuration/subagents)、[Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 维护位置

1. `broker/assets/deepseek/releases.json`：发布历史、当前发布和默认模式，是维护源。
2. `scripts/models/deepseek-routing.cjs`：校验、预览和生成脚本。
3. `broker/assets/deepseek/profiles.json`：生成的两客户端共用预设清单。
4. `broker/assets/codex/deepseek-profile-*.models.json`：生成的每个发布、每种模式的 Codex 模型目录。

新发布使用新 ID。脚本拒绝修改已有发布 ID 对应的模型名或能力标记，以免恢复旧会话时悄悄切换模型。旧预设及目录保留供恢复会话和回滚使用；界面只显示当前发布的两种模式。旧版本的 DeepSeek 默认启动选择会跟随当前发布的默认模式，当前发布内显式保存的模式会保留。GPT-Dxx、GPT-Official 等其他提供商的选择不受影响。

## 接入新版本

在仓库根目录使用 PowerShell。先预览，无 `--apply` 时不写文件：

```powershell
node scripts/models/deepseek-routing.cjs --release v41-flash --flash deepseek-flash --label 'V4.1 Flash' --mode flash-all --vision true
```

确认主模型、子模型与修改文件列表后，应用同一组参数：

```powershell
node scripts/models/deepseek-routing.cjs --release v41-flash --flash deepseek-flash --label 'V4.1 Flash' --mode flash-all --vision true --apply
```

后续将 `--release`、`--flash`、`--label` 换成新发布的值。`--vision true` 只在供应商明确支持图像输入时指定。新发布默认不启用图像。需要更新 Pro 时传入 `--pro`，需要 Claude 特殊模型后缀时再明确传入 `--claude-pro`；未提供 Pro 参数时沿用当前发布的 Pro。不会给新 Flash 模型擅自添加 `[1m]` 或改变 endpoint。

生成后校验并构建：

```powershell
npm run deepseek:check
node --test broker/lib/deepseek-profiles.test.js broker/lib/codex-provider.test.js broker/lib/claude-provider.test.js broker/lib/codex-launch-config.test.js
node --test overlay/tests/runtime/modelProviders.test.mjs overlay/tests/runtime/workspaceLaunch.test.mjs
npm --prefix overlay run build
.\amo.ps1 -Mode Stable -RestartOnly
```

`npm --prefix overlay run build` 会先检查生成物是否与源配置一致。首次启动没有 Stable 可执行文件时，最后一步使用 `.\amo.ps1 -Mode Stable`。模型配置也已加入 Stable 构建指纹，便携打包会带上全部历史目录。

## 切换默认模式与回滚

同一发布切到 `pro-flash`：

```powershell
node scripts/models/deepseek-routing.cjs --release v41-flash --mode pro-flash --apply
```

需要回退历史配置时，切换到保留的 V4 配置：

```powershell
node scripts/models/deepseek-routing.cjs --release v4 --mode flash-all --apply
```

回滚只切换 AMO 的配置；供应商可能把旧模型名映射到新模型，因此不保证服务端模型版本也回退。

每次应用后重新执行校验、前端构建和 AMO 重启。新配置用于新启动的 CLI；已经运行的 CLI 不会自动切换。历史会话恢复仍使用记录的发布与模式，供应商若已下线该模型，需要显式选择新配置启动新会话。

## 在 AMO 中试用

工作区中心或任务卡片快速入口 → Codex CLI / Claude CLI → **DeepSeek** → **路由模式：Flash 全部 · V4.1 Flash**。下方说明会显示完整模型名。另一项为 **Pro 主任务 + Flash 子任务**。

这里描述的是 Codex CLI 和 Claude CLI 的 AMO 启动路由。独立 DeepSeek Harness 的安装和 Web 服务配置由其自身工作流管理，本脚本不更新它。

## 验证边界

自动测试覆盖生成物一致性、历史版本保留、回滚、两客户端槽位、密钥隔离及两个启动入口的参数一致性。0910 使用现有稳定目录的上下文和工具协议参数，并根据公告启用图像输入；并不凭新型号名称推测新的上下文或输出上限。

2026-09-08 的 0910 接入曾通过本机 Codex 0.153.4 的 app-server，在隔离配置目录中读取了实际配置和模型列表：主模型、默认子智能体、审阅模型均为完整 0910 ID，菜单仅有该模型。此项没有发送推理请求。实际 API 账号权限、Responses/Anthropic 的供应商兼容性及多模态推理效果，需要后续真实任务确认；公告中每账号 20 并发的限制由供应商执行，AMO 不宣称已实现跨进程的账号级限流。
