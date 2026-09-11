# Focus：分组立即隐藏、反馈清理与点击穿透

2026-09-11。用户反馈：勾选“仅拖拽时显示”后仍可见、底部长期出现“分组已更新”、透明窗口挡住后方应用的点击。

实现提交 `7caeac7`，已在用户确认“重启”后连同记录 `c288833` 快进合入本地 master，并于 2026-09-11 17:42（香港时间）完成生产 Source 窗口与前端重启。Broker 保持原进程，数据没有修改；四项已有未提交文件哈希校验一致。未 push。

## 修复

- 旧复选框只修改本地草稿，必须另点“保存分组”。只读核对时生产三个组的 dragOnly 都是 false。现改为“仅拖拽时显示（立即保存）”；请求期间锁定并标记保存中，成功后立即采用已确认快照，失败显示错误并保留服务端真实状态，未知结果可精确重试。
- 名称编辑仍单独保存，按钮改为“保存名称”。可见性切换使用已保存名称，不会意外提交名称草稿；未提交的名称按精确 revision 保留。
- 删除移动卡片后的常驻成功提示“分组已更新”。保存进行中及错误反馈保留。
- 增加 Focus 专属 `set_focus_input_regions` 原生命令。普通状态只保留可见内容表面和滚动条的窗口区域，空白交给下方窗口。按钮、卡片和标识拖动区仍可响应。分组拖拽、窗口拖动/缩放及弹窗期间恢复完整输入区域，结束后恢复表面区域。
- 窗口原透明边框不再承担隐形 resize 命中；顶部增加明确的拖动缩放按钮。

## 边界与实现

前端通过可见 DOM 边界收集区域，裁剪到滚动容器和 viewport，并保留少量阴影/点击容错边距。MutationObserver、ResizeObserver、滚动/窗口尺寸事件触发更新，合并并去重相同 payload，没有全局鼠标轮询。浏览器预览没有原生 HWND，不启用该命令。

Windows 通过 [SetWindowRgn](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowrgn) 设置区域，既影响窗口绘制也影响命中。原生代码按真实 client extent 将 CSS 坐标缩放至物理坐标，并校正 client 相对完整 HWND 的原点。只允许 focus 窗口调用，限制512个矩形，验证数值和尺寸；HRGN 在成功后交 Windows 管理，失败时释放。错误和不完整布局退回完整窗口以保留控制入口。

这是表面区域级穿透，不是逐像素 alpha 命中。拖拽中需要接收投放，所以暂时不穿透。设置、详情或菜单打开时也恢复完整区域，避免误点下面的应用。整体视觉透明与点击穿透属于两件事；Windows 的 DirectComposition 透明本身并不使整个 client 区退出输入命中，见 [Microsoft 说明](https://learn.microsoft.com/en-us/archive/msdn-magazine/2014/june/windows-with-c-high-performance-window-layering-using-the-windows-composition-engine)。

## 已验证

- 前端完整运行时测试116/116通过；生产构建通过。
- Rust `cargo check --offline` 通过，`cargo test --offline --lib focus_input::tests` 3/3通过（缩放、原点、裁剪、非法几何）。没有修改 Cargo.toml/lock。
- 真实 UI + 临时 Broker smoke `tmp/focus-manual-smoke-kNlFEx/` 通过。覆盖勾选立即持久化、未保存名称不被顺带保存且草稿保留、拖拽隐藏/恢复、成功提示不存在，以及此前 Card/Review 流程。浏览器原生端口仍模拟。
- 隔离的实际 Windows probe 直接使用生产 `focus_input.rs` 与实际 `useFocusInputRegions`，覆盖在另一个进程的 WinForms 接收窗口上。9项 WindowFromPoint/PID检查通过：普通空白命中接收进程且实际点击计数增加；按钮命中 probe 并触发 React；full 模式接住空白；实际 HTML 拖拽开始后接住空白，成功 drop/drag-end 后恢复穿透。每次输入前先校验目标 PID，没有点击真实 CLI/Unity。两个测试进程已关闭。
- 原生 probe 证据：`tmp/native-input-probe/evidence.json`、`probe.log`、`receiver.log`、`idle-pass-through.png`、`during-native-drag.png`。验证范围为当前显示器100% DPI。

## 尚未验证

跨显示器、不同 DPI、与各实际 IDE/CLI/Unity 的长时间操作仍未完成。没有把勾选前未保存的生产组属性自动改为 true，需用户重新勾选预期的组。

## 生产检查

真实生产 Focus 窗口检查通过：普通空白点命中另一应用进程，设置按钮命中 AMO；打开设置后同一空白点命中 AMO，关闭后重新命中另一应用。设置内3个“仅拖拽时显示（立即保存）”控件存在，常驻“分组已更新”提示不存在。

证据在主目录 `tmp/focus-input-production-check.json`。当时原生 PID 120844，背景点的其他进程 PID 29000，仅记录命中归属，没有对背景实际点击，也没有提交分组配置。隔离 probe 已另行验证真实点击到达接收进程及真实拖拽期间的恢复行为。生产 Broker 启动时间仍为当日16:39:50（香港时间），没有被此次窗口重启替换。
