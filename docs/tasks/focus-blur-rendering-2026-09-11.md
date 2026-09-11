# Focus 失焦后的原生边框碎片

2026-09-11。用户反馈：透明/穿透已经生效，但面板失去焦点后，标识和顶部按钮外围出现浅色矩形及奇怪图形。

## 原因与修复

已通过与生产相同的可缩放、透明、无标题栏 Tauri 窗口复现。生产和测试 HWND 的 style 都是 `14CF0000`：Tao 保留 Windows caption/resize frame 样式，通过 WM_NCCALCSIZE 隐藏边框。失焦时默认 WM_NCACTIVATE 处理仍绘制原生非客户区；该绘制被不连续的 SetWindowRgn 截成碎片，甚至能看见原生窗口标题文字。

仅在 Focus HWND 安装一个幂等 subclass。非最小化时，WM_NCACTIVATE 经 DefSubclassProc 向原调用链传递，只将 lParam 改为 -1。Microsoft 文档规定该值阻止默认非客户区重绘；继续经过 Tao，保留其 active/focus 状态维护。窗口销毁时移除 subclass；其他消息和所有窗口样式保持原样。

没有吞掉 WM_NCACTIVATE，没有直接绕过 Tao 调用 DefWindowProc，没有关闭透明、SetWindowRgn 或拖拽，也没有添加轮询重绘。实际证据表明无需额外拦截 WM_NCPAINT。

依据：[WM_NCACTIVATE 官方文档](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-ncactivate)。本地 Tao 0.35.2 的 window_state.rs / event_loop.rs 对应逻辑已核对。

## 验证

- 使用冻结的旧 Rust 模块编译 baseline probe，resizable=true 与生产一致；在两个独立测试进程之间实际切换焦点3轮，复现同类碎片。
- 同一测试配置换用修复后的生产 Rust 模块，实际切换焦点3轮，截图均无碎片。仅比较按钮外沿透明区域像素，旧版每轮变化1616 / 1508 / 1508像素，修复后为0 / 0 / 0。该比较不包含按钮自身的正常焦点外观。
- 非激活状态下显式请求 frame/client redraw 后仍显示正常。
- 原点击穿透/拖拽原生回归9项命中检查全部通过，包括实际跨进程点击计数、按钮操作、full 模式及实际HTML拖拽捕获/恢复。原生日志包含正常的 native-focus:true/false 事件。
- `cargo check --offline` 和3项 focus_input Rust测试通过。该修复仅改Rust模块，没有前端或 Broker 行为变更。
- 输入每次先检查WindowFromPoint/PID，只点击隔离测试进程；测试程序已关闭，生产数据没有操作。

产物均在开发 worktree 的 `tmp/native-input-probe/`：`blur-baseline/`、`blur-fixed/`、`blur-pixel-comparison.json`、`evidence.json` 和 `probe.log`。截图采用当前显示器100% DPI。

## 范围

生产原生窗口部署后仍需复核。跨DPI、系统级主题切换及最小化/恢复尚未作为本次结论；尤其Tao的系统主题更新有直接调用默认窗口过程的另一条路径，未在无证据情况下扩大改动。
