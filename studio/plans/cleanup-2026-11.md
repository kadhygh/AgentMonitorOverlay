# 项目梳理（2026-11-03 调查，11-04 起推进）

11-03 对 `studio/` 全部包做了一轮只读梳理（三个子代理分别看 host + protocol、ui + relay-ui、平台 / 中转 / 发布脚本，主会话核对文档、分支、发布状态并抽查）。用户看过推进建议（当时的阅读版 `out/html/cleanup-plan.html`，不进 git）后定：建议都照做，按流程推进一轮（11-04）。

规则：小改动在主工作区改、验证后提交进 master（维护迭代车道）；会动三个 runtime 或结构的放 worktree，合并前用户点头；删除类的清理（worktree、分支、旧包）先问用户。

## 进度

| 步 | 内容 | 状态 |
|---|---|---|
| 0 | 先定的事 | 见下面「第 0 步」 |
| 1 | 文档对齐 | ✓ 11-04 |
| 2 | 发布脚本漏判 | ✓ 11-04 `dbc97045` |
| 3 | 消息投递统一 | ✓ 11-04 合进 master（`6a231509`，分支 `studio/message-delivery`）；方案、用户定的五条和没验证的在 `plans/message-delivery.md` |
| 4 | 中转登录收口 | ✓ 11-04 `0d56e627`（中转外壳的「下一版」有一条，会随自动打包发到测试通道） |
| 5 | 清死代码和重复定义 | ✓ 11-04（不碰 runtime 的部分；见下） |
| 6 | 只增不删的数据 | ✓ 中转那一半 11-04 `6280aeb4`（没部署）；Host 那一半 11-04 `48ecf1eb` |
| 7 | ui 的数据流和共用件 | ✓ 前两批 11-04 合进 master（`36cc5a49`，分支 `studio/ui-dataflow`）；第三批和 base.css 下一轮 |
| 8 | Host 结构重排 | ✓ 方案 `plans/host-structure.md`（11-04）；代码下一轮按 8a → 8d 做，新开 worktree |

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

11-04 做了（`0d56e627`）：
- 核对后：平台装的中转从 10-29 起就只显示「在 AMO 平台里登录」（`relay-ui/src/main.tsx` 的 `PlatformLogin`），自己的登录框只给手动解压、没装平台的客户端。这正是第 0 步定的过渡例外，不用改界面，写进了 AGENTS.md 第 7 条。
- 真正的问题是 `settings.json` 里的明文 key：平台账号登录时改成只记 `{ server, name, account: "platform" }`，MCP 和 `amo-relay` 用 `loadSettings` 现解 `account.json`（两个文件都没变时用缓存）；以前写下的明文在外壳启动时换掉。`@amo-studio/relay` 因此依赖 `@amo-studio/account`，`release.mjs` 的中转服务范围也加上了它。
- 验证：`client.test.ts` 3 条；typecheck；relay、relay-app、account 单测 90 条；打出来的 `amo-relay.mjs` 配一个引用文件，用本机真实的平台账号（DPAPI）`whoami` 通过，0.46 秒。
- 没验证：平台装的中转外壳真跑一次（等自动打包发出 0.9.7 后，用户打开中转、再看 `settings.json` 里没有 key）；MCP 在真实 Claude 会话里调用。
- 11-04 夜查了（读代码，没改）：DSH、Codex、Claude 进程环境里的 Key 都不会带给 agent 执行的命令。Codex：`runtime/profiles.ts` 给 app-server 加 `shell_environment_policy.ignore_default_excludes=false` 和 `exclude=[渠道的 env_key…, AMO MCP token, MCP 服务器的密钥]`（S4-09）。Claude：`claude-env.ts` 的 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`（S4-09 实测过 `env` 不再打出 key）。DSH：命令由 DSH 自己的 `subprocess-local` 起，`childEnv` → `scrubbedParentEnv` 去掉名字含 KEY / PASSWORD / SECRET / TOKEN 和 `DSH_` 开头的变量（`G:\PROJECT\deepseek-harness` 的 `packages/subprocess/subprocess/src/index.ts`），`DEEPSEEK_API_KEY` 在内；AMO MCP 的身份走请求头，不在环境变量里。DSH 这条要跟着 DSH 更新留意。

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

11-04 做了中转那一半（`6280aeb4`，**没部署**：`npm run release -- relay-service` 会重启中转几秒，等用户说）：
- 问题页从没挂到问题上的截图，一周后连文件一起删（`IssueStore.pruneOrphanImages`，服务启动时和每 6 小时一次）；
- 上传的文件和截图改成异步写盘（`fs/promises`），不再卡住服务。
- 验证：relay 单测 78 条（新加一条：没用上的图连文件删掉，用上的留着）。

留到后面的：
- 聊天记录 `messages`、`task_events` 要不要有保留期：要用户定，这一轮不动。
- 管理页显示数据目录占用：下一轮。
- `user_version` 迁移：并进 `plans/host-structure.md` 8d，和拆 `store.ts` 一起做。

11-04 晚做了 Host 那一半（`48ecf1eb`）：
- kv 键登记表 `host/src/store/kv-keys.ts`：66 个键，每个写明作用域（全局 / 按会话 / 按任务 / 按项目 / 按文件夹 / 按 MCP token）、在哪个文件、存的是什么。`kv-keys.test.ts` 扫 Host 源码，用了没登记、登记了没在用的键都会让测试失败。
- `Store.purge` 删会话、任务、项目时，一起删按它们存的 kv 键（会话 6 种加 MCP token 的反查键，任务的 `remote.review-comments:`，项目的 `mcp:project:`）。
- DSH 的 stderr 日志（`dsh/logs/`）：单个超过 2 MB 时，进程启动前改名成 `<label>.old.log`（只留一份）；Host 启动 20 秒后删掉 30 天没写过的日志和一天以上的空日志。删掉的会话的日志不再写入，也按这条规则过期。DSH 自己 `home/` 里的会话记录不动。
- 本机实测：kv 共 631 个键，还没有孤儿（没删过会话）；`dsh/logs` 50 个文件、17 KB，大多是空的 `new-*.log`。
- 没做的：几个全局键里存的会话 id 列表（`duty.sessions`、`issues.sessions` 各留最近 300 个，`teamrelay.threads`、`sessions.inbox`）删会话时不跟着删，留着只是多几个找不到的 id，不影响使用。
- todo 类型两份（`protocol/todo.ts` 和 `relay/src/todo-protocol.ts`）：relay 现在依赖 account 不依赖 protocol，合并时再定从哪边出。

## 第 7 步：ui 的数据流和共用件

`useLiveResource` 统一「订阅 → 加载 → 断线重读」（先换掉没处理重连的 6 处）；设置、值守单例；`lib/Modal`、`lib/ContextMenu`、`styles/controls.css`；`lib/stored.ts`；一个 `request()` 底座。

进度（2026-11-04，分支 `studio/ui-dataflow`，前两批 11-04 合进 master `36cc5a49`）：

- **第一批（897a8b25）**：`host/live.ts`（`watchLive` / `useLiveResource`：现在加载、每次重连重读、`reloadOn` 的事件重读，加载途中收到的事件补到答案上，只认最后一次加载）、`host/shared.ts`（`sharedLive`：按连接一份的单例，多个组件共用一次加载）；`settings/useSettings.ts`、`useProfiles`、值守 `useDuty` 用它，DutyPage 不再自己加载两遍；二十多处「订阅 + 加载」换成它，`mergeFirstLoad` 删掉。新 e2e `reconnect-settings`：Host 被杀、换 pid 起来后，断线期间加的预设和值守项出现在设置里。
  - 查出来的：`window.amo.host()` 每次重连给一个新的 link 对象，所以按 `[link]` 的 effect 本来就会在重连后重跑——「没处理重连的 6 处」实际不会停在旧数据上，带 `onHostReconnect` 的反而重连后加载两次。现在都只加载一次。
  - 没换：`useCanvas`、`useSessionItems`、`useScratchpad`（各有自己的合并/乐观更新，换了风险大于收益）。
- **第二批**：`lib/Modal`（焦点进出、Esc 只关最上面一层、`busy`、表单）、`lib/ContextMenu`（`useMenuDismiss` + `useInWindow`：Esc、点外面、滚轮、窗口失焦都关，贴边时往回挪）；19 个对话框、8 个菜单换过去（SettingsDialog 没换：尺寸是拖出来的；它本来就按 Esc 关，`SettingsDialog.tsx` 自己听 keydown）。`styles/controls.css` 收 `.modal*`、`.ctx-menu`、`.action-menu`、`.field`、`.form-error`、按钮等共用规则，原样搬、保持原先的先后；搬动会翻转胜负的几处（`.archived-dialog`、`.description-dialog`、`.todo-bind-dialog`、`.callout-dialog` 的宽度、`.model-menu` 的 min-width、`.usage-switch`）是一直输给 `.modal` 的死声明，删掉，样子不变。
  - base.css 两块浅色变量**没合**：用 `@container style()` 会把变量挪到 body，`code.css` 等在 `:root` 上派生的变量就断了；用 JS 要同时改 Studio 和 relay-ui 的 theme.ts；而且 relay-ui 也引 base.css，一改就得部署中转服务。chat.css、gitreview.css、stats.css、code.css 里是同样的重复写法。用户 11-04 定：这一轮不做。
  - 验证：typecheck（三套）；ui 单测 52 个文件 331 条；e2e 93 条（studio 里涉及这些对话框和菜单的 30 个 spec，加 notes、reviewer、platform）全过。截图对比：先在第一批的构建上跑一遍同样的 spec 和一个临时的浅色/深色截图 spec（看板、设置、专题右键、确认框、画布右键、任务说明），换上第二批再跑，逐像素比：同一构建跑两遍也会变的（时间、端口、机器人表情）之外，剩下的差别都是对话框标题文字的抗锯齿，或者是比对用的旧截图本身是 10-28 拍的（顶栏那时还没有「远程」）。临时 spec 和它的截图（`screenshots/controls/`）没提交。
- **第三批**（`lib/stored.ts`、`request()` 底座、统一 `formatBytes`）：这一轮没做。`formatBytes` 有三份（`attach/refs.ts`、`notes/api.ts`、`platform/bridge.ts`），输出各不相同（KB 取整还是一位小数、有没有 GB），合成一份会改用户看到的数字。用户 11-04 定：一律一位小数、到 GB（如 `1.5 MB`），下一轮做。

- 合并（11-04）：master 合进分支只冲突了三份 CHANGELOG（两边都留）；typecheck、单测 1247 条（三条 git 用例在全量负载下超时，单独跑过）、全部 e2e 224 条过。没过的两条在合并前的 master 上也不过，和这一步无关：`cli.spec` 的 Codex 压缩、`turn-start` 的「Focus 看过就消失」。

## 第 8 步：Host 结构重排（这一轮只写方案）

8a 远程副本收成一个 runtime、团队连接拆成 `core/teamlink`、路由元数据代替 `COPY_ROUTES`；8b 带类型的路由、各主题 Routes、重新生成 Codex 类型；8c feature 声明依赖；8d 大文件拆分。
