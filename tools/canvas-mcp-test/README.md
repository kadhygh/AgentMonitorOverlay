# Canvas MCP 生图测试台

本地网页，通过官方 MCP TypeScript SDK 的 SSE transport 连接 `https://canvas.dxx.cn/api/mcp/sse`。独立于 AgentMonitorOverlay 主程序。

## 启动

需要 Node.js 20 或更新版本。在本目录运行：

```powershell
npm install
npm start
```

然后打开 http://127.0.0.1:4318 。默认端口被占用时可在 PowerShell 设置 `$env:CANVAS_TEST_PORT = '4319'` 后启动。

## 使用

1. 在网页填写 **MCP 服务密钥**。不是自动要求 OpenAI API key；具体凭证由服务方提供。
2. Authorization 默认原样发送。如服务明确要求 Bearer，可以选择“Bearer + 密钥”或填写完整值，已有前缀不会重复添加。配置示例中的 `mcpkey` 通常是占位符，需替换为真实密钥。
3. 点击“连接并读取工具”，选择实际生图工具。网页根据 inputSchema 填入初始 JSON；检查必填参数和工具说明，复杂联合类型需手动填写。
4. 点击“执行所选工具”。图片内容、常见 URL 和 `b64_json` 将尝试预览，完整结果保留在“原始返回”。普通网页链接可能无法作为图片预览，可手动打开。
5. 若返回任务 ID，使用服务提供的查询工具继续查询；不会猜测查询工具或自动重复提交生图任务。
6. 使用“断开并清除密钥”释放连接。关闭页面时尽力断开，异常退出的连接在空闲 30 分钟后回收。

## 行为与限制

- 密钥仅在页面输入框及本地进程内存中临时存在；连接成功后清空输入框。不写日志、文件或 localStorage/sessionStorage。
- 本地服务仅监听 127.0.0.1，并校验 Host/Origin。固定上游地址；不允许携带 Authorization 跟随重定向或发送到不同 origin。
- SSE GET 和消息 POST 均携带 Authorization；执行请求最长等待 10 分钟。超时不代表上游任务已取消。
- 连接失败时显示准确 HTTP 状态、GET/POST 阶段及 JSON 错误中的 code/message（密钥脱敏），不会把 401 和 403 合并。不会返回请求头或 HTML 错误页。
- 生图调用由用户点击触发，可能消耗上游额度。MCP 配置里的 autoApprove 是宿主设置，不是 SSE 请求参数。
- 这是本地测试程序，不需要配置 OpenAI key 或改变 CLI route。实际工具名称、参数、额度和图片格式由 MCP 服务决定。
- 新版 Streamable HTTP 不在此测试页范围；当前按提供的 `/sse` 地址使用旧版 HTTP+SSE。
- 图片链接直接由浏览器加载，不附带 MCP 密钥；如图片本身需要鉴权，预览可能失败。原始返回仍可用于排查。
- 可选 WebMCP 功能只允许暂存参数，用户仍需手动执行。无支持环境时自动忽略。

## 验证

`npm test` 使用本地模拟 MCP 服务验证 SSE 初始化、双通道密钥、工具分页、图片内容、工具错误、无效密钥、网页访问和跨站防护；不消耗真实服务额度。真实生图需填写有效密钥后测试。

协议参考：https://modelcontextprotocol.io/specification/2024-11-05/basic/transports
