# AgentMonitorOverlay

本仓库现在是 **AMO Studio**：由人主导、agent 也能参与的项目推进工作台。看板管任务，画布看全局，每个任务下面是若干个和模型的会话（Codex、Claude、DeepSeek），在工作台里对话、审阅、批注。随 Studio 一起的还有独立的小程序 **AMO 便签**（`studio/packages/notes`）。

- 使用说明、安装、开发：[studio/README.md](studio/README.md)
- 给下一个开发会话的交接：[studio/HANDOFF.md](studio/HANDOFF.md)
- 愿景与架构：[docs/next-gen-vision-architecture-2026-10.md](docs/next-gen-vision-architecture-2026-10.md)

开发时在 `studio/` 下 `npm start`（便签单独启动是 `npm run notes`）；换一台机器用开发版，双击 `studio/start-studio.cmd`。

## 旧版 AMO

旧版（Tauri 悬浮窗 `overlay/` + Hook 后台 `broker/`）已于 2026-10-23 删除。代码在标签 `amo-legacy-final` 里还能找回（`git checkout amo-legacy-final`），旧的设计和任务记录在 [docs/archive-old-amo/](docs/archive-old-amo/)。

## 许可

[MIT](LICENSE)。第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
