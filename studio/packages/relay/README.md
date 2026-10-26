# AMO 中转（amo-relay）

局域网里的小工具：人和人互相发消息，AI 会话也能发一条「请求」给某个人，对方逐条回答。聊天记录都存在中转服务上。计划见 `plans/relay.md`。

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

```
powershell -File scripts/relay-service.ps1 start|stop|restart|status [-Passphrase <邀请口令>] [-Name <服务名>]
```

数据在 `%APPDATA%\AMO Relay\server\relay.db`，日志在同一个目录。默认监听 `0.0.0.0:47120`，不设邀请口令，同一网络里谁都能注册。

## 在 Mac 上跑服务

把整个 `release/relay/` 拷过去（下载页、客户端更新都从里面读）：

```sh
node ~/amo-relay/amo-relay.mjs serve --name 策划组 [--passphrase 邀请口令]
# 数据在 ~/Library/Application Support/AMO Relay/server/relay.db
```

第一次运行时 macOS 会问是否允许 node 接受传入连接，选允许。

要开机自动运行，用 launchd：把下面这段存成 `~/Library/LaunchAgents/com.amo.relay.plist`，然后 `launchctl load` 它。`node` 的路径用 `which node` 查到的。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.amo.relay</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/你/amo-relay/amo-relay.mjs</string>
    <string>serve</string><string>--name</string><string>策划组</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/amo-relay.log</string>
</dict></plist>
```

在服务那台机器上给某人重设密码：`node amo-relay.mjs passwd <名字> <新密码>`。他之前的登录会全部失效。

## 给同事用

把 `http://<服务机器的 IP>:47120/` 发给他们。这个页面上有：

- **下载 Windows 客户端**：解压后双击 `AMO Relay.exe`，第一次打开时填服务器地址，然后注册。客户端会记住账号和密码（用系统加密保存），关掉窗口后留在托盘里，来新消息会提醒。服务器连不上时，登录页和对话上方会显示离线和下次重试的时间，服务恢复后会自己连上。
- **直接在浏览器里用**：不用安装，但没有记住密码、托盘提醒和接入 AI。

## 接入 AI（MCP）

在客户端里点「接入 AI」，会给出 Claude Code、Codex 和通用 JSON 三种配置，都能一键复制。MCP 用客户端自带的运行时启动（`ELECTRON_RUN_AS_NODE=1`），本机不用装 Node，身份就是客户端当前登录的账号。

不支持 MCP 的 agent：在客户端里点「复制用法」，会复制一段说明，里面带着命令行 `%APPDATA%\AMO Relay\amo-relay.cmd` 的用法。

MCP 提供这几个工具：

- `relay_people`
- `relay_ask`
- `relay_replies`
- `relay_wait`
- `relay_send`

工具的说明、「复制用法」的内容和 `amo-relay prompt` 打印的内容，都由同一处生成（`src/usage.ts`）。

## 命令行

```
amo-relay serve | passwd | register | login | whoami | people | prompt | mcp | ask --json <file|-> | replies [id] | wait <id> | send <id> --body …
```

## 接口

除了 `/api/health`、`/api/register`、`/api/login` 和静态文件，其余接口都要带 `Authorization: Bearer <key>`。

| | |
|---|---|
| `GET /` | 下载页（发给同事的链接） |
| `GET /app/` | 浏览器版客户端 |
| `GET /client/*` | 客户端界面和 `manifest.json`（桌面客户端热更新用） |
| `GET /downloads/*` | 桌面客户端 zip |
| `GET /api/health` | 服务名、版本、注册是否要邀请口令、客户端版本 |
| `POST /api/register` `{name, password, role, passphrase}` | 注册并登录，返回 `{key}` |
| `POST /api/login` `{name, password}` | 登录，每台设备拿一个 key |
| `POST /api/logout` | 当前 key 失效 |
| `GET/PATCH /api/me` | 我是谁，改「负责什么」 |
| `GET /api/members` | 所有人，带是否在线 |
| `GET /api/threads` | 我参与的对话，带未读数和最后一条消息 |
| `POST /api/threads/direct` `{with}` | 打开和某人的私聊，没有就新建 |
| `POST /api/requests` `{to, title, body, questions, via}` | 发请求，单独开一个对话 |
| `GET /api/threads/:id/messages?after=` | 读消息 |
| `POST /api/threads/:id/messages` `{kind: text\|reply, body, answers, verdict}` | 发消息或回复 |
| `POST /api/threads/:id/read` `{seq}` | 标记已读 |
| `GET /api/wait?thread=&after=&timeout=` | 等对方的新消息，最多 10 分钟 |
| `WS /ws?key=` | 推送 `message` / `members` / `read` |

## 测试

- 单测：`npx vitest run packages/relay packages/relay-app`
- e2e：`npm run relay:release && npx playwright test -c e2e/playwright.config.ts --project relay`

e2e 会启动两个客户端，依次跑：注册、AI 用命令行发请求、对方逐条回复、私聊、热更新；截图存在 `screenshots/relay/`。
