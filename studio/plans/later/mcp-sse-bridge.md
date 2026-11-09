# SSE 的 MCP 在 DeepSeek、Codex 会话里也能用（本地转接）

> 状态：以后推进（2026-11-09，这次只做了「带不上就跳过并在会话里说明」，转接等真有 DeepSeek 或 Codex 会话要用 SSE 服务时再做）

## 起因（2026-11-09）

有人用 `session_start` 拉起 DeepSeek 子会话，项目里开着一个 SSE 连接的 MCP（gorilla-canvas，`https://canvas.dxx.cn/api/mcp/sse`），DSH 回 `Invalid params: mcpServers[2] transport sse is not supported`，整个会话起不来。用户定：不应该要人去关项目里指定的 MCP，应该在会话这一侧处理。

## 已经做了的（A）

- DeepSeek：按 DSH 握手时声明的 `mcpCapabilities`（现在只有 http）过滤，带不上的不带，会话里加一行说明（同一个会话同样的内容只说一次）。DSH 以后支持 SSE 会自动带上。
- Codex：它的配置本来只收 stdio 和 HTTP，SSE 一直是悄悄跳过；现在新会话里也加一行说明。
- Claude 本身支持 SSE，不受影响。

## 以后要做的（B）

Studio 带一个本地转接：把 SSE 服务包装成一个本地程序（stdio），交给 DSH 和 Codex，让它们也能用。

- 要定的：用现成的（如 `mcp-remote`，要 npx 和网络）还是 Studio 自带一个小的 node 转接（Host 的 node 跑一个脚本，不依赖外网装包）；请求头里的密钥怎么交给转接进程（不进 agent 能读到的环境变量和设置文件，AGENTS.md 第 7 条的精神）；每个会话一个转接进程，会话结束时收掉。
- 也可以先看服务本身有没有 HTTP（streamable）地址：不少 SSE 服务同时开着 `/mcp`，能直接换地址就不用转接。
