# AMO 中转（amo-relay）

局域网里的小工具：人和人互相发消息，AI 会话也能发一条「请求」给某个人，对方逐条回答。聊天记录都存在中转服务上。计划见 `plans/relay.md`。

现在有：中转服务、命令行、MCP。托盘程序（收件箱、回复界面、复制用法）还在做。

## 打包成一个文件

```
npm run relay:bundle        # → release/relay/amo-relay.mjs，单文件，不需要 node_modules
```

需要 Node 22.13 或更新（用到 `node:sqlite`）。Windows 和 Mac 用的是同一个文件。

## 在 Mac 上跑中转服务

```sh
mkdir -p ~/amo-relay && cp amo-relay.mjs ~/amo-relay/
AMO_RELAY_PASSPHRASE='团队口令' node ~/amo-relay/amo-relay.mjs serve --name 策划组
# 默认监听 0.0.0.0:47120，数据在 ~/Library/Application Support/AMO Relay/server/relay.db
```

第一次跑时，macOS 会问是否允许 node 接受传入的网络连接，选允许。

开机自动运行可以用 launchd：把下面的内容存成 `~/Library/LaunchAgents/com.amo.relay.plist`，再执行 `launchctl load ~/Library/LaunchAgents/com.amo.relay.plist`。里面的 node 路径用 `which node` 查到的那个。

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
  <key>EnvironmentVariables</key><dict><key>AMO_RELAY_PASSPHRASE</key><string>团队口令</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/amo-relay.log</string>
</dict></plist>
```

## 每个人：加入

```
node amo-relay.mjs join --server <Mac 的 IP>:47120 --name 程序老李 --passphrase 团队口令 --role "程序 · 战斗"
```

身份保存在本机：Windows 是 `%APPDATA%\AMO Relay\settings.json`，Mac 是 `~/Library/Application Support/AMO Relay/settings.json`。本机所有 AI 客户端都用这个身份。

## 接到 AI 客户端（MCP）

- Claude Code：`claude mcp add amo-relay -- node <路径>/amo-relay.mjs mcp`
- Codex：在 `~/.codex/config.toml` 里加
  ```toml
  [mcp_servers.amo-relay]
  command = "node"
  args = ["<路径>/amo-relay.mjs", "mcp"]
  ```
- 不支持 MCP 的：`node amo-relay.mjs prompt` 会打印一段用法说明，里面有命令行的用法，整段贴给 agent。

MCP 工具有 `relay_people`、`relay_ask`、`relay_replies`、`relay_wait`、`relay_send`，用法说明会作为 MCP 的 instructions 交给 agent。这段说明和 `prompt` 打印的内容来自同一处（`src/usage.ts`）。

## 接口（给托盘程序和以后的界面）

都要带 `Authorization: Bearer <key>`，只有 `/api/health` 和 `/api/join` 例外。

| | |
|---|---|
| `GET /api/health` | 服务名、版本 |
| `POST /api/join` `{name, passphrase, role}` | 返回 `{key}`，只返回这一次 |
| `GET/PATCH /api/me` | 我是谁、改角色 |
| `GET /api/members` | 所有人，含是否在线 |
| `GET /api/threads` | 我所在的对话，带未读数和最后一条 |
| `POST /api/threads/direct` `{with}` | 和某人的私聊（没有就新建） |
| `POST /api/requests` `{to, title, body, questions, via}` | 发请求，单独开一个对话 |
| `GET /api/threads/:id/messages?after=` | 消息 |
| `POST /api/threads/:id/messages` `{kind: text\|reply, body, answers, verdict}` | 发消息、回复 |
| `POST /api/threads/:id/read` `{seq}` | 标记已读 |
| `GET /api/wait?thread=&after=&timeout=` | 等对方的新消息（最多 10 分钟） |
| `WS /ws?key=` | 推送 `message` / `members` / `read` |
