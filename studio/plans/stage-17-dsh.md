# S17 · DeepSeek 走 DSH 原生框架（2026-10-17）

用户（10-17）：本机长期保存一份 DSH 源码克隆，定期拉最新；Studio 设置里填它的位置，DeepSeek 会话用它的原生 harness 推进；DSH 更新后旧的不能用了，就重新做兼容适配。用户定：DSH 会话默认「工作区可写」。

试验见 `spikes/RESULTS.md` 的 s17-00 / s17-01。源码克隆在 `G:\PROJECT\deepseek-harness`（试验和实现时是 0.2.1-rc.1，提交 `1600d8a1e1`）。

## 做了什么

- **第三种运行时 `dsh`**（`packages/host/src/runtime/dsh/`），内置模型配置「DSH · DeepSeek」（`dsh-deepseek`，Key 用 DeepSeek 凭据 `deepseek-v4`，余额和 Codex · DeepSeek 一样能查）。
  - `install.ts`：Studio 依赖 DSH 的地方全在这里（见下）。读克隆的版本、提交、是否已构建；找系统的 Node（Host 在 Electron 里时，DSH 的原生模块要用系统 Node 跑）。
  - `acp.ts`：一个 ACP 进程（换行分隔的 JSON-RPC）；进程退出时，报错带上它 stderr 的最后几行；日志在 `<数据目录>/dsh/logs/`。
  - `dsh-runtime.ts`：每个会话一个 `node <克隆>/apps/cli/lib/bin.js --profile acp`，工作目录 = 工作区，`DSH_HOME` = `<数据目录>/dsh/home`（不碰 `~/.dsh`），`DSH_PERMISSION_MODE` 按会话的权限，Key 走 `DEEPSEEK_API_KEY`。会话空闲 20 分钟关进程，下次发消息 `session/resume`；Host 重启后同样。
  - `transcript.ts`：DSH 的更新 → Studio 的行。同一条消息的块合成一行；工具按 DSH 的工具名分类（pwsh/bash → 命令，read → 读，grep/glob → 搜索，edit/write/str_replace_editor → 改文件带 diff，web_* → 网页，`mcp__*` → MCP）；`usage_update` → 当前上下文和窗口（没有输入 / 输出分项，所以「用量」不显示，只显示上下文）；`max_tokens` 等停止原因加一行提示。
- **型号和思考强度**：来自 DSH 的 `model` / `reasoning_effort` 配置项（最近一次「检查」或会话给的，存在 kv）。DSH 的型号值是 JSON 路由 `["deepseek-official","deepseek-v4-pro"]`，Studio 里写成 `deepseek-official/deepseek-v4-pro`，发给 DSH 前换回去。改型号、思考强度在下一轮前发给 DSH；改权限会重启这个会话的进程。
- **权限**：「工作区可写」（默认，`workspace-write`）、「只读」（`read-only`）、「完全访问」（`danger-full-access`）。DSH 只在沙箱挡住命令时问：批准卡片显示命令、理由和要放宽到的范围；允许 / 拒绝回给 DSH。
- **运行中再发消息**：DSH 一次只接一条，消息排队（显示在正在跑的这一轮里），这一轮结束后合成一条发出；点「打断」时排队的不再发，留一行说明。
- **AMO MCP**：会话新建 / 恢复时带上（HTTP，每会话一个令牌）。DSH 把 MCP 服务器的 instructions 放进系统提示词，所以 DSH 会话连上时 instructions 里带身份卡（连上算告诉过它，之后任务变化随下一条消息补充）。DSH 调 MCP 工具不会问人，所以要你先批准的画布写入（`PROMPTED_WRITE_TOOLS`）不给 DSH 会话。
- **没有的**：分支、在终端打开（会话头上不显示）、提问卡片、图片（发图片会报错说明）、「压缩」按钮（DSH 到窗口 80% 自己压缩，上下文提醒里这样说）。
- **设置 → 模型 →「DSH · DeepSeek」卡片**：源码位置（输入或选择文件夹）、版本 · 提交 · 是否已构建、「检查」（起 DSH、initialize、在 `<数据目录>/dsh/probe` 开一个会话再关，不调模型）、更新步骤。没设置或没构建时，这个模型不出现在任何模型选择里（`ModelProfile.unavailable`）。
- 接口：`GET /api/dsh`、`PUT /api/dsh {path}`、`POST /api/dsh/check`。

## 依赖 DSH 的地方（拉了新版本不能用时先查这些，都在 `runtime/dsh/install.ts`）

`apps/cli/lib/bin.js`、`apps/cli/package.json`（版本）、`--profile acp`、环境变量 `DSH_HOME` / `DSH_PERMISSION_MODE` / `DEEPSEEK_API_KEY`、ACP v1（initialize / session/new / resume / close / prompt / cancel / set_config_option、session/update、session/request_permission）、配置项 id `model` / `reasoning_effort`、批准选项 `allow_once` / `reject_once`、DSH 的工具名（只影响行的样子）。「检查」覆盖到开会话为止；要连模型一起验：

```
AMO_STUDIO_DSH_CLONE=G:\PROJECT\deepseek-harness npx vitest run packages/host/src/runtime/dsh/dsh-real
```

（真 DeepSeek 2 次，计入 budget.json：跑一条命令、通过 AMO MCP 读自己的任务标题。）

## 测试

- testkit `fake-acp-agent`：脚本化的 ACP agent，和 DSH 说同样的协议（`[[ask: 命令]]` 批准、`[[slow]]` 等取消、`[[mcp: 工具]]` 真连 AMO MCP、`[[env]]` 报环境、`[[context: N]]`、`[[fail]]`），会话存在 `DSH_HOME` 里，换进程能恢复。
- 单测 `runtime/dsh/dsh.test.ts`（型号 id、权限、工具行、源码位置设置和「暂不可用」），集成 `dsh-runtime.integration.test.ts`（整个 Host + 假 agent：一轮、批准允许 / 拒绝、排队和打断、MCP 身份卡和隐藏的写入工具、Host 重启后恢复和选项、选择项和「检查」、失败的一轮），`dsh-real.integration.test.ts`（真 DSH，见上）。
- e2e `dsh.spec.ts`（`launchStudio({ dsh: true })` 加「Mock DSH」）：批准卡片、排队、打断、没有分支和终端；设置里的源码位置、版本、「检查」。截图 `screenshots/stage-17/S17-dsh-*`。

## 已知问题

- 只读模式下 DSH 沙箱里的 pwsh 每次输出都带一段乱码 stderr（受限语言模式），模型会多花几步（s17-01）；默认的工作区可写没有。
- DSH 是 rc 版本，变化快；每次拉取、构建后点「检查」，大改后再跑一次 `dsh-real`。
