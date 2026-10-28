# Studio 的实际实现（截至阶段 8）

> **2026-10-28 标注：这份写于阶段 8，下面这些已经过时**，以代码和根目录 `AGENTS.md` 为准：
> - 包不止这五个：还有 `notes`（AMO 便签）、`reviewer`（AMO Reviewer）、`relay` / `relay-ui` / `relay-app`（AMO 中转），各自的说明见 `AGENTS.md` 的工具表；
> - 运行时多了 `runtime/dsh`（DeepSeek 走 DSH，`plans/done/stage-17-dsh.md`），模型接入改成「渠道」（`runtime/channels.ts`）；Claude 只走本机 Claude Code 登录，令牌方式 10-27 去掉了；
> - 数据库迁移早已超过 v7；
> - Portable 版数据默认放 exe 旁 `data/` 的做法，平台装的版本会用 `AMO_STUDIO_DATA_DIR` 改掉（`plans/amo-lan-platform.md`）。
>
> 进程结构、Host 的 API / MCP 分工、安全边界这几节大体还对。以后要重写时，把中转、便签、Reviewer、平台一起写进来。

愿景文档（`docs/next-gen-vision-architecture-2026-10.md`）写的是目标；这里写现在代码里是怎么做的，方便以后改动时找到位置。

## 进程

```
AMO Studio.exe（Electron 主进程，packages/app）
 ├─ 工作台窗口 / Focus 窗口（packages/ui，React，由 Host 提供静态文件）
 └─ 启动或连接 Host（同一个 exe，ELECTRON_RUN_AS_NODE；常驻，关窗口不退出）
      Host（packages/host）
       ├─ HTTP + WebSocket API（127.0.0.1，令牌鉴权；端口默认 47900）
       ├─ Store：node:sqlite，数据目录下 studio.db（迁移 v1–v7；v7 是组织结构 v2，见 design/structure.md）
       ├─ Codex 运行时：每个模型配置一个 codex app-server（47910–47949），JSON-RPC over WebSocket
       ├─ Claude 运行时：Claude Agent SDK（自带 claude.exe），每个会话一个查询
       └─ AMO MCP：Codex 走 HTTP /mcp（每个线程带自己的身份请求头），Claude 走进程内 MCP 服务
```

## 包

| 包 | 内容 |
|---|---|
| `protocol` | 实体、API 路由类型、事件；纯函数：会话树、画布布局与大纲、批注汇总、扩展包校验、工程空闲判定 |
| `host` | `service.ts`（业务）、`http/server.ts`（路由）、`store/`、`runtime/codex`、`runtime/claude`、`mcp/`（工具、身份、读模型）、`packs/`（扩展包加载、预设草稿）、`scheduler/`（调度简报）、`terminal/`（交接终端） |
| `app` | Electron 主进程：窗口、Focus、单实例、数据目录（`paths.ts`）、首次设置（`setup.ts`）、Host 连接 |
| `ui` | 看板、任务页（对话、会话树、审阅、右栏面板）、画布、新任务、扩展包页、Focus |
| `testkit` | mock 模型（Codex 用的 Responses API、Claude 用的 Messages API）、端口与临时目录工具、额度计数 |

## 数据

- 数据目录：开发 `studio/.data`；Portable 版首次设置选的目录（默认 exe 旁 `data/`），见 `packages/app/src/paths.ts`。
- 里面：`studio.db`、`host.json` / `host-token`（Host 地址和令牌）、`host.log`、`claude-home/`（受管 Claude 的配置目录）、`codex/`（app-server 状态与令牌）、`electron/`（浏览器配置）、`mcp-token`。
- 不碰：`~/.codex/config.toml`、`~/.claude`、凭据管理器（只读）。

## 安全边界（按阶段累积）

- API 只听 127.0.0.1，需要令牌；MCP 用单独的令牌，只能访问 `/mcp`。
- agent 运行的命令读不到模型密钥（Codex `shell_environment_policy`、Claude `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`）。
- MCP 写入一律按调用者自己的会话限定；画布写入要人批准；调度只能提案；派发未开放。
- 扩展包按不可信内容处理：只读、路径解析符号链接后不越界、不执行代码、预设经人确认。
- 测试窗口在屏幕外、不进任务栏、不获得焦点；测试只在 `%TEMP%` 下的沙箱里跑。

## 测试

- 单测：vitest（`npm run test`），Host 接口测试用假的 app-server。
- 端到端：Playwright + Electron（`npm run e2e`），mock 模型。
- 真实冒烟：`scripts/smoke-stage*.mjs`，只用 GLM / DeepSeek，计入 `budget.json`。
- Portable：`npm run package:portable` + `npm run smoke:portable`。
