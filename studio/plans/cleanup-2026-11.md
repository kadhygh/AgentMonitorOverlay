# 项目梳理（2026-11-03 调查，11-04 起推进）

11-03 对 `studio/` 全部包做了一轮只读梳理（三个子代理分别看 host + protocol、ui + relay-ui、平台 / 中转 / 发布脚本，主会话核对文档、分支、发布状态并抽查）。用户看过推进建议（当时的阅读版 `out/html/cleanup-plan.html`，不进 git）后定：建议都照做，按流程推进一轮（11-04）。

规则：小改动在主工作区改、验证后提交进 master（维护迭代车道）；会动三个 runtime 或结构的放 worktree，合并前用户点头；删除类的清理（worktree、分支、旧包）先问用户。

## 进度

| 步 | 内容 | 状态 |
|---|---|---|
| 0 | 先定的事 | 见下面「第 0 步」 |
| 1 | 文档对齐 | ✓ 11-04 |
| 2 | 发布脚本漏判 | ✓ 11-04 `dbc97045` |
| 3 | 消息投递统一 | ◐ 11-04 开工：worktree `.claude/worktrees/cleanup-delivery`，分支 `studio/message-delivery`，方案 `plans/message-delivery.md` |
| 4 | 中转登录收口 | ○ |
| 5 | 清死代码和重复定义 | ✓ 11-04（不碰 runtime 的部分；见下） |
| 6 | 只增不删的数据 | ○ |
| 7 | ui 的数据流和共用件 | ◐ 11-04 开工：worktree `.claude/worktrees/cleanup-ui`，分支 `studio/ui-dataflow` |
| 8 | Host 结构重排 | ○ 只写方案 |

## 第 0 步：先定的事

- **教程 / showcase 的 worktree**（`.claude/worktrees/agent-a04ca2f0…`）：11-04 发现它还在出新提交，是专题里「新手引导页」任务在用的，不归这次梳理管，不动。
- **收掉已合并的 worktree 和旧包**：用户同意。11-04 删除被自动审批拦下（不可恢复的本地删除），清单留给用户点头后执行：
  - worktree：`AgentMonitorOverlay-claude-code-mirror`、`-issues`、`-package-slim`、`-send-now`、`-review`（分支都比 master 多 0 个提交；`-review` 里有一份没跟踪的 `plans/review-canvas.html`，删前拷出来）；`.claude/worktrees/agent-a16f…`、`a1bc…`、`a21c…`、`a768…`、`ab69…`、`ae99…`（10-29 的，干净、多 0 个提交）。`agent-abb445f…`（多 1 个旧提交 4f03fd47）和 `agent-a04ca2f0…`（在用）不动。
  - `studio/release/` 里 10-24 到 10-29 的 portable zip（10 个）和 `AMO Notes`、`AMO Platform`、`AMO Reviewer`、`AMO Studio` 四个旧文件夹；`platform/`、`relay/`、`relay-pack/` 是发布脚本在用的，不动。
  - `studio/Microsoft/`（PowerShell 的模块缓存，某个进程把 LOCALAPPDATA 指到了 studio 目录时写出来的）。
- **清单（checklist）**：保守默认，这一轮不拆。老任务上的清单照旧能看、能打勾；新建入口 10-31 随扩展包一起没了。第 5 步只改掉写着「pack template」的过时注释。
- **中转客户端的登录**：有平台账号时不再显示中转自己的登录 / 注册；没装平台的人照旧能登录（约束 7 的过渡例外，写进 AGENTS.md）。MCP 用的身份不再明文放在设置文件里。

## 第 1 步：文档对齐（✓ 11-04）

- HANDOFF：「当前状态」改成现在的（worktree、用户在用的是平台装的 Studio、发布走 `release`、额度数字、平台和中转进会话的状态、过时的「没合进 / 没发布」加了注）；10-26 到 10-31 的记录挪进 `docs/history/handoff-2026-10-late.md`；补回了 5 处被转义吃掉的反斜杠（`\.local\bin` 等成了控制字符）。
- AGENTS.md：约束 1 补 `platform.json`、`device.json`；e2e project 补 `platform`；`relay:release`、`relay:mac` 写明是 `release` 的底层步骤。
- `packages/relay/README.md`、五份 CHANGELOG 开头、`start-platform.ps1`：发布命令改成 `npm run release -- …`。

## 第 2 步：发布脚本漏判（✓ 11-04，`dbc97045`）

- 中转服务的改动范围加上 `packages/locate`（服务打包时带上 `locate/download`）和 `ui/src/styles/base.css`（relay-ui 的构建引它）。
- 中转外壳 zip 的触发条件加上 account、traymenu、locate（从 `TOOLS.relay.packages` 推）。
- `writeVersion` 顺带改 `package-lock.json` 里这个工具的版本；落后的五个当场对齐。
- 验证：`node --check`、lock 的正则对过真实文件、`release status` 照常。`release relay-service` 本身没跑（会部署）。

## 第 3 步：消息投递统一

为什么最要紧：这一轮唯一会直接丢消息、界面又看不出来的问题，丢的多半是没人盯着的那类（中转回复、值守、画布回答、远程 B 发的）。

证据：DSH 一轮出错时 `live.queue.splice(0)`（`dsh-runtime.ts`），排队只在内存，user item 不带 `delivery`；重启收尾不管排队的；不收 `now`。中转回复 `void sendMessage(...).catch(console.log)`（`teamrelay/service.ts`），注释说「queued while it works」但对 Codex 是插进当前轮。调 `sessions.sendMessage` 的入口 9 个以上，只有 session_send 落盘排队。三个 runtime 的重启收尾、归档、`profileGone`、停止兜底、「忙」的状态集合各写一份。

做法：方案和进度另写 `plans/message-delivery.md`，worktree 里做。

## 第 4 步：中转登录收口

见第 0 步的决定。`relay-ui/src/Login.tsx`、`relay-app` 的 `accounts.json` / `relay:save-account`、`relay/src/client.ts` 的 `writeSettings`（MCP 身份明文）。顺带确认 DSH、Codex 进程环境里的 Key 会不会被带给 agent 跑的命令。

## 第 5 步：清死代码和重复定义

token 模式残留（`ClaudeLogin`、`claude.login:` 键、token 分支）；`protocol/examples.ts` 的 `codex-deepseek-flash`；没人用的导出；`URGENCY` 两份、todo 类型两份；`base.css` 浅色主题整块复制；没人用的 CSS 类；`smoke:stage*`、`relay-service.ps1`、`bench-session-open.mjs`。会动 runtime 的（`BUSY_STATUSES`）并进第 3 步。

11-04 做了（主工作区，提交进 master）：
- `URGENCY` 只留 protocol 一份，导出 `mostUrgentStatus`，MCP 读模型改用它。
- 删了没人用的 `sessionOwner` / `SessionOwner` / `sameOwner`、`isCommentRange`。
- `examples.ts` 的样例渠道换成中性的 `codex-fast`。
- `smoke-stage1/4/5/7.mjs` 跑不起来了（用的渠道 11-03 已删），挪进 `docs/archive/scripts/`，去掉 `smoke:stage*` 命令。
- checklist 的注释写明现状（不拆，第 0 步）。

核对后**不动**的（审查说是残留，实际在用）：`ClaudeLogin = "token"` 是 API Key 渠道用的 Studio 自己的配置目录，不是 10-27 删掉的 token 模式；`scripts/relay-service.ps1` 是 relay README 写明的退路（Mac 出问题时在本机起服务）；`bench-session-open.mjs` 是手动用的测量脚本；`RemoteCommandBodies`、`HostEventType` 这类类型别名留着当协议说明。交给别的步骤的：没人用的 CSS 类和 `base.css` 的重复变量（第 7 步的会话在改 ui）；todo 类型两份（relay 不依赖 protocol，合并要动中转服务的依赖，放进第 6 步和中转一起做）。

## 第 6 步：只增不删的数据

purge 不删按会话的 kv 键；DSH 日志不轮转不删；中转的孤儿截图和上传没有清理、没有保留期、20 MB 同步写；中转数据库没有 `user_version`。kv 约 60 个键没有登记。

## 第 7 步：ui 的数据流和共用件

`useLiveResource` 统一「订阅 → 加载 → 断线重读」（先换掉没处理重连的 6 处）；设置、值守单例；`lib/Modal`、`lib/ContextMenu`、`styles/controls.css`；`lib/stored.ts`；一个 `request()` 底座。

## 第 8 步：Host 结构重排（这一轮只写方案）

8a 远程副本收成一个 runtime、团队连接拆成 `core/teamlink`、路由元数据代替 `COPY_ROUTES`；8b 带类型的路由、各主题 Routes、重新生成 Codex 类型；8c feature 声明依赖；8d 大文件拆分。
