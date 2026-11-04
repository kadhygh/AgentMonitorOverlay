# MCP 设置（2026-11-04）

## 起因

同事反馈：Figma MCP 配在 `~/.claude.json` 里，在终端里开 Claude Code 能用，在 Studio 里的 Claude 会话中却用不了。原因是 Studio 用本机登录启动 Claude 时总是带 `strictMcpConfig`（4cef30ce，10-14 接入本机登录时加的），只加载 AMO 自己的 MCP，`~/.claude.json`、项目 `.mcp.json`、插件和 claude.ai 连接器里的都被忽略了。CLAUDE.md、skills、hooks、命令一直照常加载，只挡了 MCP。

三种模型原来的情况：

| 模型 | 加载的 MCP |
|---|---|
| Claude | 只有 `amo` |
| Codex | 用户 `~/.codex/config.toml` 里的，加上 `amo` |
| DeepSeek（DSH） | 只有 `amo`（用 Studio 自己的 `DSH_HOME`） |

## 用户定的（11-04）

- 默认加载本机已经配好的 MCP，设置里可以关掉这个开关。
- 分三级：全局（设置 → 「MCP」页，以这里为准）、项目（「编辑项目」对话框里的一块，不另做项目设置窗口）、会话（输入框上方，模型和权限旁边的「MCP」按钮）。不做任务级：同一任务里新开的会话沿用上一个会话的选择。顶栏不加按钮。
- 新接入 MCP 的流程：AI 调用 AMO 工具 `mcp_server_save`，每次保存都要人批准；保存后 AI 可以在自己正在运行的会话里直接启用。也可以人自己在设置里粘贴 JSON 添加。本来就配在 Claude Code 或 Codex 里的，什么都不用做。
- Codex：AMO 里加的 MCP 在它的 app-server 下次启动时生效，不自动重启。
- 本机配置里的 `amo-relay`（中转的 MCP）会列出来，但默认不启用：它和 Studio 自带的 `team_ask` 功能重复。

## 怎么做

### 有哪些 MCP（Host `features/mcp/`）

- **Studio 的**：设置里添加的，或 AI 用 `mcp_server_save` 添加的。保存在 Host kv `mcp:servers` 里。`env` 和 `headers` 的值不和配置放在一起，存进 Windows 凭据管理器（`mcp-<id>`），返回给界面时换成 `MCP_SECRET_MASK`，AI 的工具也读不到明文。
- **本机的**（`loadLocal` 开着时）：每次用时现读，Studio 只读、从不写这些文件。
  - 用户级：`~/.claude.json` 顶层的 `mcpServers`；
  - 本机项目级：`~/.claude.json` 里 `projects[<项目路径>].mcpServers`，也就是 `claude mcp add` 默认加的位置；
  - 项目文件：`<项目>/.mcp.json`。这类 MCP 默认是否启用，取决于 Claude Code 自己有没有批准过（`enabledMcpjsonServers`、`enableAllProjectMcpServers`、`disabledMcpjsonServers`）。没批准过的默认不启用，因为 `.mcp.json` 是仓库里的文件，里面的命令可能是别人提交的。
  - 会话里见过的：插件、claude.ai 连接器等。Studio 读不到它们的配置文件，只能从 Claude 会话启动时报告的列表里记下名字和状态。
- 名叫 `amo` 的一律跳过（是 Studio 自己的）。Studio 里的和本机的同名时，用 Studio 的。

### 开不开（按名字）

会话的设定 → 项目的设定 → 全局的设定 → 默认值。默认值：Studio 的看它自己的「默认启用」；本机用户级和本机项目级默认启用，`amo-relay` 除外；`.mcp.json` 按 Claude Code 有没有批准过。

- 全局设定：kv `mcp:global`，内容是 `{ loadLocal, on: { 名字: 开或关 } }`。
- 项目设定：kv `mcp:project:<id>`。
- 会话设定：`session.options.mcp`。新会话没写这一项时，从同一任务最近的主会话复制。

### 怎么交给每种模型

- **Claude**：会话用的配置目录就是人自己的那个（本机登录、默认账号）时，**不加 strict**，让 Claude Code 自己加载本机的 MCP（OAuth 授权、插件、项目批准都照它原来的办法处理），Studio 的 MCP 通过 `mcpServers` 传进去；要关掉的本机 MCP 放进 `managedSettings.deniedMcpServers`，只在这个进程里生效，不写任何文件；要启用的 `.mcp.json` 条目放进 flag 级 `settings.enabledMcpjsonServers`。不能用 SDK 的 `toggleMcpServer`，因为它会写进 `~/.claude.json`。其他情况（别的账号目录、GLM 等用 Studio 自己目录的渠道）照旧加 strict，Studio 把要启用的本机 MCP 显式传进去，`.mcp.json` 里的 `${VAR}` 由 Studio 展开。
- **DeepSeek**：`session/new`、`session/resume` 的 `mcpServers` 里放 `amo`，加上所有启用的 MCP（Studio 的和本机的）。
- **Codex**：只给 Studio 的、全局默认启用的，app-server 启动时用 `-c mcp_servers.<名字>.…` 传进去；密钥通过环境变量传（stdio 用 `env_vars`，http 用 `env_http_headers`），并加进 `shell_environment_policy.exclude`，不传给 agent 跑的命令。Codex 不支持按项目或按会话开关，界面上会写明。

### 会话中途改

- **Claude**：只有 Studio 的 MCP 有变化时，用 `query.setMcpServers()` 当场生效（每次都把 `amo` 一起传，因为它会替换整组动态 MCP），一轮进行到一半也能生效。本机 MCP 有变化（拒绝列表或批准列表变了）时，在没有回复进行中的时候关掉进程，下一条消息自动 resume；正在回复时，等这一轮结束再关。
- **DeepSeek**：没有回复进行中时关掉进程，下一条消息 resume，并带上新的列表；正在回复时等这一轮结束，和改权限的处理一样。
- **Codex**：不中途改，界面上写明。

### 界面

- 设置 → 「MCP」页：「加载本机已配置的 MCP」开关；Studio 的 MCP 列表（添加、编辑：粘贴 `mcpServers` JSON；删除；默认启用）；本机的 MCP 列表（来源、默认启用的开关、最近一次的状态）。
- 编辑项目对话框：这个项目里每个 MCP 开不开（跟随全局 / 开 / 关），列出这个项目自己的 `.mcp.json` 和本机项目级 MCP。
- 会话：输入框上方加「MCP N」按钮，点开是一组勾选框，显示状态（Claude 会话运行时显示实时状态），并说明改动什么时候生效；最下面有「管理 MCP…」，打开设置的 MCP 页。

### AI 用的工具

- `mcp_server_list`：列出有哪些 MCP、各自在哪里、在调用方会话里开没开；不返回密钥。
- `mcp_server_save`（每次都要人批准）：添加或修改一个 Studio 的 MCP；`enableHere: true` 时同时在调用方会话里启用。说明里告诉 AI：不要把密钥写进参数，值留空，让人到设置里填。

## 进度

见 `studio/HANDOFF.md`「最近的改动」11-04 那一条。
