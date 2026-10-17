# S17 · DeepSeek 走 DSH 原生框架（草案，2026-10-17）

用户（10-17）：本机长期保存一份 DSH 源码克隆，定期拉最新；Studio 设置里填它的位置，DeepSeek 会话用它的原生 harness 推进；DSH 更新后旧的不能用了，就重新做兼容适配。

试验结果见 `spikes/RESULTS.md` 的 s17-00 / s17-01：ACP（`dsh --profile acp`）能新建 / 恢复会话、发消息、取消、选型号和思考强度、挂 HTTP MCP、发批准请求、报上下文用量。

## 怎么接

- **第三种运行时 `dsh`**，模型配置「DeepSeek · DSH」。型号来自 DSH 的 `model` 配置项（deepseek-v4-flash、V4.1-Flash、V4-Pro……），思考强度来自 `reasoning_effort`。
- **进程**：每个会话一个 `node <克隆>/apps/cli/lib/bin.js --profile acp`，工作目录 = 工作区。DSH 的沙箱边界取进程的工作目录，权限模式也是进程级的环境变量，所以按会话分进程；会话空闲久了可以关掉，下次发消息时再 `session/resume`。
- **配置和 Key**：`DSH_HOME` = Studio 数据目录下的 `dsh/`，不碰 `~/.dsh`；Key 用 Studio 已有的 DeepSeek 凭据（`deepseek-v4`），通过环境变量 `DEEPSEEK_API_KEY` 传入。DSH 会把 Key 从模型跑的命令里拿掉（已验证）。
- **权限**：「逐条询问」→ `DSH_PERMISSION_MODE=read-only`（写文件、越界才问，只读命令不问——DSH 没有每条都问的模式）；「工作区可写」→ `workspace-write`；「完全放开」→ `danger-full-access`。批准请求只带 toolCallId，卡片上的命令从前面的 `tool_call` 更新里取。改权限 = 重启这个会话的进程并恢复。
- **对话记录**：`agent_message_chunk` → 回复，`agent_thought_chunk` → 思考，`tool_call` / `tool_call_update` → 命令行（MCP 工具名 `mcp__amo__*`），`usage_update` → 上下文用量（只有当前上下文和窗口，没有输入 / 输出分项）。DSH 发的是整段的消息，不是逐字流。
- **运行中再发消息**：ACP 一次只接一条，Studio 排队到这一轮结束再发（和 Claude 等工具调用间隙不同，要等整轮）。「停止」= `session/cancel`。
- **AMO MCP**：会话新建 / 恢复时带上 AMO MCP（HTTP，每会话一个令牌）。身份卡：DSH 是否读 MCP 的 `instructions` 要先查；不读就放进第一条消息。
- **Host 重启**：会话记着 DSH 的 sessionId，重启后 `session/resume`（不回放，Studio 自己有记录）。
- **没有的**：分支、提问卡片、图片、在终端打开。界面上对 DSH 会话隐藏这些按钮。

## 设置 → 模型「DeepSeek Harness」

- 源码位置（选文件夹，默认空 = 不启用）；显示版本（`apps/cli/package.json`）、git 提交和日期、是否已构建（`apps/cli/lib/bin.js` 在不在）。
- 「检查」：起一次 ACP，`initialize` + 在临时目录 `session/new` 再关掉，不调模型，不花钱。显示「可用 · 0.2.1-rc.1 · 1600d8a」或具体错误。每次拉取更新后点一下。
- 更新步骤写在旁边：`git pull`、`pnpm install`、`pnpm run build:artifacts`（以后可以做成按钮）。

## 依赖 DSH 的地方（拉了新版本不能用时先查这些）

`apps/cli/lib/bin.js`、`--profile acp`、环境变量 `DSH_HOME` / `DSH_PERMISSION_MODE` / `DEEPSEEK_API_KEY`、ACP v1 的方法和更新类型、`model` / `reasoning_effort` 配置项的 id、批准选项 `allow_once` / `reject_once`。都集中在一个文件里，检查按钮覆盖前四项。

## 测试

- testkit 加一个假的 ACP agent（同样的协议，脚本化回复、批准、取消、用量），单测和 e2e 用它，不依赖 DSH 克隆。
- 真 DSH 的集成测试：设了克隆路径才跑，调真 DeepSeek，计入预算。

## 已知问题

- 只读模式下沙箱里的 pwsh 每次输出都带一段乱码 stderr（受限语言模式），模型会多花几步；工作区可写没有。可能要给 DSH 报，或者 Studio 默认用工作区可写——待用户定。
- DSH 是 rc 版本，变化快；每次拉取后点「检查」。
