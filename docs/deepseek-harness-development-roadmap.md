# DeepSeek Harness 测试开发路线

> 记录日期：2026-08-14
> 当前策略：将 DeepSeek Harness 视为快速演进的独立实验运行时，先验证产品和部署，再逐步开发插件；早期不与 AMO Task Card 建立强耦合。

## 背景与判断

DeepSeek Harness 当前仍处于 Developer Preview / RC 阶段，接口、插件结构和 Web Client 都可能快速变化。与此同时，它的 Cordis 插件架构、持久化 Session、Web UI、Headless 与 Host API 暴露了很大的扩展空间，后续很可能演化出比“兼容 Codex Hook”更适合 AMO 的新架构。

因此，AMO 不在第一阶段直接绑定 Harness 内部事件或 Session API。第一阶段先提供一个独立的 Harness Lab，让 Harness 能够稳定安装、启动、观察和使用；确认真实使用体验后，再决定插件和 Card 集成边界。

## 总体原则

1. **安装和运行分离**：`npm install` 只用于首次安装、修复或版本升级；日常启动只运行已经安装的 `dsh web`。
2. **独立演进**：Harness Lab 使用独立运行目录、`DSH_HOME`、端口、日志和状态，不改动现有 Codex/Claude/Card 链路。
3. **固定基线、显式升级**：Developer Preview 阶段以精确 npm 版本作为安装基线，不使用无版本约束的 `npx` 启动；远端版本只在用户主动检查时查询，只在用户明确点击更新时升级。
4. **凭据不落日志**：复用 AMO 存在 Windows Credential Manager 中的 DeepSeek/GLM Key，只通过子进程环境传入，不写命令行、项目文件或日志。
5. **先观察后抽象**：先用 Harness 原生 Web UI 选择工作目录和创建任务；稳定后才设计 AMO 插件协议和 Card 映射。
6. **只监听不代替授权**：未来的 AMO 插件可以显示 Harness 授权状态，但不自动批准危险操作。

## 阶段 0：调查与版本钉住（已完成）

- 确认产品形态是 `dsh` CLI 启动器、本地 Web 服务和浏览器 UI，不是 Electron/Tauri 桌面应用。
- 确认 Web、Headless、Host API、ACP、JSON-RPC、Python SDK 等入口。
- 确认官方 Codex/Claude Hook Bridge 仅为部分兼容层。
- 确认正式 Card 集成应优先考虑 Cordis 原生事件和持久化 `session/event`。
- 当前实验版本固定为 `@deepseek-ai/dsh@0.1.0-rc.6`；升级必须经过单独验证。

## 阶段 1：Harness Lab 独立运行面板（当前版本）

### UI 入口

- 在 AMO 主窗口 **Open Settings 左侧**增加 Harness Lab 按钮。
- 点击后打开独立的 **DeepSeek Harness Lab** 工具窗口。
- 该窗口与 Settings、Workspace Center 一样使用 AMO 的独立工具窗口管理，不占用 Task Card 区域。

### 面板能力

- 显示固定的 Harness 版本、安装路径、`DSH_HOME`、服务 URL 和 PID。
- 检测内置/受管 Node 是否可用。
- 检测 Harness 是否已经安装。
- 提供一次性的 **Install / Repair test runtime**。
- 首次安装使用固定基线版本；Repair 修复当前本地版本，不会把已经显式升级的版本自动降回基线。
- 显示当前本地运行时版本；按需查询 npm registry 上发布的远端版本，并提示是否有更新。
- 提供显式的一键更新；更新前要求停止 Harness，只更新 AMO 独立受管 runtime，不修改全局 npm 包。
- 启动 `dsh web` 后台服务。
- 停止由当前 AMO 实例启动的服务。
- 轮询并展示 `Stopped / Starting / Running / Port conflict / Error` 状态。
- 展示最近的 stdout/stderr/install 日志，不显示凭据。
- 一键在系统浏览器打开 Harness Web UI。

### 凭据和模型

- 启动时从 Windows Credential Manager 读取 AMO 已保存的 DeepSeek Key，并通过 `DEEPSEEK_API_KEY` 注入子进程。
- 如果 AMO 已保存 GLM Key，通过独立环境变量注入 Harness。
- 在全新的受管 `DSH_HOME/settings.yaml` 中初始化一个 GLM 自定义 Provider：
  - Provider ID：`amo-glm`
  - 协议：`anthropic-messages`
  - Base URL：`https://open.bigmodel.cn/api/anthropic`
  - Model：`glm-5.2[1m]`
- 不覆盖用户已经存在的 `llm-pi-ai` 配置；发生配置冲突时保留用户配置，并在面板提示改用 Harness 的 Models 页面手动添加。
- DeepSeek 和 GLM Key 均不写入 `settings.yaml` 或 Harness 日志。

### 第一阶段验收标准

- Harness Lab 能明确区分未安装、已停止、运行中和端口冲突。
- 首次安装完成后，后续启停不再执行 `npm install`。
- AMO 重开后仍能识别已经运行的 Harness 服务。
- 点击 Open Web 能打开 `http://127.0.0.1:3080`。
- Harness Web UI 能添加工作目录、创建多个任务并使用 DeepSeek 模型。
- 已配置 GLM Key 时，模型选择器能看到并调用 GLM；未配置时给出清楚提示。
- Harness 崩溃时状态和日志能反映真实情况，不影响 AMO Broker 和现有 Card。

## 阶段 2：真实使用验证与运行时固化

在开发插件前，先持续验证以下行为：

- Windows 下长时间运行、休眠唤醒和网络切换。
- 多工作区、多 Session、任务取消、授权、上下文压缩和恢复。
- DeepSeek V4 Pro、V4 Flash 与 GLM-5.2 的实际兼容性。
- Harness 升级后的配置迁移和 Session 恢复。
- 端口占用、异常退出、孤儿进程和日志滚动。
- Portable 包内预装 Node + Harness 后的离线启动。

这一阶段完成后，把构建机上已安装并验证的 Harness 运行时打入 Portable。用户机器不再依赖系统 Node、npm、PATH 或在线 registry。

## 阶段 3：AMO 原生 Cordis Bridge 插件

确认 Harness 的扩展面相对稳定后，再开发独立包 `@amo/dsh-bridge`：

- 监听 `session/event`、`agent/status`、工具流水线和授权事件。
- 将事件转换成版本化的 AMO Broker 协议。
- 从 `assistant/message` 获取完整最终回复。
- 从 `approval/request` / `approval/asked` 显示等待授权，但调用 `next()` 把决定交给 Harness UI。
- 对 Harness 版本做严格兼容检查；不兼容时禁用插件并保留原生 Web 使用能力。
- 不把现有 Codex/Claude Hook Bridge 当作正式主链路。

## 阶段 4：精确 Session 跳转

开发一个很小的 Harness Web Client 插件：

- 支持 `?amo-session=<sessionId>`。
- 根据 URL 参数调用 Harness Client Session API 切换到对应任务。
- 保留普通 `http://127.0.0.1:3080` 首页行为。
- 验证冷 Session、已归档 Session、无效 Session ID 和服务重启后的处理。

## 阶段 5：Task Card 只读联动

先做低风险、只读型集成：

- Harness Session 创建后生成 AMO Card。
- 同步 Running、Idle、Waiting Permission、Completed、Failed、Cancelled。
- Card 保存 `sessionId`、Workspace 和 Harness 实例 ID。
- Harness 按钮精确打开对应 Session。
- Note/Canvas 可以读取最终回复或任务摘要。
- VS Code 按钮继续按 Workspace 打开工程。

这一阶段不从 AMO 发送 Prompt，不执行授权，不改变 Harness Session。

## 阶段 6：双向任务管理

只在 Host API 和插件协议稳定后考虑：

- 从 AMO 创建 Session、选择 Workspace 和模型。
- 发送 Prompt、Cancel、Resume、Rename、Archive、Fork。
- 进程重启后恢复 `Card ↔ sessionId` 映射。
- 增加明确的权限边界、操作确认和失败回滚。

## 暂不实施的内容

- 不在第一阶段把 Harness Session 自动转成 Card。
- 不直接依赖未版本化的内部 Web API。
- 不把 Harness 端口暴露到 `0.0.0.0`、局域网或公网。
- 不自动审批 Harness 的权限请求。
- 不用 UI 自动化或修改浏览器 localStorage 模拟任务跳转。
- 不在每次 AMO 或任务启动时运行 `npm install`。

## 升级门禁

每次升级 Harness 固定版本前，至少验证：

1. 安装和 `dsh web` 启动。
2. 首页识别标记和服务健康检查。
3. DeepSeek/GLM 凭据解析。
4. Workspace 添加、Session 创建和恢复。
5. Windows 工具执行与授权。
6. 旧 `DSH_HOME` 和 Session 日志兼容性。
7. 如果已进入阶段 3，Cordis Bridge 合约测试和 Session Deep Link 测试。
