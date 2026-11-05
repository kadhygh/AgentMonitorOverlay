# 项目梳理（2026-11-03 调查，11-04 起推进）

> 状态：做完（第 0–7 步 2026-11-04～05 进 master，最晚的第 7 步第三批随 Studio 0.9.38 发布；第 6 步中转那一半随中转服务 0.7.11 部署）。第 8 步（Host 结构重排）还在做，剩下的在 `plans/host-structure.md`。几项明确留到以后的列在各步的「留到以后」里。各步的执行细节、验证数字 2026-11-06 删掉了，原文见 git 历史（提交 f46907f2 之前的版本）。

11-03 对 `studio/` 全部包做了一轮只读梳理（三个子代理分别看 host + protocol、ui + relay-ui、平台 / 中转 / 发布脚本，主会话核对文档、分支、发布状态并抽查）。用户看过推进建议（当时的阅读版 `out/html/cleanup-plan.html`，不进 git）后定：建议都照做，按流程推进一轮（11-04）。

规则：小改动在主工作区改、验证后提交进 master（维护迭代车道）；会动三个 runtime 或结构的放 worktree，合并前用户点头；删除类的清理（worktree、分支、旧包）先问用户。

## 各步

| 步 | 内容 | 结果 |
|---|---|---|
| 0 | 先定的事 | 见下面「第 0 步」 |
| 1 | 文档对齐 | ✓ 11-04 |
| 2 | 发布脚本漏判 | ✓ 11-04 `dbc97045` |
| 3 | 消息投递统一 | ✓ 11-04 合进 master（`6a231509`，分支 `studio/message-delivery`）；方案、用户定的五条和没验证的在 `plans/done/message-delivery.md` |
| 4 | 中转登录收口 | ✓ 11-04 `0d56e627`（中转 0.9.7） |
| 5 | 清死代码和重复定义 | ✓ 11-04（不碰 runtime 的部分；见下） |
| 6 | 只增不删的数据 | ✓ 中转那一半 11-04 `6280aeb4`；Host 那一半 11-04 `48ecf1eb` |
| 7 | ui 的数据流和共用件 | ✓ 前两批 11-04 合进 master（`36cc5a49`，分支 `studio/ui-dataflow`）；第三批 11-05 在 master 上做完；base.css 用户定不做 |
| 8 | Host 结构重排 | ◐ 方案和进度在 `plans/host-structure.md`：8a、8b、8c 合进 master，8d 和剩下的 feature 环没做 |

## 第 0 步：先定的事

- **教程 / showcase 的 worktree**（`.claude/worktrees/agent-a04ca2f0…`）：是专题里「新手引导页」任务在用的，不归这次梳理管，不动。
- **收掉已合并的 worktree 和旧包**：用户同意（删除先问用户点头）。2026-11-06 看已经删掉：比 master 多 0 个提交的旧 worktree、`studio/release/` 里 10-24 到 10-29 的 portable zip 和四个旧程序文件夹、`studio/Microsoft/`（PowerShell 的模块缓存，某个进程把 LOCALAPPDATA 指到了 studio 目录时写出来的）。`agent-abb445f…`（多 1 个旧提交 4f03fd47）和 `agent-a04ca2f0…`（在用）按决定留着；`studio/release/` 的 `platform/`、`relay/`、`relay-pack/` 是发布脚本在用的，不动。
- **清单（checklist）**：保守默认，这一轮不拆。老任务上的清单照旧能看、能打勾；新建入口 10-31 随扩展包一起没了。
- **中转客户端的登录**：有平台账号时不再显示中转自己的登录 / 注册；没装平台的人照旧能登录（约束 7 的过渡例外，写进 AGENTS.md）。MCP 用的身份不再明文放在设置文件里。

## 第 1 步：文档对齐

HANDOFF「当前状态」、AGENTS.md（约束 1、e2e project、`release` 的底层步骤）、relay README 和各 CHANGELOG 里的发布命令统一成 `npm run release -- …`。

## 第 2 步：发布脚本漏判

中转服务的改动范围加上 `packages/locate` 和 `ui/src/styles/base.css`（relay-ui 的构建引它）；中转外壳 zip 的触发条件从 `TOOLS.relay.packages` 推；`writeVersion` 顺带改 `package-lock.json` 里这个工具的版本。

## 第 3 步：消息投递统一

为什么最要紧：这一轮唯一会直接丢消息、界面又看不出来的问题，丢的多半是没人盯着的那类（中转回复、值守、画布回答、远程 B 发的）。方案和用户的决定在 `plans/done/message-delivery.md`。

## 第 4 步：中转登录收口

- 平台装的中转从 10-29 起就只显示「在 AMO 平台里登录」（`relay-ui/src/main.tsx` 的 `PlatformLogin`），自己的登录框只给手动解压、没装平台的客户端。这正是第 0 步定的过渡例外，不用改界面，写进了 AGENTS.md 第 7 条。
- 真正的问题是 `settings.json` 里的明文 key：平台账号登录时改成只记 `{ server, name, account: "platform" }`，MCP 和 `amo-relay` 用 `loadSettings` 现解 `account.json`（两个文件都没变时用缓存）；以前写下的明文在外壳启动时换掉。`@amo-studio/relay` 因此依赖 `@amo-studio/account`，`release.mjs` 的中转服务范围也加上了它。
- 11-04 时没验证：平台装的中转外壳真跑一次后 `settings.json` 里确实没有 key；MCP 在真实 Claude 会话里调用。
- 读代码确认过（11-04）：DSH、Codex、Claude 进程环境里的 Key 都不会带给 agent 执行的命令。Codex：`runtime/profiles.ts` 给 app-server 加 `shell_environment_policy.ignore_default_excludes=false` 和 `exclude=[渠道的 env_key…, AMO MCP token, MCP 服务器的密钥]`（S4-09）。Claude：`claude-env.ts` 的 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`（S4-09 实测过 `env` 不再打出 key）。DSH：命令由 DSH 自己的 `subprocess-local` 起，`childEnv` → `scrubbedParentEnv` 去掉名字含 KEY / PASSWORD / SECRET / TOKEN 和 `DSH_` 开头的变量（`G:\PROJECT\deepseek-harness` 的 `packages/subprocess/subprocess/src/index.ts`），`DEEPSEEK_API_KEY` 在内；AMO MCP 的身份走请求头，不在环境变量里。**DSH 这条要跟着 DSH 更新留意。**

## 第 5 步：清死代码和重复定义

做了：`URGENCY` 只留 protocol 一份（`mostUrgentStatus`）；删了没人用的 `sessionOwner` / `SessionOwner` / `sameOwner`、`isCommentRange`；`examples.ts` 的样例渠道换成中性的 `codex-fast`；跑不起来的 `smoke-stage1/4/5/7.mjs` 挪进 `docs/archive/scripts/`，去掉 `smoke:stage*` 命令。会动 runtime 的（`BUSY_STATUSES`）并进了第 3 步；没人用的 CSS 类交给了第 7 步（第 7 步的记录里没写清删没删，2026-11-06 没核实）；todo 类型两份见第 6 步。

核对后**不动**的（审查说是残留，实际在用）：`ClaudeLogin = "token"` 是 API Key 渠道用的 Studio 自己的配置目录，不是 10-27 删掉的 token 模式；`scripts/relay-service.ps1` 是 relay README 写明的退路（Mac 出问题时在本机起服务）；`bench-session-open.mjs` 是手动用的测量脚本；`RemoteCommandBodies`、`HostEventType` 这类类型别名留着当协议说明。

## 第 6 步：只增不删的数据

起因：purge 不删按会话的 kv 键；DSH 日志不轮转不删；中转的孤儿截图和上传没有清理、20 MB 同步写；中转数据库没有 `user_version`；kv 约 60 个键没有登记。

做了：
- 中转：问题页从没挂到问题上的截图，一周后连文件一起删（`IssueStore.pruneOrphanImages`，服务启动时和每 6 小时一次）；上传的文件和截图改成异步写盘。
- Host：kv 键登记表 `host/src/store/kv-keys.ts`，每个键写明作用域、在哪个文件、存的是什么，`kv-keys.test.ts` 扫源码对账（用了没登记、登记了没在用都失败）；`Store.purge` 删会话、任务、项目时一起删按它们存的 kv 键；DSH 的 stderr 日志（`dsh/logs/`）单个超过 2 MB 时启动前改名成 `<label>.old.log`（只留一份），Host 启动 20 秒后删掉 30 天没写过的和一天以上的空日志。DSH 自己 `home/` 里的会话记录不动。

留到以后：
- 聊天记录 `messages`、`task_events` 要不要有保留期：要用户定，这一轮不动。
- 管理页显示数据目录占用：下一轮。
- 中转的 `user_version` 迁移：并进 `plans/host-structure.md` 8d，和拆 `store.ts` 一起做。
- 几个全局键里存的会话 id 列表（`duty.sessions`、`issues.sessions` 各留最近 300 个，`teamrelay.threads`、`sessions.inbox`）删会话时不跟着删：只是多几个找不到的 id，不影响使用，没做。
- todo 类型两份（`protocol/todo.ts` 和 `relay/src/todo-protocol.ts`）：relay 依赖 account 不依赖 protocol，合并时再定从哪边出。

## 第 7 步：ui 的数据流和共用件

做了：`host/live.ts` 的 `watchLive` / `useLiveResource`（现在加载、每次重连重读、`reloadOn` 的事件重读，加载途中收到的事件补到答案上，只认最后一次加载）和 `host/shared.ts` 的 `sharedLive`（按连接一份的单例）；`lib/Modal`（焦点进出、Esc 只关最上面一层、`busy`、表单）、`lib/ContextMenu`（Esc、点外面、滚轮、窗口失焦都关，贴边时往回挪）；`styles/controls.css` 收共用的对话框、菜单、表单、按钮规则；`lib/bytes.ts` 一份 `formatBytes`；`lib/stored.ts`（localStorage 读写，存储不在或满了不抛；键和存的值不变）；`host/client.ts` 一个 `request()` 底座（回的不是 JSON 时给 `HostApiError`）。

做的时候定的：
- `window.amo.host()` 每次重连给一个新的 link 对象，所以按 `[link]` 的 effect 本来就会在重连后重跑——审查说的「没处理重连的 6 处」实际不会停在旧数据上。
- 没换成 `useLiveResource` 的：`useCanvas`、`useSessionItems`、`useScratchpad`（各有自己的合并 / 乐观更新，换了风险大于收益）。SettingsDialog 没换成 `lib/Modal`：尺寸是拖出来的，它自己听 keydown 按 Esc 关。
- 搬进 `controls.css` 时会翻转胜负的几条（一直输给 `.modal` 的宽度、min-width 声明）是死声明，删掉，样子不变。
- `formatBytes` 原来三份输出各不相同，用户 11-04 定：一律一位小数、到 GB（如 `1.5 MB`）。1024 以下是 `B`，不会出现 `1024.0 KB`，NaN 和负数读成 `0 B`。`relay-ui` 和 Host 自己的大小显示不在 ui 包里，没动。
- **base.css 两块浅色变量没合**，用户 11-04 定这一轮不做。原因：用 `@container style()` 会把变量挪到 body，`code.css` 等在 `:root` 上派生的变量就断了；用 JS 要同时改 Studio 和 relay-ui 的 theme.ts；relay-ui 也引 base.css，一改就得部署中转服务。chat.css、gitreview.css、stats.css、code.css 里是同样的重复写法。

## 第 8 步：Host 结构重排

8a 远程副本收成一个 runtime、团队连接拆成 `core/teamlink`、路由元数据代替 `COPY_ROUTES`；8b 带类型的路由、各主题 Routes、重新生成 Codex 类型；8c feature 声明依赖；8d 大文件拆分。方案、规则和剩下的在 `plans/host-structure.md`。
