# 删除旧 AMO：清单（只列，不删）

**状态：等你决定（NEEDS_YOU S3-10）。loop 不会执行这里的任何删除。** 下面按"删 / 留 / 要你定"分好，执行时一次提交、可回退（git 历史里都在）。

依据：2026-10-14 `studio/main` 上 `git ls-files` 的结果（不含 `studio/` 共 475 个文件）。

## 一、建议删除（旧 AMO 的代码与运行）

| 路径 | 文件数 | 是什么 | Studio 里的替代 |
|---|---|---|---|
| `broker/` | 157 | 旧 AMO 的后台：Hook 接收、任务卡片、会话路由、Obsidian 生成 | `studio/packages/host` |
| `overlay/` | 177 | 旧 AMO 的 Tauri 前端（悬浮卡片、Workspace Center、Canvas、Focus Panel、Scratchpad） | `studio/packages/app` + `ui` |
| `scripts/`（`adapters`、`amo`、`broker`、`demo`、`performance`、`release`、`window-routing`） | 约 20 | 启动、验证、发布、Hook 适配脚本 | `studio/scripts` |
| `scripts/models/` | — | DeepSeek 路由检查（`npm run deepseek:routing`） | Studio 的模型配置；先确认你是否还在用这个命令 |
| `tools/canvas-mcp-test/` | 9 | 旧 Canvas MCP 测试工具 | Studio 的 AMO MCP |
| `examples/`（`events`、`hooks`） | 4 | 旧 Hook 事件样例 | 不需要（Studio 不用 Hook） |
| `amo.ps1`、`amo.local.example.json` | 2 | 旧 AMO 启动入口与本地配置样例 | `AMO Studio.exe` |
| 根 `package.json` 的旧脚本（`amo:*`、`broker:*`、`adapters:*`、`routing:*`、`demo:*`） | — | 同上 | 根 `package.json` 改成指向 `studio/`，或删掉 |
| `.github/workflows/release-portable.yml` | 1 | 旧 AMO 的 Portable 发布（Tauri） | 要换成 Studio 的 `npm run package:portable`（见"三"） |

## 二、建议保留

| 路径 | 原因 |
|---|---|
| `studio/` | 新版本身 |
| `docs/next-gen-vision-architecture-2026-10.md`、`docs/protocol-session-spike-2026-10-12.md` | Studio 的设计依据 |
| `LICENSE`、`THIRD_PARTY_NOTICES.md` | 许可证；`THIRD_PARTY_NOTICES` 要按 Studio 的依赖重写（Electron、React、Agent SDK、MCP SDK 等） |
| `.gitignore` | 保留，删掉只与旧 AMO 有关的条目 |

## 三、要你定

| 路径 / 事项 | 选项 |
|---|---|
| `docs/` 其余 97 个文件（旧 AMO 的设计、任务记录、Obsidian 插件资料、发布说明） | 全删 / 移到 `docs/archive-old-amo/` 保留查阅（我建议移走，不删） |
| 根 `README.md`、`USER_SESSION_MANUAL.md`、`DEVELOPMENT.md`、`PROJECT_PLAN.md` | 改写成 Studio 的入口（内容可直接用 `studio/README.md`）/ 删除 |
| 目录结构 | `studio/` 保持原位（改动最小）/ 把 `studio/` 的内容提到仓库根目录（路径都要改，风险大，不建议） |
| GitHub Release | 旧 AMO 的 Release 页是否保留；Studio 的 zip 以后是否发到 Release（`release-portable.yml` 换成 Studio 的打包） |
| 你本机旧 AMO 的数据（`broker/data/` 等，不在 git 里） | loop 不会碰。删代码不影响这些文件；要不要清理由你在本机处理 |

## 四、删之前要知道的

- **工程里旧 AMO 留下的文件**：旧 AMO 往你的工程里部署过 Hook（`.codex/hooks.json`、`.grok/hooks/amo.json`、`.claude/settings.local.json` 里的 Hook、`.amo/`）。删掉旧 AMO 后这些 Hook 找不到后台，CLI 里可能会报 Hook 失败。需要逐个工程清掉；loop 不会去你的真实工程里改，删除前我可以先写一个只读的检查脚本，列出哪些工程还有这些文件。
- **`.amo/` 被 Git 排除**：旧 AMO 的"Git exclude"会把 `.amo/` 写进工程的 `.git/info/exclude`。Studio 的扩展包放在 `.amo/packs/`，如果某个工程做过这一步，扩展包默认不会进提交；要提交就删掉那一行，或者 `git add -f .amo/packs`。（已写进 `design/pack-format.md`）
- **旧 AMO 的密钥泄露问题**：阶段 4 发现旧 AMO 启动的 Codex/Claude 可能让 agent 的命令读到模型密钥（Studio 已修）。删除旧 AMO 后这个问题自然消失；在那之前如果还在用旧 AMO，要知道有这个风险。
- 执行时会先在分支上删除、跑一遍 Studio 的完整验证和 e2e、确认 `studio/` 不依赖任何被删的文件，再请你确认合并。
