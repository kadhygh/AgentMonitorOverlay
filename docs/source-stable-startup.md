# AMO Source Stable 启动与桌面脚本 SOP

适用于希望直接使用源码仓库、但不需要 Tauri 自动重编译 watcher 的 Windows 用户。

## 模式选择

| 模式 | 命令 | 用途 |
| --- | --- | --- |
| Stable | `npm run amo` 或 `.\amo.ps1 -Mode Stable` | 默认日常使用；不会因 Git 或源码读取重启原生窗口 |
| Source | `npm run amo:source` 或 `.\amo.ps1 -Mode Source` | 开发 Rust/Tauri；启用 `tauri dev` watcher |
| Source Debug | `npm run amo:debug` | 显示 Broker/Overlay 调试控制台 |
| Portable | `npm run amo:portable` | 构建并运行打包版本；始终无源码 watcher |

Stable 仍然保证运行产物与当前源码一致，但不会无条件重复构建。入口会为前端、Tauri 源码、依赖清单和构建配置计算 SHA-256 指纹：输入变化或 `dist/index.html`/原生程序缺失时，先运行前端类型检查/生产构建，再执行锁定的 Rust debug 构建；输入与上一次已成功启动的指纹一致时，直接复用已验证产物。运行阶段由 Broker、Vite Preview（只提供已构建的生产 bundle）和已生成的 `agent-monitor-overlay.exe` 组成，不会启动 Vite 开发转换管线或 `tauri dev` watcher。

## 首次部署

前置条件：

- Windows 10/11 x64；
- Git；
- Node.js 18 或更新版本；
- Rust stable MSVC toolchain；
- Visual Studio C++ Build Tools；
- Microsoft Edge WebView2 Runtime。

从仓库根目录执行：

```powershell
git pull --ff-only
cd overlay
npm ci
cd ..
.\amo.ps1 -Mode Stable
```

首次 Rust 构建会下载并编译依赖，后续源码变化时复用 `overlay\src-tauri\target\debug` 增量缓存；源码未变化时跳过前端/Rust 构建。成功完成原生启动和健康检查后，验证指纹写入 `overlay\src-tauri\target\.amo-stable-build-fingerprint`。构建或启动失败不会把新指纹标记为有效，并继续保留事务式旧二进制恢复。

## 安装桌面启动脚本

从仓库根目录执行：

```powershell
powershell -NoProfile `
  -File .\scripts\amo\install-source-launcher.ps1
```

脚本会在 Windows 当前用户的实际桌面目录中创建或更新一个可直接审计的文本启动器（也兼容重定向到其他盘符的桌面）：

```text
<Windows Desktop>\AMO Stable.cmd
```

启动器调用当前仓库的 Stable 入口。它是可直接审计的 CMD，使用明确的 `NoProfile` 和 `ExecutionPolicy Bypass` 参数，失败时保留控制台输出。仓库移动后需要在新路径重新运行安装脚本。

指定其他启动器路径：

```powershell
.\scripts\amo\install-source-launcher.ps1 `
  -LauncherPath "D:\Tools\AMO Stable.cmd"
```

需要与开发时的 Source watcher 完全一致时，安装 Source 启动器：

```powershell
.\scripts\amo\install-source-launcher.ps1 -Mode Source
```

它会创建 `<Windows Desktop>\AMO Source.cmd`，固定调用安装脚本所在仓库的 `amo.ps1 -Mode Source -SkipDependencyInstall`。机器级 `%LOCALAPPDATA%\AgentMonitorOverlay\launcher.json` 可以设置唯一的 `sourceRoot`；从其他 Codex worktree 误调用 Source 模式时，入口会自动委托给该规范仓库，避免产生第二份 Broker registry、sessions 和 launches。

Stable 组件日志：

```text
<repo>\tmp\amo-broker.out.log
<repo>\tmp\amo-broker.err.log
<repo>\tmp\amo-stable-vite.out.log
<repo>\tmp\amo-stable-vite.err.log
<repo>\tmp\amo-stable-app.out.log
<repo>\tmp\amo-stable-app.err.log
```

## 日常更新

关闭正在运行的 AMO，然后在仓库根目录执行：

```powershell
git status --short
git pull --ff-only
cd overlay
npm ci
cd ..
```

桌面启动脚本不需要重建；下次点击会检测源码指纹，必要时构建并运行新源码。只有仓库路径发生变化时才需要重新安装。

## 故障排查

如果桌面启动脚本没有显示 AMO：

1. 查看启动器保留的控制台错误；
2. 检查 `tmp\amo-stable-vite.err.log` 和 `tmp\amo-stable-app.err.log`；
3. 确认端口 `1420` 和 `17654` 没有被其他程序占用；
4. 在仓库根目录运行 `.\amo.ps1 -Mode Stable -DebugMode`；
5. 缺少前端依赖时在 `overlay` 目录重新运行 `npm ci`。

Stable 模式不会监听 Rust/配置文件变化。修改 `overlay\src-tauri` 后重新运行 Stable；需要连续自动重编译时才使用 `npm run amo:source`。

## 卸载桌面启动脚本

关闭 AMO，然后删除：

```text
<Windows Desktop>\AMO Stable.cmd
```

这不会删除源码仓库、Broker 数据、WebView2 设置或 Windows Credential Manager 中的模型凭据。
