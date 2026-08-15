# DeepSeek Harness 全局安装与监控路线

## 产品边界

DeepSeek Harness 是与 Codex CLI、Claude CLI 同级的独立本机工具。AMO 不分发私有 Harness runtime，不拥有 Harness 进程，不维护 Harness 模型、Provider 或凭据，也不为 Harness 设置私有 `DSH_HOME`。Harness 自己管理 Web UI、模型路由、密钥、会话、Profile、Bundle 与 Agent Preset。

Harness Lab 是机器级安装与状态中心，负责全局安装、远程版本检查、显式更新、本机 Web 健康检查、用户触发的 Web 启停及安装路径诊断。Start Web 只从已验证的全局 package root 启动 Web，Stop Web 只终止命令行与监听端口都验证为当前全局 DSH 的进程；AMO 不持有子进程句柄，也不在退出时停止 DSH。Task Card 集成不属于当前阶段；未来直接通过正式的 Harness 原生 Bundle 实现，不交付 shell-hook 原型。

## 当前阶段

### 移除旧托管

- 删除 AMO 私有 `@deepseek-ai/dsh` runtime 的安装、修复和更新路径。
- 删除 AMO 启动、停止和退出时终止 Harness 子进程的行为。
- 删除 `DEEPSEEK_API_KEY`、`AMO_GLM_API_KEY` 对 Harness 子进程的注入。
- 删除 AMO 初始化或升级 Harness `settings.yaml` Provider 的行为。
- 删除 Harness Lab 中的模型、密钥、Repair 和私有 runtime 启停控件；全局部署只提供明确命名的 Start Web 与 Stop Web。
- Portable 发行物只为 AMO Broker 携带 Node.js，不携带 npm 或 Harness runtime。

旧的开发期 `tmp/deepseek-harness-lab` 数据不再是运行输入。清理前必须确认端口 3080 的旧受管进程已停止，并验证待删除的绝对路径仍位于准确的旧数据根下。

### 全局安装

Harness Lab 通过系统 npm 安装明确版本：

```powershell
npm install --global @deepseek-ai/dsh@0.1.0-rc.6 --no-audit --no-fund
```

安装器不使用浮动包 spec，不修改 npm global prefix，不自动启动 Harness，也不创建模型配置。用户可以在安装后显式选择 Start Web。面板显示系统 Node、npm 与 pnpm 版本；pnpm 缺失不会阻止 Web 运行，但会提示外部 Bundle 管理不可用。

### 远程版本与更新

远程检查通过系统 npm 查询发布版本：

```powershell
npm view @deepseek-ai/dsh version
```

版本使用语义化版本规则比较，正确处理 `rc.9` 与 `rc.10`。安装状态区分推荐版本、已安装版本和 registry 版本。更新操作先解析并校验 registry 返回的版本，再把该明确版本传给全局 npm 安装；不把 `latest` 作为安装参数。运行中的本机 3080 服务必须由用户在 AMO 外停止后才能更新。

### 本机状态

Harness Lab 分别显示：

- 全局 DSH 命令及发现到的全部同名命令路径；
- npm global root 与 `@deepseek-ai/dsh` package root；
- `DSH_HOME`（环境变量优先，否则为 `%USERPROFILE%\.dsh`）；
- Node、npm、pnpm 版本；
- 3080 监听 PID；
- DSH Web 健康、端口冲突和部分安装状态；
- 最近一次全局 npm 安装或更新日志。

AMO 探测外部服务并提供显式 Web 启停入口。Start Web 启动脱离 AMO 生命周期的全局进程；Stop Web 在终止前验证监听 PID 的完整命令行必须指向当前 npm global root 下的 `@deepseek-ai/dsh/lib/bin.js web --port 3080`。端口冲突、命令行不可读或 package root 不匹配时拒绝终止。AMO 关闭时不终止 DSH，DSH 停止时也不影响 AMO。

## 运行方式

用户在任意终端独立启动 Harness：

```powershell
dsh web --host 127.0.0.1 --port 3080
```

Harness Lab 提供 Start Web、Stop Web 与 Open Web，分别对应显式启动、验证后停止和打开本机页面。它不提供长期进程托管、崩溃重启或开机自启；这些职责属于用户的终端、任务计划程序或其他独立服务管理器。

## 插件与模型

Agent Preset 存放在 `$DSH_HOME/.agent-presets/<id>`。外部 Bundle 使用 Harness 自己的 Profile 命令管理：

```powershell
dsh plugin --profile web add <package>@<version> --save-exact
```

Harness Lab 不安装、更新或删除 Preset/Bundle，不读取 `.credentials.yaml`，也不展示明文凭据。未来可以增加只读的插件兼容性与 Provider/Model 名称健康检查，但必须通过 Harness 的脱敏接口获得数据。

## Future：原生 Task Card Bundle

Task Card 集成延后到全局安装与状态模型稳定以后。正式实现是可由 `dsh plugin` 安装的 AMO Bundle，直接消费 Harness 类型化 session/telemetry 事件，并向 AMO Broker 发送版本化、去重、脱敏且非阻塞的事件。它不经过 Codex 或 Claude hook 方言，也不交付临时 shell-hook 适配层。

未来 Bundle 至少需要覆盖：

- session 创建、恢复、释放；
- turn 与 step 开始/结束；
- provider/model 路由；
- tool call/result；
- approval asked/decided；
- `ask_user_question` 的未决工具调用；
- agent error；
- 基于 `(session.id, event.seq)` 的接收端去重。

`turn/end` 表示一轮结束，不表示整个会话完成。正式适配必须显式发送 AMO state，不能依赖现有 hook 事件名字符串推断。

## 当前阶段验收

1. AMO 不再拥有私有 Harness runtime、home 或进程。
2. AMO 不再管理 Harness 模型和密钥。
3. 全局安装使用明确版本并在完成后重新探测命令与 package root。
4. 远程版本查询失败不影响本机安装与 Web 健康状态。
5. AMO 能区分未安装、已停止、运行中、端口冲突和部分安装。
6. AMO 更新或退出不停止 DSH；DSH 更新不覆盖 AMO。
7. Portable 发行物不携带 npm 或 Harness runtime。
8. 本阶段不创建 DSH Task Card，不安装 Hook 原型。
