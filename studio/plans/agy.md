# Gemini 接入：经 Antigravity CLI（`agy acp`）做第四种会话运行时（2026-11-24）

> 状态：进行中。11-24 用户定主做 `agy`、先按实测到的接口接好，账号验证回头再测。第 1 段（Host 运行时、设置页、界面分支，测试功能「Gemini（Antigravity）」后面，默认关）、第 2 段（平台环境页装 / 更新 agy）、第 3 段（中转服务的 agy 镜像）做完（11-24 用户：「第二第三都做完，回头我再让别人试」）；第 4 段等用户验证 Google 账号。代码里叫 agy（运行时 `agy`、Host `runtime/agy`），界面上叫「Antigravity · Gemini」（渠道名 Gemini，运行时标签 Antigravity）。

## 用户说的（11-24）

- 「我期望是类似我们的这几个渠道一样，增加一个完整的 gemini 渠道。且服务器的自动下载之类的全都支持。我会用官方的 gemini 账号来使用。」
- 「我现在没订阅任何东西」：用免费的个人 Google 账号。
- 「那就主做 agy」；「今天应该不好登录了，设备不在身边，我们是否可以先按照相关内容先接好，回头在测试登录验证」。

## 为什么是 agy，不是 Gemini CLI（11-24 实测 + 网上查的）

- Gemini CLI 0.71.1（npm `@google/gemini-cli`，11-24 当天还在发版）：ACP 握手正常，Google 登录也成功，但服务器拒绝：「This client is no longer supported for Gemini Code Assist for individuals … migrate to the Antigravity suite」。GitHub 上的说法（转述 Google 博客，原文未读）：2026-06-18 起个人账号（免费、AI Pro、Ultra）不能再用 Gemini CLI，只剩付费 API Key、Vertex、Code Assist Standard / Enterprise。
- Antigravity CLI 1.5.16（winget `Google.AntigravityCLI`，闭源 Go 单文件约 240 MB）：有 `agy acp`；免费个人账号能登录（11-24 实测）；一个账号里能选 Gemini 3.8 Flash、Claude Sonnet 4.6 / Opus 4.6、GPT-OSS 120B。免费额度按周、很紧，具体数字 Google 没公布（第三方文章说的，未验证）。
- 本机这个 Google 账号第一次发消息时被挡：`PERMISSION_DENIED 403: Verify your account to continue`，要用户自己在浏览器里做一次账号验证（11-24 用户手边没设备，回头做）。所以**真模型这一轮没跑通过**，下面「回头要实测的」都还没验证。

## 实测到的 `agy acp`（spikes/gemini/a00–a02，11-24）

| 项 | 结果 |
|---|---|
| initialize | protocolVersion 1；loadSession；sessionCapabilities：resume、close、load、list、additionalDirectories；图片输入有、音频无；`_meta.antigravity`：`tier`、`systemPrompt.append`；**没声明 mcpCapabilities** |
| 登录方式 | `oauth-personal`（Google 账号）、`oauth-business`（Gemini Enterprise）、`gemini-api-key`、`agent-platform`（Vertex，ADC）；还声明了 `auth.logout` |
| authenticate(oauth-personal) | 开浏览器授权，约 12 s 返回 `{}`；之后的进程不用再 authenticate。没登录时 session/new 报 `Authentication required` |
| session/new | 返回 models（6 个）、modes（default / accept-edits / plan）、configOptions（model、thought_level、mode）；上下文 1048576 |
| 选项 | `session/set_config_option` 改 model、mode 都行；thought_level 只对 Gemini 有（对 Claude Sonnet 报「not offered」）；`session/set_mode`、`session/set_model` 也有 |
| MCP | session/new 带一个 HTTP、一个 stdio 的 MCP 都收了，日志「Preloading 2 MCP servers」；HTTP 的真能不能连上**未验证**（当时那个地址没有服务） |
| 续接 | 新进程里 session/load 和 session/resume 都能接回原会话；session/list 列得出 |
| 进程环境 | 登录状态和会话在 `~/.gemini/antigravity-cli/`，MCP 设置在 `~/.gemini/config/mcp_config.json`；凭据存哪没查清（Windows 凭据管理器里没看到）。它的终端沙盒在本机用不了（要 Win11 24H2 + 2026-08 更新） |
| 自动更新 | 默认后台自更新；二进制里有 `AGY_CLI_DISABLE_AUTO_UPDATE`，**效果未验证** |
| 官方安装 | `install.ps1`：读 `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json`（version、url、sha512），下 exe 到 `%LOCALAPPDATA%\agy\bin\agy.exe`，校验 sha512 后跑 `agy install` 配 PATH。winget 装到 `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Google.AntigravityCLI_…\agy.exe` |

## 做法（11-24 用户确认「按建议来」）

一句话：照 DSH 的样子（它也是 ACP）加一种运行时 `agy`，登录只用本机 `agy` 自己的 Google 登录（和 Claude 只用本机 Claude Code 登录一样），平台环境页负责装和更新，团队服务器做镜像。

1. **Host 运行时**（`runtime/agy/`）
   - `runtime/dsh/acp.ts` 挪成共用的 `runtime/acp.ts`（错误文字里的「DSH」改成参数 `label`），DSH 和 agy 都用它。
   - `AgyRuntime extends RuntimeBase`：spawn `agy acp`（带 `AGY_CLI_DISABLE_AUTO_UPDATE=1`、`withoutHostEnv`、`shellHelpEnv`）→ initialize → session/new（AMO MCP 用 HTTP，连不上再做 stdio 转接）→ set_config_option（模型、思考强度、模式）→ session/prompt；续接用 session/load 或 resume；停止用 session/cancel + 宽限后杀进程；审批走 `session/request_permission` → Studio 的审批卡。
   - 会话行：从 DshTranscript 抽出通用的 ACP 部分（消息、思考、工具调用、用量），工具的显示按 ACP 标准字段（kind、locations、diff）写，不套 DSH 的工具名。agy 可能按 token 增量推送，按 messageId 累加要验证。
   - 不支持的先关掉：分支（ACP 没有）、Codex 的「终端接管」、手动压缩（agy 有 `/compact`，以后再接）。
   - 内置模型 `agy-gemini`；没装 agy 时这个模型在选择器里灰掉，写明「在 AMO 平台的环境页装 Antigravity CLI」。
   - 权限（Studio 的只读 / 可写 / 完全 → agy）：只读 = `plan`；可写 = `accept-edits`（改文件不问，命令问）；完全 = `--dangerously-skip-permissions`（见下面「沙盒和自动审批」）。agy 自己的终端沙盒在本机用不了，「可写」里的命令照样逐条问。
   - 内置模型只列 Gemini；agy 报的 Claude / GPT-OSS 默认藏起来，设置里能勾出来（11-24 用户定）。
2. **设置 → 模型 → Antigravity**：装了没有、版本、登录状态（登录方式、`tier`）、「登录 Google 账号」（走 ACP authenticate，开浏览器）、「退出登录」、「检查」（开一个会话不发消息，同 DSH 的检查）。API Key 登录先不做。
3. **平台环境页**：加「Antigravity CLI」一项：找已装的（PATH、`%LOCALAPPDATA%\agy\bin`、winget 的位置，`--version`）、显示最新版（官方清单）、安装 / 更新（团队服务器或官方，二选一，同 Claude Code）：下 exe 到 `%LOCALAPPDATA%\agy\bin\agy.exe`、校验 sha512、`agy install` 配 PATH。找 exe 的代码放进 `packages/locate`，Host 和平台共用。
4. **团队服务器镜像**（`packages/relay/src/mirror.ts`）：第三个来源 `antigravity-cli`：定时读官方清单，下 exe、校验 sha512，留最新几个；管理页加一张卡。部署要重启中转几秒，部署前问用户。
5. **测试**：testkit 的 fake ACP agent 加 agy 模式（增量推送、session/load、modes）；Host 集成测试、Studio e2e（`AMO_STUDIO_TEST_AGY_AGENT`）、平台环境页单测和 e2e、中转镜像单测。真模型测试等账号验证后再跑，记进 `budget.json` 的 `gemini`（11-24 设 30 轮，已用 1）。

## 分几段

| 段 | 内容 | 需要真账号吗 |
|---|---|---|
| 1 | Host 运行时 + 内置模型 + 界面分支 + 设置页（状态 / 登录 / 检查），用 fake agent 测 | 不要 |
| 2 | 平台环境页：检测、安装、更新 agy（官方来源） | 不要 |
| 3 | 中转服务镜像 + 环境页「团队服务器」来源 | 不要（部署要问用户） |
| 4 | 账号验证后：真模型跑一遍工具、审批、MCP、取消、续接、额度；按结果修 | 要 |

## 回头要实测的（现在都是未验证）

- 免费额度：一周多少，用完时 ACP 回什么错误，`tier` 和 `/usage` 里能读到什么（左下角额度要不要接）。
- 工具调用的 ACP 形态和审批选项（option 的 kind、id）；MCP 工具调用会不会经 request_permission 问。
- AMO 的 HTTP MCP 真能连上；连不上就做 stdio 转接。
- 一轮在跑时再发消息（排队）、取消、进程退出后续接。
- `AGY_CLI_DISABLE_AUTO_UPDATE` 真的关掉了自更新。
- 通过 agy 用 Claude / GPT-OSS 模型是否也吃同一份 Google 额度。

## 条款

用个人 Google 账号经第三方程序驱动 agy，Google 是否允许没查到明确说法（Zed、JetBrains 有 ACP 接入，是不是 Google 官方认可的没查）。现在只是用户自己和团队内部用；对外公开前要再查，和 Anthropic 条款那条同样处理。

## 用户定的（11-24，批注）

- agy 里的 Claude / GPT-OSS 模型：**默认不可选**，设置里能把它们勾出来（Gemini 默认可选）。
- 合进 master：按建议，放在测试功能开关后面、默认关，每段做完就合，自动打包照常发。
- 第 4 段（真模型）：用户做完账号验证后，可能请别人协助跑，到时拉一个协作（cowork）会话。真模型跑在哪台机器，那台机器上的 agy 就要登录好、验证过（登录状态在本机 `~/.gemini/antigravity-cli/`）。

## 沙盒和自动审批（11-24 查的，二进制里的说明文字 + `agy acp --help`）

- 不用沙盒照常能用：沙盒是可选的（`--sandbox`），本机那条日志只是警告，session/new 照样成功。命令直接在本机跑，和 Studio 里的 Codex、Claude 一样，安全靠审批。
- agy 有 `auto` 模式：「auto-approve edits and safe commands, prompt on irreversible actions」，但它**要系统终端沙盒**（「Auto mode is not available: it needs the OS terminal sandbox」），所以本机的 ACP 只给 default / accept-edits / plan。另有一句「--mode %s is not available for this account」，可能还和账号档位有关（未验证）。
- 它自己还有几条不问就放行的：空命令、只连本机的命令、它判断为无副作用的命令（日志里叫 PolicyGuardian 的 inert fast path）。
- 全部放行：`agy acp --dangerously-skip-permissions`（启动参数，整个进程有效）。
- `agy acp --login`：在终端里交互登录 Google 后退出，可以给设置页「登录」用（另一条路是 ACP authenticate）。

## 参考 t3code 的 agy 接法（11-24 子 agent 读源码，HEAD `ae45e009`，MIT）

pingdotgg/t3code 也是经 `agy acp` 接 Gemini（`apps/server/src/provider/acp/AntigravityAcpSupport.ts`、`antigravityAuthSupport.ts`、`AntigravityAuth.ts`）。打算照着做的：
- initialize 里声明 `fs.writeTextFile: false`（他们注释说声明了写能力，agy 会改成整文件写，不用 diff 编辑）。
- 启动环境：去掉继承来的 `GEMINI_API_KEY`、`GOOGLE_*`；设 `AGY_CLI_DISABLE_AUTO_UPDATE=1`。
- 系统提示走 session/new 的 `_meta.antigravity.systemPrompt.append`（initialize 里声明了才用），AMO 的角色卡可以放这里。
- 版本门槛：他们要 1.5 以上；1.5.0 起「一轮在跑时再发 prompt」是插进当前轮（steer），1.5.1 起不再只给白名单客户端（如 Zed）开非 Gemini 模型。
- 取消：发 session/cancel 后等 prompt 自己返回；续接用 session/resume；agy 回不了自己的对话，所以不做回退和分支。
- 状态检查要被动：查装没装、登没登录时不开会话。

和本机实测对不上、先不照搬的：他们说 agy 是带 Python 的单文件、每次启动解包约 1 GB 要一分钟，所以给每次启动单独的 TEMP；本机 1.5.16 的 initialize 几秒就回了，TEMP 里也没看到解包目录（版本不同？未验证）。他们伪造 `SSH_CONNECTION` 让 agy 不把登录放进系统钥匙串、用伪装的 User-Agent 读额度：都是绕 CLI 内部行为或涉及条款，不做。

- 界面上叫「Antigravity · Gemini」（11-24 用户：「这两件就按你的建议来」）。
- 权限对应：只读 = plan；可写 = accept-edits；完全 = `--dangerously-skip-permissions`（一个会话一个进程，换到或换出「完全访问」时换进程）。等系统升到 24H2 后再看要不要加「auto」。

## 第 2、3 段里自己定的（没问过用户）

- 镜像照 Claude Code、Codex 的做法（`packages/relay/src/mirror.ts` 的 `AGY_SOURCE`，工具名 `antigravity-cli`）：读 Google 的 `manifests/windows_<arch>.json`，下它给的 exe，按 sha512 校验，存成 `agy.exe`，默认开、每小时、只 x64、留 3 版。
- 平台（`packages/platform/src/agy-install.ts`）照 Google 的 install.ps1 装：exe 放 `%LOCALAPPDATA%\agy\bin\agy.exe`，再跑 `agy install`。`agy install` 失败不算装失败（install.ps1 也这样），只在结果里说一句。正在跑的 agy.exe 先改名挪开再放新的（同 Claude Code 的启动器）。
- Google 的清单只给最新版：从团队服务器装比 Google 旧的版本时，按服务器下载时记下的 sha512 校验（服务器当时按 Google 清单校验过）。
- winget 装的 agy：平台不替它装，「更新」跑 `winget upgrade --id Google.AntigravityCLI --exact --silent …`；「最新」照样从 Google 清单读。
- `agy install` 具体改了什么（PATH、PowerShell profile 里的别名）只看过 `--help`，**没在真机上跑过**；平台的安装只用假服务器和假 `agy install` 测过，真的 240 MB 下载没在平台上跑过（镜像部署后在服务器上会真下一次）。

## 第 1 段里自己定的（没问过用户）

- 角色卡和 AMO 的说明走 AMO MCP 的 instructions（和 DSH 一样），没用 `_meta.antigravity.systemPrompt.append`。agy 会不会把 MCP 的 instructions 放进提示词**未验证**，第 4 段看；不会的话改用 systemPrompt.append。
- AMO 的工具：除了要人先点头的那几个（`PROMPTED_WRITE_TOOLS`），agy 来问时 Studio 直接同意；认 AMO 工具靠请求的标题（`amo/工具名` 等写法，按 t3code 的笔记猜的，**未验证**）。认不出来时会照常弹审批卡，多问几次，不会少问。
- 「登录 Google 账号」走 ACP `authenticate`（oauth-personal），最多等 5 分钟；「退出登录」和 `tier` 没做。设置页把「检查能开会话」也算作已登录（在 agy 终端里登录的不会留下 Studio 读得到的记录）。
- 不能手动压缩，自动压缩点那页写「Antigravity 自己管理」；上下文提示里不给「现在压缩」。
- 审批卡上命令显示命令本身（`dir` 在会话行里会被读成「查看目录 · .」）。
