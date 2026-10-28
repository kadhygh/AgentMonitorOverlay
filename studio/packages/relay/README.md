# AMO 中转（amo-relay）

局域网里的小工具：人和人互相发消息；人或 AI 也能给某个人发一个「会话」，请他处理一件事，对方逐条回答后返回。聊天记录都存在中转服务上。计划见 `plans/relay.md`（阶段 1）和 `plans/relay-tasks.md`（阶段 2：会话、团队任务、文件和批注）。

界面用的是 AMO Studio 的设计：主题变量直接引用 `packages/ui/src/styles/base.css`（支持浅色和深色），顶栏、左栏、会话列表和弹窗的做法也照 Studio 来。

由四个包组成：

| 包 | 是什么 |
|---|---|
| `packages/relay` | 服务（HTTP + WebSocket，`node:sqlite`）、命令行、MCP。打包成单文件 `amo-relay.mjs` |
| `packages/relay-ui` | 客户端界面（React）：登录 / 注册、请求、回复表单、私聊、复制用法、接入 AI。**由服务器下发，热更新** |
| `packages/relay-app` | 桌面客户端外壳（Electron，固定不变）：读条、检查版本、下载界面、托盘、通知、记住密码、给本机 AI 用的身份 |
| `scripts/relay-release.mjs` | 生成发布目录 `release/relay/`，服务直接在这个目录里跑 |

## 发布与更新

```
npm run relay:release              # 界面 + 服务；界面更新就是重跑这一条，在线的客户端几秒内自己更新
npm run relay:release -- --shell   # 再加上桌面客户端的 zip（外壳有改动时才需要）
```

`release/relay/` 里有：

- `amo-relay.mjs`：服务、命令行、MCP 都在这一个文件里，需要 Node 22.13 或更新。
- `client/`：界面和 `manifest.json`。
- `downloads/AMO-Relay-win.zip`：桌面客户端。

服务每次请求都现读这些文件，所以更新界面不用重启服务；它每 5 秒检查一次 `manifest.json`，版本变了就推送给所有在线的客户端。客户端在不会丢东西的时候自己更新：窗口在托盘里或没有焦点，也没有正在写的内容。更新就是重新载入窗口，登录状态和打开的对话都保留。正在用的人会在左上角看到「有新版本」，可以点「立即更新」。只有改了服务本身（`packages/relay/src`）才要重启。改了外壳或 `shell-api.ts` 时，先把 `SHELL_VERSION` 加一，再带上 `--shell` 打包。比这个版本旧的外壳会在登录页提示「需要重新下载客户端」。

## 在这台 Windows 上跑服务

10-28 起团队用的服务在 Mac 上（下一节），本机这份 10-28 已经停了。脚本留着当退路：Mac 出问题时可以临时在本机起服务。

```
powershell -File scripts/relay-service.ps1 start|stop|restart|status [-Passphrase <邀请口令>] [-Name <服务名>]
```

数据在 `%APPDATA%\AMO Relay\server\relay.db`，上传的文件在同一目录的 `files` 下，日志也在这个目录。默认监听 `0.0.0.0:47120`，不设邀请口令，同一网络里谁都能注册。

## 在 Mac 上跑服务（团队用的这台，2026-10-28 起）

服务在团队的 Mac mini 上：`http://172.16.8.85:47120/`。在这台 Windows 上用 `scripts/relay-mac.mjs` 通过 SSH 管它（`~/.ssh/config` 里的别名 `mac`，换机器时设 `SSH_HOST`）：

```
npm run relay:release                 # 先在本机生成 release/relay
npm run relay:mac -- deploy           # 传到 Mac；只改了界面不重启，服务本身变了会先备份数据库再重启
npm run relay:mac -- status | start | stop | restart | logs [行数] | backup
npm run relay:mac -- passwd <名字> [新密码]          # 忘了密码：重设并打印新密码（不填就随机生成 8 位）
npm run relay:mac -- migrate --from <数据目录> [--force]   # 一次性把另一台的数据搬过来（先备份 Mac 上的）
```

Mac 上的位置：

- 程序 `~/Services/amo-relay/app`（每次 deploy 整个换掉）
- 数据 `~/Services/amo-relay/data`（relay.db、上传的文件、`backup-*.db`；deploy 不碰）
- 平台目录 `~/Services/amo-relay/platform`（AMO 平台的工具，见下一节；deploy 只保证它存在，plist 用 `--platform-dir` 传给服务）
- 开机自启 `~/Library/LaunchAgents/com.amo.relay.plist`（登录后启动，退出了自动拉起）
- 日志 `~/Library/Logs/AMO Relay/`

Mac 用的是 Homebrew 的 Node（需要 22.13 或更新），防火墙是关着的，也不会睡眠。重设密码后，这个人之前的登录会全部失效。

## AMO 平台的发布（2026-10-28 起）

中转服务顺带给 AMO 平台（`plans/amo-lan-platform.md`）提供工具的文件。服务只读一个平台目录，内容由本机的发布命令写：

```
platform/
  objects/<sha256 前两位>/<sha256>     文件内容，按 sha256 存，同一个文件只存一份
  tools/<tool>/<version>.json          一个工具一个版本的清单
  channels.json                        { "stable": { "studio": "0.9.0", … }, "test": { "studio": "0.9.1", … } }
  downloads/AMO-Platform-win.zip       平台自己的下载（可选）
```

- 平台目录用 `serve --platform-dir <目录>` 或环境变量 `AMO_RELAY_PLATFORM_DIR` 指定；没指定时下面三个接口返回 404 和一句说明。Mac 上是 `$ROOT/platform`。
- 清单：`{ tool, name, version, builtAt, exe, notes, files: [{ path, size, sha256 }] }`。`path` 用 `/` 分隔、相对程序文件夹；`exe` 是主程序（如 `AMO Studio.exe`）；`notes` 是这次的改动说明（Markdown）；`builtAt` 是打包时间（毫秒）。
- 工具 id 是小写字母开头的小写字母、数字和 `-`（`studio`、`reviewer`、`notes`、`platform`）；版本号像 `0.9.1` 或 `0.9.1-test.1`。

接口（都要登录，`Authorization: Bearer <key>`；objects 也接受 `?key=`，方便直接下载）：

| | |
|---|---|
| `GET /api/platform/channels` | `channels.json` 的内容；还没发布过时是 `{ "stable": {}, "test": {} }` |
| `GET /api/platform/tools/<tool>/<version>` | 这个版本的清单；没发布过是 404 |
| `GET /platform/objects/<sha256>` | 文件内容（`application/octet-stream`，可以长期缓存）；sha256 是 64 位小写十六进制 |

工具 id、版本号、sha256 不合格式时返回 400，不会去读磁盘；读到的文件一定在平台目录里面。下载页（`/`）在 `downloads/AMO-Platform-win.zip` 存在时（客户端的 `downloads/` 里，或者平台目录的 `downloads/` 里）显示「下载 AMO 平台」，这个 zip 不用登录就能下载。放在平台目录里更稳：deploy 换客户端 zip 时会整个换掉 `app/downloads`。

发布（在本机，通过 SSH，不开 HTTP 写接口）：

```
npm run package:portable -- --only notes               # 先打包：release/AMO Notes/
npm run relay:mac -- publish notes [--channel test|stable] [--notes "…"] [--release <目录>]
npm run relay:mac -- promote notes 0.9.1               # 把稳定通道指向一个已经发布过的版本
npm run relay:mac -- platform-status                   # 两个通道各工具的版本、发布过的版本、存了多少文件
```

- `publish`：版本号取工具自己的 `package.json`（Studio 是 `packages/app`），读 `release/<Name>/`，算每个文件的 sha256，先问服务器缺哪些，只把缺的用 tar 经 SSH 传过去（到了那边按 sha256 校验后再放进 `objects/`），再写清单，最后改通道。不写 `--channel` 时发到测试通道。`--notes` 不给时取该工具 `CHANGELOG.md` 里这个版本那一节（`## 0.9.1（2026-10-29）`）。打包的版本和现在的版本号不一样时拒绝（先重新打包）；同一个版本号已经发布过：文件相同就只改通道，文件不同就拒绝（先升版本号）。
- 稳定通道不会比测试通道旧：发到稳定或 `promote` 时，如果测试通道的版本更旧（或没有），测试通道也指过去。
- 清单和 `channels.json` 都先写临时文件再改名，平台不会读到写了一半的文件，也不会读到文件还没传完的清单。
- 三个命令都可以加 `--target-dir <本机目录>`：不走 SSH，直接发布到这个目录。用来测试，也可以在本机起一个带平台目录的服务做联调：`node release/relay/amo-relay.mjs serve --port 47130 --data <临时目录> --platform-dir <同一个目录>`。
- 核心逻辑在 `scripts/platform-publish.mjs`（测试 `scripts/platform-publish.test.mjs`），工具表在 `scripts/amo-tools.mjs`。

## 给同事用

把 `http://<服务机器的 IP>:47120/` 发给他们。这个页面上有：

- **下载 Windows 客户端**：解压后双击 `AMO Relay.exe`，第一次打开时填服务器地址，然后注册。客户端会记住账号和密码（用系统加密保存），关掉窗口后留在托盘里，来新消息会提醒。服务器连不上时，登录页和对话上方会显示离线和下次重试的时间，服务恢复后会自己连上。
- **直接在浏览器里用**：不用安装，但没有记住密码、托盘提醒和接入 AI。

## 接入 AI（MCP）

在客户端里点「接入 AI」，会给出 Claude Code、Codex 和通用 JSON 三种配置，都能一键复制。MCP 用客户端自带的运行时启动（`ELECTRON_RUN_AS_NODE=1`），本机不用装 Node，身份就是客户端当前登录的账号。

不支持 MCP 的 agent：在客户端里点「复制用法」，会复制一段说明，里面带着命令行 `%APPDATA%\AMO Relay\amo-relay.cmd` 的用法。

MCP 提供这几个工具：

- `relay_people`：能找的人
- `relay_session_open`：发会话
- `relay_session_wait`：等对方返回
- `relay_session_get`：取会话（含逐条回答）
- `relay_session_reply`：继续追问（`then: "ask"`）、标记完成（`then: "done"`）或补充
- `relay_session_handoff`：交给本人
- `relay_queue`：待我这边处理的会话
- `relay_task_list` / `relay_task_get` / `relay_task_create` / `relay_task_update` / `relay_task_transfer`：团队任务
- `relay_file_put` / `relay_file_get`：传文件到任务或会话、读文件和它的批注

阶段 1 的旧名（`relay_ask`、`relay_replies`、`relay_wait`、`relay_send`）还能用。

**会话的规则**：会话在谁手里就由谁处理。AI 发出的会话一定要回复，收到的人不能直接标记完成，只有发起方（人或者他的 AI）能标记完成。发起人的 AI 取过返回的会话后，界面上会显示「AI 已取回」；回复到了 10 分钟 AI 还没取，或者取回后 30 分钟没有动作，发起人的待处理里会高亮，可以「复制取回指令」或者「我来处理」。本人接手后，AI 再操作这个会话会被拒绝，直到本人点「交还给 AI」。

工具的说明、「复制用法」的内容和 `amo-relay prompt` 打印的内容，都由同一处生成（`src/usage.ts`）。

## 命令行

```
amo-relay serve | passwd | register | login | whoami | people | prompt | mcp | ask --json <file|-> | replies [id] | wait <id>
          | send <id> --body … [--then ask|done] | queue | handoff <id> --note …
```

## 接口

除了 `/api/health`、`/api/register`、`/api/login` 和静态文件，其余接口都要带 `Authorization: Bearer <key>`。

| | |
|---|---|
| `GET /` | 下载页（发给同事的链接） |
| `GET /app/` | 浏览器版客户端 |
| `GET /client/*` | 客户端界面和 `manifest.json`（桌面客户端热更新用） |
| `GET /downloads/*` | 桌面客户端 zip |
| `GET /api/health` | 服务名、版本、注册是否要邀请口令、客户端版本、桌面程序构建（`shell`，给「更新桌面程序」用） |
| `POST /api/register` `{name, password, role, passphrase}` | 注册并登录，返回 `{key}` |
| `POST /api/login` `{name, password}` | 登录，每台设备拿一个 key |
| `POST /api/logout` | 当前 key 失效 |
| `GET/PATCH /api/me` | 我是谁，改「负责什么」 |
| `GET /api/members` | 所有人，带是否在线 |
| `GET/POST /api/tasks`，`GET/PATCH /api/tasks/:id` | 团队任务（列表带 `unseen`），新建、看（带记录）、改标题/说明/状态 |
| `POST /api/tasks/:id/transfer` `{to, status, reason, threadId?, closeSession?}` | 流转；带 `threadId` 时同时回复或结束那个会话 |
| `POST /api/tasks/:id/archive` `{archived}`、`/seen` | 归档（只限已完成、已搁置）、看过交给我的任务 |
| `GET/PUT /api/settings` | 团队设置：流程、流程速查的说法、AI 提醒时间 |
| `POST /api/files?task=…` 或 `?thread=…&name=…` | 上传（请求体就是文件内容，最多 20 MB），同名是新版本 |
| `GET /api/files?task=…`、`/api/files/:id`、`/versions`、`/notes` | 文件列表、内容（`?download=1` 下载）、版本、批注 |
| `POST /api/files/:id/notes` `{quote, prefix, suffix, body}`、`DELETE /api/notes/:id` | 写批注、删自己的批注 |
| `GET /api/threads` | 我参与的对话，带未读数和最后一条消息 |
| `POST /api/threads/direct` `{with}` | 打开和某人的普通聊天，没有就新建 |
| `POST /api/threads/topic` `{with, title}` | 和某人新开一个话题 |
| `POST /api/threads/:id/archive` `{archived}` | 在我自己的列表里归档或放回；普通聊天不能归档，有新消息会自动放回 |
| `POST /api/requests` `{to, title, body, questions, needsReply, via}` | 发会话，单独开一个对话 |
| `POST /api/threads/:id/session` `{action, note, via}` | `done` 标记完成 / `reopen` 重新打开 / `handle` 我来处理 / `toAi` 交还给 AI / `handoff` AI 交给本人 |
| `GET /api/threads/:id/messages?after=&via=ai` | 读消息；`via=ai` 表示发起方的 AI 在取，返回的会话记为「AI 已取回」 |
| `POST /api/threads/:id/messages` `{kind: text\|reply, body, answers, verdict, pass}` | 发消息或回复；回复会把会话还给发起方，`pass` 让一条普通消息也换手（继续追问） |
| `POST /api/threads/:id/read` `{seq}` | 标记已读 |
| `GET /api/wait?thread=&after=&timeout=` | 等对方的新消息，最多 10 分钟 |
| `WS /ws?key=` | 推送 `hello` / `message` / `thread` / `archived` / `members` / `read` / `client` / `tick` |

## 测试

- 单测：`npx vitest run packages/relay packages/relay-app scripts`（`scripts` 是平台的发布）
- e2e：`npm run relay:release && npx playwright test -c e2e/playwright.config.ts --project relay`

e2e 会启动两个客户端，依次跑：注册、AI 用命令行发会话、对方逐条回复并返回、AI 取回、本人接手后 AI 被拒、标记完成、私聊和话题、归档、两种自动更新、服务断开又恢复、深色主题；截图存在 `screenshots/relay/`。发布前可以先 `node scripts/relay-release.mjs --out <临时目录>`，再用 `AMO_RELAY_E2E_RELEASE=<临时目录>` 跑 e2e，通过后再发布到正在运行的服务。
