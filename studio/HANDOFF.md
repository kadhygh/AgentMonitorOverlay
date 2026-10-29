# 交接：AMO 的当前状态

新会话先读这份。长期有效的规则（工具和包的对应、架构约束、怎么干活）在仓库根目录的 `AGENTS.md`，这里只写现在的状态和最近的改动。做完一段，在「最近的改动」最上面加一条（做了什么、怎么验证的、还剩什么）。

更早的记录（10-13 到 10-25，原来这份文件的大部分）原样挪到了 `docs/history/handoff-2026-10.md`；做完的阶段计划在 `plans/done/`，/loop 自动迭代时期的文档（STATUS、NEEDS_YOU、ROADMAP、LOOP_RULES、LOOP_LOG）在 `docs/archive/`。查某个功能当初为什么这么做，先在这几处搜。

## 当前状态

### 在哪、怎么跑

| 项目 | 内容 |
|---|---|
| 开发目录 | `G:\PROJECT\AgentMonitorOverlay\studio`（桌面快捷方式「AMO Source」指这里的 `start-studio.cmd`） |
| 分支 | `master` 是主线；旧版 AMO 在标签 `amo-legacy-final` |
| worktree | `G:\PROJECT\AgentMonitorOverlay-review`（分支 `studio/stage3-topics`，已经都合进 master，没有未合并的提交） |
| 开发版 | `npm start`（先 build 再开窗口），数据在 `studio\.data`。Host 常驻在 47900 端口；改了 Host 代码要先 `npm run host:stop` 再 `npm start` |
| 帮用户重启开发版 | **先问用户，而且只在没有会话运行时做**。`npm run build` → `npm run host:stop` → 结束 `electron.exe packages/app` 主进程（命令行不含 `--type=`）→ 备份 `.data\studio.db*` 到 `.data\backup-before-<名字>-<日期>` → 在 PowerShell 里先删掉匹配 `^(CLAUDE|ANTHROPIC_|AMO_STUDIO_|NO_COLOR$|FORCE_COLOR$|COLOR$|TERM$)` 的环境变量（Claude Code 工具 shell 带的，Studio 会传给维护终端）→ `Start-Process node_modules\electron\dist\electron.exe packages/app`（工作目录 `studio`）→ 用 `.data/host-token` 在 node 脚本里查 `GET /api/state` 核对任务和会话数（不打印令牌）。只改界面时让用户按 Ctrl+R 即可 |
| 验证 | `npm run verify`（typecheck + vitest + build）；`npm run e2e`（Playwright project：`studio`、`notes`、`reviewer`、`relay`）。都用 BelowNormal 优先级、`--maxWorkers=6` |
| Portable | **不要每次都打包**，只在用户确认的发布节点打 |
| AMO 中转 | 服务在 Mac mini `http://172.16.8.85:47120/`（SSH 别名 `mac`）。发布：`npm run relay:release` 后 `npm run relay:mac -- deploy`，见 `packages/relay/README.md` |

### 规则补充（`AGENTS.md` 之外的细节）

- 不改 `~/.codex/config.toml`、`~/.claude/` 设置、用户已有的凭据条目（Studio 只写用户在 设置 → 模型 加渠道时的 `channel-<id>` / `channel-<id>-access`）。
- 测试只在 `%TEMP%\amo-studio-sandbox\` 和临时目录；端口只用 47900–47999；测试窗口不抢焦点、不开终端/浏览器、不碰剪贴板。
- 不 reset --hard、不删分支。密钥不打印、不写日志/文件/命令行。
- **真实模型额度**（`budget.json`，用 `spikes/lib.mjs` 的 `countTurn(note, provider)` 先计数再调用）：DeepSeek 45/1000、GLM 28/5000、GPT 订阅 6/50、Claude 订阅 0/50。平时测试用 mock。
- 工具坑：heredoc 里的 Python 会吃掉 `\n`、`\v` 等转义 → 有转义的改动用 Edit/Write 或 scratchpad 里的 `.py` 文件；Windows 文件名不分大小写（`Transcript.tsx` 和 `transcript.ts` 会撞）；跑完 e2e 用 `git checkout -- studio/screenshots/` 丢掉无意的截图变化；清理 `%TEMP%\amo-studio-test-*`、`amo-studio-e2e-*`。

### 还开着的事

| 事项 | 状态 |
|---|---|
| AMO 平台 | 方案 `plans/amo-lan-platform.md`，界面原型 https://claude.ai/artifact/Uu4fL3bXZg1NZHXDSKBPc9 。整理已做完；第一版（第 1、2 步）10-28 晚合进 master，见下面那条。下一步：部署到 Mac 并第一次真实发布（先问用户），然后第 3 步 |
| 远程会话（在我另一台设备上接着用本机会话） | 第 1–4 步和收尾 10-29 做完（`plans/remote-session.md`）；10-29 晚改成弹窗、加「安全」、B 能带图片和文件给 A（`plans/remote-page-and-new-task.md` 第 7、8 节，Studio 0.9.10）。等用户用两台真电脑验收；会话级授权、模型细到型号、HTML 的 CSS / JS、正文路径去用户名、远程权限上限，用户 10-29 定先不做 |
| 会话里直接用中转（回复自动回到会话） | 下一件，方案草稿 `plans/relay-in-sessions.md`。用户 10-29 晚：**开工前先和用户确认计划** |
| 便签进 Portable 包 | 到发布时再做 |
| 位置批注的截图 | 用户 10-28 决定先不做，用一段时间再定 |
| Studio 托盘 | 用户 10-29 定：× 只关窗口，托盘右键「完全退出」连 Host 一起关（有会话在跑先确认）；平台的 Studio 卡片显示后台状态、给「重启 Studio」（没有会话在跑才能点）。画布调整合并后做，见 `plans/remote-session.md`「前置」 |
| 扩展包 `.amo/packs/` 的实际用法 | 用户暂缓，做到时再说（`plans/maintenance.md`） |

### 已知问题

- `packages/host/src/runtime/codex/server-manager.test.ts` 的「停止并释放端口 / 崩溃后同端口重启」在完整并行跑时偶发失败（端口释放慢），单独跑通过。记录在 `plans/maintenance.md`，不是功能问题。
- 端到端里 Claude 的 mock 配置没法向 Claude Code 要型号列表（会超时），所以测试模式给 mock 配了内置列表（`packages/host/src/bin.ts`）。
- Studio 里 agent 的命令 PATH 去掉了 WindowsApps，用不到应用商店版的 `pwsh`、`python3`、`winget`（本机 `python`、`node`、`git` 不受影响）。

## 最近的改动（新的在上面）

**2026-10-29 夜 · 测试通道发 Studio 0.9.10、Reviewer 0.9.8、中转外壳 0.9.4、平台 0.9.9（正式通道没动）**

这一版合了下面几块（各自的记录在下面）和另一个会话的 `7a41f2e`（开会话的权限）：
- 远程（`7b8ae4f`）：顶栏「远程」改成弹窗，远程设置是叠在上面的二级弹窗（Esc 先关上面那层）。远程设置 → 安全（kv `remote.security`）：同账号的设备在这台电脑上建的任务直接开跑，别的账号默认先等确认——A 上变成一条带「那边选的项目 / 专题 / 模型」的请求（`RemoteTaskRequest.preset`），Focus 写「远程任务等你确认」，「同意…」里已经填好；B 的新任务页事先说明、按钮是「发给那边确认」。B 给 A 带图片和文件：新命令 `rt.upload` 分块（512 KB）先传，A 存成自己的附件（图片模型能看，DSH 改成文件；其他文件 `att-…-原名`，在消息末尾按 A 的路径重写「引用文件：」，行号和说明保留），每个 20 MB、一次 60 MB、不传文件夹；等确认的任务把文件留在请求上（`attached`），拒绝或撤回就删。「引用文件」那段的读写挪到 `protocol/src/fileRefs.ts`。用户定远程权限上限**先不动**。
- Focus（`cafb51a`）：按用户在 `out/html/focus-design.html` 里选的——A 版的整体样子（方角、顶栏 2px 线、衬线名字、「需要你」色块、提醒时静止的外框而不是呼吸光晕），每行前面 C 版的状态字（`focus/StatusWord.tsx`），B 版的卡片（左边色条）。Focus 不再显示额度（设置 → 额度 去掉 Focus 一栏，数据里的 `focus` 字段留着不用）。桌宠是 AMO 娘时：左上角图标 48 px（原 34）、Focus 里的她 92 px（原 72），窗口图标（任务栏）单独裁紧 1.22 倍（`make-icons.mjs` 的 `WINDOW_ZOOM`，界面和 Focus 里还是完整的她）。
- 画布侧栏（合并自 `worktree-agent-a1bc783d156d046b6`，`34521ce`）：画布右上角「侧栏」开关（和任务页同样子，记住）；侧栏左边缘拖宽度 260–560（默认 320，双击复位，记住），最后的页签也记住。页签只剩 整体待办 / 沟通 / 文档 / 书签 / agent 视角，一行细线下划线样式，「沟通」待确认数是角标，窄时换短名。「详情」页签去掉：选中卡片、分组或审阅条目，在它旁边浮出详情框（`CanvasDetail.tsx`，定位用 `geometry.ts` 的 `placeBeside`：右 → 左 → 下 → 上，选压住别的卡片最少的那边，不出画布区），平移、缩放时跟着走，拖卡片时先隐藏，不是模态；×、Esc（输入中第一下先退出编辑并保存）、单击空白关。**行为变化**：在空白处拖动只平移，不再取消选中。还剩：详情框较高时会压住旁边的卡片（审阅条目最明显），框里审阅状态按钮折成两行，等用户用一阵再看。
- 窗口标题栏、中转闪烁：见下面两条。合并后补了一处：中转在测试模式下不建托盘、不闪任务栏、不挂角标（全量 e2e 时用户看到任务栏和托盘冒出一排中转图标：`flashFrame` 会让 `skipTaskbar` 的窗口也出现在任务栏）。
- 验证：typecheck、build 过；全量 vitest 1044 条里 8 条失败，单独重跑都过（`server-manager` 端口、DSH 集成测试忙时超时、`peer.test.ts`）。全量 e2e 212 条 197 过；失败的 15 条：已知的 `cli.spec.ts:35`、`turn-start.spec.ts:74`、便签热键（真便签占着 Ctrl+Alt+Space）；6 条 studio 是关测试 Studio 时超时，单独重跑 7/7 过；中转 5 条重跑过；平台在机器忙时要把 expect 放宽到 20 秒、整条时限放宽才过，放宽后 8 条里 7 条过，剩 `platform.spec.ts:74` 的「完全退出 Studio」一步：测试装的是假的 Studio 0.9.0（比 `QUIT_SINCE` 的 0.9.8 旧），平台查进程时那个假 Studio 还在跑就会照规则拒绝发 `--amo-quit`——取决于时机，是上一版（`3373957`）加的规则和测试，这一版没改平台的 `platform.ts` / `system.ts`。**待修**：这条测试改用不旧于 0.9.8 的版本，或让假 Studio 不留进程；平台 e2e 的 5 秒等待在忙的机器上不够。
- 中转界面那一处（退出登录时数量报 0）没部署：要 `relay:release` + `relay:mac -- deploy`（会重启中转几秒），不部署也能用。
- 下一件：会话里直接用中转（`plans/relay-in-sessions.md`），**开工前先和用户确认计划**。

**2026-10-29 夜 · 中转有待处理 / 未读时任务栏和托盘闪、带数量（合并自 `worktree-agent-a16fcbe3a5bf7f734`，随中转外壳 0.9.4、平台 0.9.9 发测试通道）**

用户：「有待处理的 relay 信息时和未读聊天时，relay 的任务栏图标应该闪烁，托盘也闪，托盘最好还带上信息数量。如果是收起来的托盘则切成 relay 图标来闪，也显示信息数量。」
- 数量：界面原来就算好交给外壳（`relay-ui` Home：等我处理的会话 + 交来的任务 + 聊天未读，`relayShell.setUnread`），外壳以前只拿来改 tooltip。界面只加了一处：退出登录（Home 卸载）时报 0。
- 外壳（`relay-app/src/attention.ts`）：数量**变多**且窗口没人在看（不在前台 / 隐藏 / 最小化）时任务栏 `flashFrame`，一看就停；数量在就有任务栏角标（`setOverlayIcon`，超过 99 写 99+），清零就去掉。自己的托盘：有数量时「带数字的图标」和普通图标每 500ms 交替，窗口在前台时停在带数字的那张；tooltip「AMO 中转 · N 条待处理 / 未读」。
- 平台托盘（约束第 1 条）：平台启动的中转（`--amo-tray=platform`）把 `{count, blink, pid}` 写进它自己文件夹的 `attention.json`（`AMO_RELAY_HOME` 或 `%APPDATA%\AMO Relay`），退出时删掉；平台每秒看一次（`platform/src/relay-attention.ts`，只在文件变了时读，pid 不在了就不算）。有数量时平台托盘换成中转图标 + 数字，按 `blink` 闪，tooltip「AMO 平台 · 中转有 N 条待处理 / 未读」，菜单项「打开中转（N 条待处理 / 未读）」，单击图标打开中转；清零换回平台自己的图标。中转图标在 `platform/assets/relay-16…32.png`（`make-icons.mjs` 顺带复制）。
- 画数字：`traymenu/src/badge.ts` 自己画像素（主进程没有 canvas）：红色圆 / 胶囊带深一点的边、白色像素字（5×7 和 3×5 两套，整数倍放大），叠在图标上时周围挖一圈透明；`badge-image.ts` 转成 16/20/24/32 四个尺寸的 nativeImage。
- 验证：typecheck 过；vitest 新加 badge / attention / relay-attention / 托盘菜单；relay e2e 新加一条（AI 发会话 → 计数 1、闪、`attention.json`；看着 → 不闪；回复后 0；退出文件删掉）；平台 e2e「AMO 中转 from the platform」加托盘切换 / 点击打开中转 / 清零换回 / pid 不在不算。徽标深浅底预览用临时 Electron 脚本画过。真实任务栏和托盘没在桌面上实际看过。
- 发布要升：中转外壳（relay-app）、平台；`relay-ui` 那一处要 `relay:release` + deploy。

**2026-10-29 夜 · 其余窗口也去掉 Windows 标题栏，换成 AMO 自己画的（合并自 `worktree-agent-ab6979def96d4bbaa`）**

- 用户：「书签的标题还是 Windows 的，改成 AMO 风格」。书签、画布小窗、Git Review、查看器（含查看包）、首次设置都改成 `titleBarStyle: "hidden"`，页面顶部那一行当标题栏（`.titlebar`：可拖动，按钮、输入框、带悬停提示的部分不拖），左边 AMO 标识（独立 Reviewer 里是 Reviewer 的标识 `ui/public/reviewer.svg`，`make-icons.mjs` 会生成），右上角自己画的 最小化 / 最大化(还原) / 关闭。画布小窗和首次设置不可最大化，只有 最小化 和 关闭。
- 共用：`ui/src/shell/WindowControls.tsx`（`WindowControls`、`TitleMark`、窄标题栏 `TitleBar`、`WindowPlaceholder`），主窗口 `TopBar` 也改用它；主进程 `reviewer/src/window-controls.ts` 的 `installWindowControls()` 让 `amo:window` 作用于发消息的那个窗口，`sendMaximized(win)` 把最大化状态发给各自页面；Studio 和独立 Reviewer 都装，独立 Reviewer 的 preload 加了 `windowControls`。主窗口 × 仍只隐藏到托盘（它自己的 close 处理），其他窗口 × 真关。
- 页面还没有顶栏时（正在连接 Host、读取中、项目不存在、远程文件取回中、整个窗口出错）显示一条窄标题栏，窗口照样能拖、能关。查看器的「改动」里嵌的 Git Review 不再画一套按钮。书签顶栏的两个输入框窄了一点，760 宽时一行放得下。首次设置换成 AMO 的配色（浅色纸感、深色和 Studio 深色一致），跟随系统深浅。
- 验证：typecheck、vitest（ui / reviewer / app 57 个文件 325 条）过；e2e 新 `e2e/studio/titlebars.spec.ts`（四个窗口：没有系统标题栏、顶栏可拖、按钮在右上角、× 只关自己、最小化只作用于自己），`portable.spec.ts`、`reviewer-app.spec.ts` 加了标题栏检查；书签、画布小窗、Git Review、查看器、chat-files 相关 studio spec 和 reviewer project 共 29 条全过。截图 `screenshots/studio/titlebar-*`、`screenshots/reviewer/titlebar-*`（深浅各一）。没在真窗口里手动拖过、没试过真的最大化（测试窗口不能上屏）。

**2026-10-29 晚 · 开会话（session_start）的权限：沿用开它的会话、不能更宽，Claude 的 write 改成帮我审批（只提交，没发布）**

- 起因：一个「帮我审批」的 Claude 会话用 `permission: "write"` 开了子会话，Claude 的 write 映射成 `acceptEdits`，子会话的每条只读命令（sed、rg、node -e）都去问用户。全局 auto mode 配置没坏（10-28 重置后的默认）。
- 改动（`features/sessions/service.ts` 的 `peerPermission`）：不填 permission 时，同一种 CLI 沿用父会话的权限，换了 CLI 用它的默认；不管填没填，都不能比父会话宽：同一种 CLI 按 `PERMISSION_ORDER` 比，跨 CLI 按 只读 / 可写 / 完全 三档比。填了更宽的就报错，列出能用的档；默认值更宽就降到父会话那一档。Claude 的 write 改成 `auto`，第三方端点（GLM 等）没有分类器时退回 `acceptEdits`。MCP 工具说明和 guide 里的权限描述一起改了。
- 验证：`peer.test.ts` 7 条过（新加一条覆盖 Claude、GLM、跨 CLI 和远程会话没有父会话可比的情况），sessions、mcp、guide 的测试 32 条过，host 类型检查过；没跑完整的 verify，Host 没重启（Host 重启后才生效）。
- 还剩：用户决定等工作区里那批没提交的「远程」改动做完，一起升 Studio 版本发测试通道；`packages/app/CHANGELOG.md` 顶上的「下一版」一节发布时要改成版本号和日期。

**2026-10-29 晚 · 托盘菜单统一成便签的样子、各工具都有主题、平台进度条和「关闭」修正；测试通道发平台 0.9.8、Studio 0.9.9、便签 0.9.4、中转 0.9.3、Reviewer 0.9.7（`3373957`，正式通道没动）**

- 托盘菜单：新包 `packages/traymenu`（`@amo-studio/traymenu`），照便签的托盘菜单画的无边框小窗（一页自带样式的 data: 页面，点击当作导航截下来）；平台、单独打开的 Studio 和中转都用它，不再用 Windows 自己的菜单。便签保留自己的那份（它是样板）。新包已加进 `package-portable.mjs` 三个程序的包列表。
- 主题（用户：所有工具都要有深浅色）：Studio、中转原来就有。平台（设置 → 主题，`platform.json` 的 `theme`）、便签（便签设置，`settings.json` 的 `theme`）、独立 Reviewer（Git Review 顶栏最右的按钮，`%APPDATA%\AMO Reviewer\theme.json`）新加。做法：主进程记住并设 `nativeTheme.themeSource`，页面 `applyTheme("system")` 交给 base.css 的 prefers-color-scheme，所以托盘菜单也跟着这个工具的主题；默认浅色。Studio 和中转自己的托盘菜单跟随 Windows（它们的主题存在页面的 localStorage 里，主进程不知道）。
- 平台进度条：以前读清单 / 准备 / 切换时是来回滑的色块，下载时换成真实宽度，看起来涨了又退。现在下载前空、下载中按字节、切换时满；只有卸载和换回已装版本还用滑块。
- 「关闭」：从运行中的 exe 所在的版本文件夹认出版本，比 Studio 0.9.8 / 便签 0.9.3 / 中转 0.9.2 旧的不认识 `--amo-quit`（只会把窗口叫到前面），改成提示去它自己的托盘退出（`system.ts` 的 `QUIT_SINCE`、`runningVersions`）。用户当时开着的是 Studio 0.9.7。
- 验证：vitest 1019 过；平台 e2e 8 条、Reviewer e2e 过，便签 e2e 只剩已知的 Ctrl+Alt+Space 那条（真便签占着热键）；三处深色截图 P12-settings-dark、N3-settings-dark、R3-viewer-dark；托盘菜单深浅两种用临时 Electron 脚本截图看过。打包后的程序没实际打开过。
- 坑：PowerShell 工具里跑 Electron e2e 连不上 127.0.0.1（沙箱），用 Bash 工具跑就好；机器忙时平台查进程（PowerShell `Get-Process`）要 6 秒，超过 e2e 默认 5 秒的 expect，平台 e2e 会卡在「正在连接」，临时把 expect 超时放宽能过。Playwright 默认把 prefers-color-scheme 模拟成浅色，测主题前要 `page.emulateMedia({ colorScheme: null })`。

**2026-10-29 傍晚 · 远程创建合并，测试通道发 Studio 0.9.8、平台 0.9.7、便签 0.9.3、中转外壳 0.9.2（正式通道没动，等用户试过再 promote）**

第 3 步远程创建（子 agent，快进合并 `e34a79c`…`f209b0e`）：A 的 远程 → 远程设置 加「远端允许的项目」（kv `remote.allowedProjects`，含公共文件夹开关；不勾就不能远程建）；新命令 `rt.catalog`（专题、允许的项目、允许的模型）、`rt.create`（A 检查后建任务、授权、开会话，和第 4 步的同意共用 `create.ts` 的 `startGrantedTask`）；B 的新任务页「在这台电脑上 | 在别的设备上」，设备行 → 专题 / 项目 / 模型来自那台，没有附件和 @；设备卡「在它上面新建任务」直接进远程模式；老 A 收到会提示先更新。验证（子 agent）：vitest 1017 过；remote* / newtask e2e 15 过（新 `remote-create.spec.ts` 整条流程）。之前合并后 studio 全量 e2e 186/188（剩下两条是已知的 cli.spec.ts:35、turn-start.spec.ts:74）。**两台电脑都要升到 Studio 0.9.8** 才能远程创建。

**2026-10-29 下午 · 托盘合并、环境页更新、远程单独成页、新任务页改版**

方案 `plans/remote-page-and-new-task.md`（用户已定，含第 6 节托盘）。
- 托盘（`ad9b48b`）：平台启动的工具带 `--amo-tray=platform`，不放自己的托盘；平台托盘菜单按工具分区全部列出（Studio：打开 / 重启 / 完全退出；便签：显示隐藏 / 退出，没单独装时经 Studio 的 `--amo-app=notes`；中转：打开 / 退出；平台：打开、单击图标打开便签或 Studio（`platform.json` 的 `trayClick`，默认便签）、退出平台）。做法：再启动工具 exe 带 `--amo-quit` / `--amo-toggle`，单实例转给在跑的那个；Studio 走自己的完全退出（会先问）。工具卡运行时多「关闭」。单独打开的工具照旧有托盘。
- 环境页（`9ac2cd8`）：Claude Code、Codex 显示 npm 最新版本，有新版给「更新到 x」（npm 装的 `npm install -g …@latest`，官方安装器的 `claude update`）；Codex 被 Studio 后台占着时不更新、说明先完全退出 Studio。`AMO_PLATFORM_NPM_REGISTRY` 换仓库（e2e 指向假的）。
- 管理页：改管理密码（`2b23255`）、邀请口令（`5c2842f`，页面设的优先于 `--passphrase`；线上还没设，等用户设）。都已部署。
- 远程单独成页（子 agent，合并自 `worktree-agent-a768b8ffca7afbff7`）：顶栏「远程」按钮（在线数、待处理的点），`ui/src/remote/` 整页（身份行 → 任务 → 已配对设备 → 远程设置），配对弹窗列同账号在线设备（中转新接口 `GET /api/devices/online`，配对请求可点名一台 `toDevice`；已部署 `2026.10.29-125345`），设置里的远程页删掉。
- 新任务页改版（子 agent，合并自 `worktree-agent-ae9935f3299c142f4`）：专题在项目上面、专题常用项目排前（只有一个时自动选）、每行 6 个 +「更多…」搜索框；第一句话的 @ 引用项目 / 任务（带会话）/ 文件，不再选项目，# 不再选专题；快速启动条加专题、项目两个选择按钮；编辑专题可以加减常用项目。
- 验证：合并后 typecheck 过、全量 vitest 1009 过（claude-runtime 集成测试那条照旧偶发）；平台 e2e、环境 e2e 过；studio 全量 e2e 在跑。便签 e2e 两条因本机真便签占着 Ctrl+Alt+Space 失败、中转 e2e 两条读剪贴板为空（并行测试抢剪贴板），和改动无关，待空闲时重跑。
- 在做：第 3 步远程创建（子 agent）：A 的「远端允许的项目」、`rt.catalog` / `rt.create`、新任务页「在别的设备上」。做完一起升版本发布（平台、Studio、便签、中转外壳）。

**2026-10-29 中午 · 团队服务器管理页、改登录名**：用户要把账号 `Daihongyu` 改成 `dhy`，并要一个简单的管理网页（局域网自用，不走 AMO 登录）。中转服务加 `/admin`（`relay/src/admin-page.ts`）：单独的管理密码（`npm run relay:mac -- admin-password`，存在库里 `admin` 表，哈希；每次请求带 `x-amo-admin`，错了等 0.6 秒），能看成员（在线、登录中的设备数、最近发言）、改登录名、重设密码、停用 / 启用（`members.disabled`，停用时删掉他的登录、不能再登录）。改登录名（`store.renameMember`）在一个事务里改 members / keys / 对话 / 会话 / 消息作者和 @ / 任务和流转记录 / 文件 / 批注 / 设备配对，单聊的 `direct_key` 重算，已有登录照样有效；在线的连接和设备通道断开重连成新名字。命令行也有 `amo-relay rename`、`relay:mac -- rename`（会重启服务）。已部署（备份 `data/backup-20261029-120626.db`），管理密码已设（在用户那里），`Daihongyu` → `dhy` 已经改好。验证：relay 单测 39 过（新加改名覆盖所有表 + 外键检查、停用、管理密码，接口测试含改名后 WS 断开以新名字重连）；管理页截图看过。用户本机平台的 `account.json` 里名字还是旧的，要在平台「账号」里退出再用 `dhy` 登录一次。

**2026-10-29 上午 · 正式通道第一批**：用户定全部转正式。现在两个通道一样：Studio 0.9.7、Reviewer 0.9.6、便签 0.9.2、平台 0.9.6、中转 0.9.1（`platform-status`）。下载页的平台 zip 也是 0.9.6；从下载页装的平台默认看正式通道，同事现在能直接装。

**2026-10-29 上午 · 中转用平台的账号登录（中转外壳 0.9.1 测试通道；界面 2026.10.29-110254 已部署）**

用户：平台打开的中转还在用以前的登录（本机 `%APPDATA%\AMO Relay\settings.json` 里是老的本机测试服务器 `127.0.0.1:47120`），连不上服务器；图标也是旧的。登录：约束第 7 条之前没在中转落地。外壳加 `relayShell.platformAccount()`（读 `%APPDATA%\AMO\account.json`，`@amo-studio/account` 的 `readAccount`，每次问都重读）；界面有它时用平台账号直接登录（`/api/me` 取角色和团队名），并写 `settings.json` 给本机 MCP / 命令行；每 5 秒和窗口获得焦点时再读，平台换账号就跟着换、退出就回到提示；平台装的中转没有平台登录时只显示「在 AMO 平台里登录」（`PlatformLogin`），手动解压的版本照旧用自己的登录页；用平台账号时设置里没有「退出登录」（服务器上退出会让平台的令牌也失效）。旧外壳没有这个接口，界面照旧。图标：开始菜单里有个 10-27 建的「AMO Relay」快捷方式（AppUserModelID `AMO.Relay`，指向 `release/relay-pack` 里旧的、带 R 角标图标的 exe），任务栏按它显示旧图标；已改成指向 `D:\TOOLS\AMO Platform\apps\relay\current` 和新的 `icon.ico`（原快捷方式备份在会话 scratchpad），中转下次启动生效。平台装的 exe 本身是 Electron 默认图标（共用 Electron，方案里定的代价）。验证：relay e2e 4 条过（新加：平台已登录直接进、没登录显示提示、之后登录自动连上、退出回到提示，截图 `screenshots/relay/43-platform-login-there.png`）；relay / account 单测 50 过；打包后的中转用隔离目录启动正常。

**2026-10-29 上午 · 远程也能看文本文件（Studio 0.9.7，测试和正式通道都发了）**

用户：A 上查看器里点 HTML 引用的 md / 脚本会接着在查看器打开（没固定就换掉当前窗口，固定了开新窗口），B 上也要这样。之前 B 只放行 HTML / Markdown / 图片，脚本、配置、txt、json 会被拦。改动：远程文件类型加 `text`——除已知的二进制扩展名（exe、dll、zip、pdf、docx、视频、字体等，B 上直接提示）外都当文本问 A，A 看开头 4 KB 有没有 NUL 字节，文本最大 2 MB（和本地查看器一样，`MAX_TEXT_FILE_BYTES`）；B 上用本地查看器的代码视图显示（高亮、跳到行、查找）。提示改成「远程任务不能看程序和二进制文件，只能看文本、HTML、Markdown 和图片」。验证：全量 vitest 990 过；e2e remote-files（远程 HTML 里点 `../tools/gen.py` 打开、点 `../run.exe` 提示且页面不动，截图 `screenshots/studio/remote-viewer-script.png`）、remote-tasks、viewer-rendered、chat-files 过。

**2026-10-29 上午 · 远程副本归档即删、几项定下不做（Studio 0.9.7）**

用户 10-29 早：「B 归档 = 同时删除」（会话本体在 A，B 只是看）。查到上次「文件夹 20 秒内没删掉」不是杀毒软件：是 B 的 Host 给查看器送图片用的流，查看器换页后一直没关，句柄占着图片（杀掉 Host 立刻能删）。改动：远程缓存的图片（`/api/remote/files/…`）和 `/api/fs/raw` 里 ≤32 MB 的图片改成整个读进内存再发（`FileReply` 的 `whole`），不再留着文件；归档副本时先把 `remote-files/<taskId>` 改名挪到 `.gone-…` 再删（挪不动才退回原来的重试），Host 启动时清掉剩下的；归档时还在路上的取文件不再写回来（不会把文件夹又建出来）。验证：远程单测 31 过（新加「取到一半归档」）；全量 vitest 989 过（claude-runtime 集成测试那条高负载偶发失败，单独重跑 16/16 过）；e2e remote-files（归档后 5 秒内文件夹没了）、remote-tasks、chat-files、viewer-rendered 7 条过。

用户同时定的：会话级授权先不做；远端允许的模型到渠道一级就够；对话正文里 A 的绝对路径先不管（B 只关心在哪个项目）；HTML 的 CSS / JS 不用做——看了 project_mining 里的 HTML 报告（`out/html`、`AIWork`、`Docs` 下 15 份），全是单文件，样式和脚本都内联，远程查看用 `srcDoc` + `sandbox="allow-scripts"`，内联的都能用；引外部 css / js 的只有 `Tools/Archify/web/index.html`（是个工具页，不是报告），Archify 导出页只引 Google 字体（本地看也一样）。

**2026-10-29 早 · 远程第 3、4 步和收尾，测试通道 Studio 0.9.6、Reviewer 0.9.6（用户回来先看这条）**

做了什么：第 3 步（`a2d58e3`）B 在远程任务里点开 HTML / Markdown / 图片：新命令 `rt.file`，A 只放行任务文件夹里（先解析 junction / 软链接）、对话里发过的附件图片，类型 HTML / Markdown / 图片、≤20 MB、512 KB 分片带 sha256；B 缓存在数据目录 `remote-files/<taskId>/`，没变就不重传，A 离线显示上次的版本，归档时清掉；查看器读条「正在从 <A> 取文件…」；HTML 同目录图片走 B 的 `GET /api/remote/files/<随机 key>/…`（不要令牌，只给图片）；A 推给 B 的命令卡片 cwd 改写成「任务文件夹\…」（对话正文里的绝对路径没改）。第 4 步（`e680461`）B 在 设置 → 远程 → 已配对设备「请它跑一个任务…」→ A 的 Focus 出现「任务请求」→ A 在 设置 → 远程 选项目 / 专题 / 允许的模型同意 → A 建任务、授权给 B、开会话发出第一句话 → B 看板出现并在跑；A 可以拒绝写原因；A 离线时 B 发不出（服务器不存请求）。收尾（`15a4e81`）托盘「完全退出」时有任务正被在线设备远程使用会提醒；被远程使用时 A 不睡眠（`powerSaveBlocker`）；B 的 AMO MCP 不列远程副本、碰到副本一律拒绝；B 归档副本会告诉 A 结束授权（`rt.drop`）。另外查看器里的 Markdown 会显示文件旁边的图片（本地文件也是）。

验证：全量 vitest 989 过、typecheck 和 build 过；子 agent 跑了 remote-files、remote-requests、remote、remote-tasks、tray、viewer-rendered、chat-files、markdown、focus、viewer-review、settings、mcp 的 e2e。主会话用测试账号连团队服务器：任务请求整条通过；文件查看整条通过，只有最后「归档后本地文件夹 20 秒内删掉」没等到（Windows 刚写完的大文件被占用，代码会重试、Host 下次启动也会清），不影响使用。

待用户验收（在上面「待用户验收」清单之外）：
- 远程文件：B 上打开远程任务对话里的 .md / .html / 图片链接，看读条和显示；点 .exe 之类会说明不支持。
- 任务请求：B 的 设置 → 远程 →「请它跑一个任务…」；A 的 Focus →「去处理」→ 选模型同意（先在 A 的 设置 → 远程 勾「远端允许的模型」）。
- 完全退出提醒：A 有任务授权给在线的 B 时，托盘「完全退出」会多问一句。

没做 / 以后：会话级授权（只有任务级）；远端允许的模型只到渠道一级；HTML 只取同目录图片，CSS / JS 不取；对话正文里的 A 绝对路径还会带用户名；Focus 里不能直接同意请求（要选项目和模型，只能「去处理」）。下一件：`plans/relay-in-sessions.md`（会话里直接用中转，用户 10-29 定在远程之后）。

**2026-10-29 凌晨 · 远程第 2 步（测试通道 Studio 0.9.5、Reviewer 0.9.5）**：A 把任务授权给配对的设备（`942e099`…`c84173d`）。「远程」是 B 的 Host 里一种会话运行方式（`RemoteAwareRuntime`，runtime `remote`）：B 的副本放公共目录、`tasks.remote` 列（migration 23，0.9.5 打开过数据后不能回 0.9.4）；A 的远程命令 `rt.list / rt.task / rt.items（since 补齐）/ rt.send / rt.approve（先到先得）/ rt.answer / rt.interrupt / rt.start`，推送 `rt.push`；授权表 kv `remote.grants`、远端允许的模型 kv `remote.allowed`（只到渠道一级）；B 在线时 A 的 Focus 不提醒；被授权任务里禁止跨项目委派。主会话补了一处（`8c88d9a`）：B 上的远程副本不算「正在跑的会话」，不挡完全退出 / 重启。验证：合并后全量 vitest 975 过；remote-tasks / remote / canvas-resize / board / focus e2e 过；tray 的一条在 20 条之后跑时超时一次，单独重跑 2/2 过（偶发）。用测试账号连团队服务器走通：配对 → 授权 → B 看板出现 → B 发消息 A 回复 → 审批 B 点批准两边同步 → B 新开会话 → 收回授权 B 显示「授权已收回」（断线那段在真服务器上没法测，本地 e2e 覆盖）。在做：第 3 步（B 看 HTML / Markdown / 图片，读条）、第 4 步（B 请求、A 同意后自动建任务）、收尾（A 完全退出前提醒远程使用、被远程用时阻止睡眠、B 的 MCP 不把副本当本地任务）。

**2026-10-29 凌晨 · 待用户验收（测试通道：Studio 0.9.4、Reviewer 0.9.4、平台 0.9.6、便签 0.9.2、中转 0.9.0；之后 Studio / Reviewer 又发了 0.9.5）**

Studio 托盘（`04869d9`）：× 只隐藏窗口，Studio 和 Host 留在托盘；托盘「完全退出」连 Host 一起关（有会话在跑先问）；`/api/health` 带 `version`；`POST /api/shutdown`（要令牌，有会话在跑时 409，带 `interrupt` 才放行，退出前写 `host-exit.json` 让外壳跟着退）；外壳写 `shell.json`；平台 Studio 卡片显示后台状态和版本，后台比已装旧且空闲时给「重启 Studio」（平台从不带 interrupt）。验证：合并后全量 vitest 963 过；e2e tray / remote / canvas-resize 6 条、platform 8 条过。

验收清单（给用户）：
1. **第一次升级 Studio 要手动关一次旧后台**：现在跑着的 Studio 0.9.3 后台不报版本、没有退出接口，平台的「重启 Studio」用不了。做法：Studio 里没有会话在跑时，关掉 Studio 窗口，再用任务管理器结束剩下的 `AMO Studio.exe`（或者让主会话来关），然后在平台里把 Studio 更新到 0.9.4 再打开。以后就能用托盘「完全退出」和平台的「重启 Studio」了。
2. 平台更新到 0.9.6（顶栏会提示「平台有新版」→ 设置 → 平台更新 → 重启平台）。Studio 卡片上应该能看到「后台在运行 · N 个会话进行中 · 后台版本 0.9.4」。
3. Studio 托盘：点 × 窗口消失但托盘还在、会话照跑；点托盘图标回来；托盘右键「完全退出」。
4. 画布：拖卡片和分组的右下角改大小、双击恢复；删分组时的勾选框。
5. 设置 → 远程：本机设备名、连接状态应是在线（已部署到团队服务器）；配对要另一台电脑（或另一个账号的 Studio），没有也可以先看界面。
6. 远程授权（Studio 0.9.5 起）：需要两台电脑（或另一个账号的 Studio）先配对；A 的任务页 ⋯ →「授权给…」，B 的看板会出现「远程在 … 上」的任务卡，能发消息、审批、新开会话；A 在任务页或 设置 → 远程 里收回。设置 → 远程里的「远端允许的模型」先看一眼。
7. 留意杀毒软件有没有再拦。

**2026-10-29 凌晨 · 远程第 1 步上线、画布调整（用户不在，主会话接着推进）**：远程会话第 1 步（`528f446` 中转服务端的设备登记 / 配对 / 只在配对设备间转发，`c2bb7be` Studio 的 Host 连出、设置 → 远程、配对请求进 Focus、设置旁亮点；设备编号 `%APPDATA%\AMO\device.json`，配对存 Host kv `remote.pairs`）已部署到 Mac（health 里 `devices: 1`）。主会话在团队服务器注册了测试账号「测试-A」「测试-B」（负责一栏写明是测试账号，密码在主会话 scratchpad 的 test-accounts.json），用两个 Studio 测试实例连真服务器走通：配对请求 48 ms 到达、测试连接往返 2–4 ms、解除配对两边同步。画布（`88f9648`）：删分组有确认框和「同时删除组里的 N 张卡片」（任务卡只从画布拿掉，任务不删），删除配色同「归档」，四种卡片拖右下角改大小（存在画布 JSON 的 `size`，无新迁移）。修了一条早就红的 e2e（`c622cc6`，naming）。`studio` e2e 里还有两条在 master 上就红的：`cli.spec.ts:35`、`turn-start.spec.ts:74`（第 1 步的 agent 切到旧提交复现过，和这轮改动无关，没修）。测试预算：gpt 300、claude 300、dsh-dxx-ds 1000（`bf96f93`）。在做：Studio 托盘、远程第 2 步。

**2026-10-28 深夜 · 平台 0.9.5：装在解压的文件夹里、账号页、「⋯」菜单；服务器清旧版本**：平台和工具装在平台所在的文件夹（`cb35829`，入口转发 + 入口换新，火绒对旧的「原地改名」方式报过勒索行为，新方式没报）；账号单独一页，昵称、头像、负责什么从中转搬到平台改（`7a083ce`，中转界面只显示、提示去平台改）；回滚和卸载收进「⋯」。服务器每个工具留最近 3 个版本（`b2aca32`），用户手动跑过一次 `platform-prune` 删了 410 MB，以后 publish 自动清（这次自动删了平台 0.9.2）。`npm run relay:mac` 加了本机允许规则（`.claude/settings.local.json`）。`studio/.data` 旧备份清掉，留最近 5 份（7.4 GB → 1.2 GB）。远程会话方案定了大半（`plans/remote-session.md`：远程用、按任务 / 会话授权、B 是自己的另一台设备但不同账号要配对、B 上远程任务是普通任务卡、Focus 只提醒 B），平台稳定后开工；Multica 调研在跑。验证：全量 vitest 935 过（1 条 claude-runtime 集成测试忙时超时，单独重跑 16/16 过）、平台 e2e 7 条和中转 e2e 4 条（子 agent 跑）。待用户：删掉 `D:\TOOLS\AMO Platform` 和 `AppData\Local\AMOpps`，重新下载 zip 解压试用。

**2026-10-28 深夜 · 杀毒误报、中转走平台**：用户的杀毒软件（像火绒）在平台下载 Studio 时把 `host/dist/runtime/priority.js` 报成 Trojan/Veil.a（`-EncodedCommand -ExecutionPolicy Bypass` + `Add-Type DllImport ntdll` 改别的进程）。本机用 curl 和平台 exe 下载都复现不出。修法（`322cb20`）：6 处 PowerShell 调用改成脚本走 stdin，不再有 `-EncodedCommand`/`Bypass`/`ntdll`；agent 进程去掉磁盘优先级（用户同意），内存优先级改用 `SetProcessInformation`，CPU 照旧。中转桌面客户端改由平台安装和更新（`11d0cf7`，`AGENTS.md` 第 3 条已改）：平台模式的中转不再自己更新外壳，界面照旧热更新；MCP 配置和 `amo-relay.cmd` 指向 `apps
elay\current`；平台打开中转时带 `--server`。发布：中转界面 deploy（服务没变、没重启），测试通道 Studio 0.9.3、Reviewer 0.9.3、中转 0.9.0、平台 0.9.4（便签仍 0.9.2），每个新上传都不到 0.3 MB；下载页 zip 0.9.4。验证：全量 vitest 917 过、typecheck 过；平台 e2e 6 条、中转 e2e 4 条（子 agent 跑）。没验证：杀毒软件还拦不拦（等用户在平台里重装 Studio）；中转登录还是自己的登录页（改读平台的 `account.json` 是下一件事）。

**2026-10-28 夜 · 平台自更新，测试通道发平台 0.9.3**：平台自更新（`da59bf7`，`self-update.ts`：发现通道里 `platform` 的新版 → 「设置 → 平台更新」装进 `apps\platform\<版本>` → 人点「重启平台」；从 zip 解压的第一次更新后搬进 `apps\platform`，开机启动改指 `current`；开发版不自更新）。工具照旧从版本文件夹启动、不走 `current`（查过原因，见方案）。平台 0.9.3 发到测试通道（新上传 16 个文件，0.1 MB），下载页 zip 换成 0.9.3。验证：子 agent 用真打包的平台在本机走过「发现新版 → 更新 → 重启 → 登录还在」；合并后 typecheck、平台和 app 的单测 47 条过。注意：稳定通道还是空的，从下载页装的平台默认看稳定通道，要切到「测试」才看得到工具；给同事用之前要 `promote`。

**2026-10-28 夜 · 共用 Electron、环境页，测试通道发 0.9.2**：共用 Electron（`1d2f264`：`npm run package:platform` 打平台包到 `release/platform/`，exe 不写图标，安装引擎按 sha256 跨工具硬链接，`file-index.json`）；平台「环境」页（`7bb3e78`：Claude Code、DSH 桌面版、Codex、git，去下载官方页，新包 `@amo-studio/locate` 放 host 和平台共用的查找函数）；平台装的 Studio 不经平台打开时读 `%APPDATA%\AMO\platform.json` 的数据目录（`8be9e9e`，只认平台模式的包）。四个工具 0.9.2 发到测试通道：Studio 新上传 24 个文件（共用的 exe 压缩后 104 MB，只传这一次），Reviewer、便签各 2 个、平台 16 个，都不到 0.1 MB；下载页的平台 zip 换成 0.9.2（portable 模式）。验证：合并后 typecheck、相关单测、平台 e2e 4 条过；环境页两条测试在忙机器上不稳，改了（`ed8327d`）。平台自更新在做（子 agent）。

**2026-10-28 夜 · 图标、注册、下载压缩，测试通道发 0.9.1**：图标定成「取景框」一家（`design/icon/tools/`，生成器 `gen-tools.mjs`，`make-icons.mjs` 出各工具的 png/ico/托盘图，Reviewer 和平台有了自己的，AMO 娘没动，`5d8d3cd`）；平台登录页能注册（`d1ad3e1`）；下载压缩（`707b3c6`，规则写进方案的接口约定）。Mac：先 deploy 新服务（一次成功，START 的修复有效），再 `platform-compress`：8463 个文件 1077 MB → 467 MB，167 秒。四个工具升 0.9.1（各自 CHANGELOG），打包、发到测试通道：每个工具新上传 3–21 个文件，约 235 MB、压缩后 104 MB（几乎都是 exe：rcedit 给每个 exe 写了自己的图标，每版都不同，共用 Electron 会解决）；平台 zip 换成 0.9.1。中转下载页只给平台（`8387fc7`）。验证：合并后 typecheck、account/platform/relay/testkit/scripts 的单测 103 条、平台 e2e 2 条都过；压缩脚本在 Mac 上每个文件解压核对 sha256。没在真服务器上用账号装过（等用户第一次用平台）。下一步：共用 Electron（方案「共用 Electron」一节）。

**2026-10-28 晚 · 平台部署到 Mac、测试通道第一批发布**：本机 Studio 关掉前没有会话在跑（17 空闲、26 完成），库备份 `.data/backup-before-platform-20261028`。`relay:release` → `relay:mac -- deploy`：重启时 launchd 报 `Bootstrap failed: 5`（`bootout` 是异步的，紧接着 `bootstrap` 会撞上），服务停了一两分钟，`start` 拉起来了；`relay-mac.mjs` 的 START 改成等旧任务真正卸载再 bootstrap。plist 带 `--platform-dir /Users/td/Services/amo-relay/platform`。Studio / Reviewer / 便签 / 平台 0.9.0 都发到测试通道（Mac 上 bash 3.2 + BSD tar 那条路正常；Studio 传 6571 个文件 269 MB，Reviewer 只缺 4 个），共 8463 个文件 1.1 GB。平台 zip 手动放在 `platform/downloads/AMO-Platform-win.zip`（sha256 和本地一致），下载页有「下载 AMO 平台」。还没做：用户用 `start-platform.cmd -Test` 登录、装 Studio、把数据目录设成 `studio\.data` 后从平台打开（第一次由用户操作）；稳定通道还空着。

**2026-10-28 晚 · AMO 平台第一版**（方案 `plans/amo-lan-platform.md`「10-28 晚定的推进方式」「第一版的接口约定」「进度」；三个子 agent 在 worktree 里并行做，主会话合并和联调）：
- 小改动：Host 遇到被更新版本迁移过的数据库拒绝启动，弹窗说明（以前启动失败是一声不响地退出，现在都弹窗）；`/api/health` 不要令牌，多返回 `running`；设置 → 维护的终端可选 Claude Code / Codex。
- 服务器发布：Studio（`packages/app`）、Reviewer、便签、平台各自的版本号（都 0.9.0）和 `CHANGELOG.md`，工具表 `scripts/amo-tools.mjs`；`package:portable -- --only <工具>`；中转服务 `--platform-dir` 和三个平台接口；`npm run relay:mac -- publish/promote/platform-status`（`--target-dir` 发到本机文件夹）。
- 平台：`packages/account`（登录、`account.json` 用 DPAPI 加密、最近 3 个服务器）、`packages/platform`（托盘、单实例、版本文件夹 + `current` 联接、硬链接复用、sha256 校验、保留 2 个版本、回滚、卸载、拉起 Studio 必须先设数据目录）、界面 `platform.html`。开发时 `npm run platform`；双击用 `start-platform.cmd`（`-Test` 走测试通道）。
- 验证：各 agent 的单测和 e2e（`--project platform` 用 testkit 假服务器走完登录 → 安装 → 更新 → 回滚 → 卸载 → Studio 数据目录，截图 `screenshots/platform/`）；合并后全量 vitest 869 过，host 包 4 个文件机器忙超时，单独重跑 21/21 过；typecheck 过。主会话本机联调（真实中转服务 + 本地发布 + 打包好的 `AMO Platform.exe`，临时目录）：发布便签 0.9.0（3384 个文件）→ 平台登录 → 安装 5 s、文件逐个对上 → 发布 0.9.1（只传 2 个文件）→ 更新 2 s（3382 个文件硬链接复用）→ 回滚 → `account.json` 的 key 是加密的 → 真实 `%APPDATA%\AMO`、`%LOCALAPPDATA%\AMO` 没被碰。
- 没做：部署到 Mac（`relay:mac -- deploy` 会重启中转一次，要先问用户）、第一次真实发布（Mac 上是 bash 3.2 和 BSD tar，要盯着）、平台 zip 上服务器、第 3、4 步、平台图标（等用户在图标家族方案里选）。本机 master 上新增了两个 workspace 包，`start-platform.cmd` 第一次运行会 `npm install`。

**2026-10-28 · 数据位置检查**（平台方案「开工前先整理」第 4 步，只查不改代码）：用 `release/` 里 10-24 的三个 portable 包实测（解压到 `%TEMP%mo-studio-sandbox`，设好变量、测试模式、端口 0，各跑一次再关掉，比对程序文件夹前后的文件清单）：三个程序文件夹都**没有任何新增或改动**，`%APPDATA%` 下的 Electron、AMO Studio / Reviewer / Notes、AMO 也没被碰；数据都进了变量指的目录（Studio：studio.db、host.log、codex、common、electron 等；Reviewer：data、electron；便签：electron）。10-24 之后这几处路径代码没改过。代码上也对得上：Studio 设了 `AMO_STUDIO_DATA_DIR` 就不走首次设置，不写 `amo-studio.json`（`app/src/paths.ts`）；Host 的东西全在数据目录下（`host/src/host-process.ts`）；Reviewer、便签不设变量时也默认在 `%APPDATA%`，只有 Studio 不设变量时会用 exe 旁的 `data/` 和 `amo-studio.json`。所以平台装 Studio 时**必须**设 `AMO_STUDIO_DATA_DIR`，另两个设不设都不会写进程序文件夹。没覆盖到的：没开真实会话、没走 DSH、没用附件，但这些都按 Host 的数据目录走。 详细见 `plans/amo-lan-platform.md` 第 4 条。

**2026-10-28 · 整理：HANDOFF 瘦身、旧文档归档**（平台方案「开工前先整理」第 1、2 步，只动文档）：这份文件只留当前状态和 10-26 以来的记录，更早的原样挪到 `docs/history/handoff-2026-10.md`；`docs/` 里 /loop 时期的五份文档挪到 `docs/archive/`，`plans/stage-1…17` 挪到 `plans/done/`；`README.md` 的「开发者文件导航」、代码注释里指向 `plans/stage-*.md` 的路径跟着改；`design/architecture.md` 开头标了哪些部分已过时；`packages/relay/README.md` 注明本机跑中转的脚本只是退路；`plans/` 里三个没跟踪的原型 html（relay-tasks、relay-ui-prototype、token-stats-prototype）用户让删了。全部用 `git mv`，历史还在。

**2026-10-28 · 新架构：AMO 平台（amo-lan-platform）**：用户定了以后的开发流程——本机开发 → 推送到团队服务器（Mac）→ 每个人在托盘常驻的「AMO 平台」里自己选怎么更新；平台安装、更新、设置 Studio / Reviewer / 便签，不改工具本身；中转保持现状。根目录新增项目说明 `AGENTS.md`（`CLAUDE.md` 引用它），写了工具和包的对应关系和**架构约束**（工具不依赖平台、数据不放程序文件夹、更新只走统一方式、Reviewer 只有一份、各工具单独的版本号、重启由人点）。方案和「开工前先整理」的清单在 `plans/amo-lan-platform.md`。界面原型：https://claude.ai/artifact/Uu4fL3bXZg1NZHXDSKBPc9 。下一步：用户看原型，然后先做整理（HANDOFF 瘦身、旧文档归档、各工具单独的版本号）。

**2026-10-28 · AMO 中转部署到 Mac**：服务在 Mac mini `http://172.16.8.85:47120/`（SSH 别名 `mac`，用户 td），launchd `com.amo.relay`，程序 `~/Services/amo-relay/app`、数据 `~/Services/amo-relay/data`。从本机管理：`npm run relay:release` 后 `npm run relay:mac -- deploy`，另有 status/restart/logs/backup/`passwd <名字>`（重设并打印新密码）/migrate，见 `packages/relay/README.md`。用户决定不搬本机数据：Mac 从空库开始（拷过去的那份另存为 `data/copied-from-windows-20261028-164410.db`），大家重新注册。Windows 上的旧服务（172.16.1.62）10-28 已停（`scripts/relay-service.ps1 stop`），同事在客户端点「更换」填新地址。下一步方案见 `plans/amo-lan-platform.md`（团队安装更新平台，中转保持现状、改用 Reviewer）。同时做了：读条页记住最近 3 个服务器（`shell.json` 的 `recent`，默认连上次的），登录页在新地址上找不到已存账号时借用别的地址上存的（服务器搬家后不用重输密码）；e2e 第 3 条覆盖，截图 `screenshots/relay/34-recent-servers.png`；桌面程序 zip 已重打（build 2026.10.28-161641）。

**2026-10-28 · AMO 中转收紧**：relay 只突出一件事——策划的 AI 卡住了、或方案要程序把关时发会话给程序，程序单轮或多轮回复后 AI 继续推进；人和人只聊天。任务、新会话、流转、团队流程/流程速查的入口都藏起来了（代码和数据都在，`relay-ui/src/features.ts` 的 `fullUi()`，localStorage `amo-relay.full=1` 打开），给 AI 的用法默认不提团队任务。见 `plans/relay-tasks.md`「收紧」，已发布客户端 2026.10.28-122112。

**2026-10-28 · 渲染批注**：查看器（和查看包里的文件）里 Markdown、HTML 默认渲染显示，选中文字点「批注」就能写意见，右边是批注栏。批注还是项目的文件批注（range `file`，`GitReviewComment.passage` = 引文 + 前后各 24 字 + 可选源 md；`line` 是推断的源码行，所以切到「源码」也在那一行），用原来的「复制注释」一起带走。定位做法同 relay 2d：`viewer/passageKit.ts`（自包含函数，渲染 md 直接用；HTML 时把它的源码注入 iframe），文件重新生成后按原文和上下文重新找到，空格多了少了也能对上，找不到的标「原文找不到了」。HTML 在 `sandbox="allow-scripts"`（不给同源）的 iframe 里**照常运行脚本**，注入脚本（`viewer/passages.ts` 的 `frameMain`）负责报告选区、画高亮、跳转时展开收起的 `<details>`、内存版 localStorage、复制按钮经查看器写剪贴板、外链交给系统浏览器。HTML 的源 Markdown 自动找：`<meta name="amo-source">`、同目录同名 .md、页脚（`<footer>` 或页尾）写的 .md；找到时批注里写「这份 HTML 由 x.md 生成：请改 x.md，再重新生成这份 HTML」（用户决定不改 `html-output.md` 规则）。e2e `viewer-rendered.spec.ts`，截图 `screenshots/stage-18/S25-rendered-*.png`。链接（同日补）：网址交给系统浏览器；`#标题` 在本页跳（Markdown 按 GitHub 规则算标题锚点，HTML 的锚点由注入脚本滚动，因为 srcdoc 里 `#x` 会按查看器地址解析）；其他文件（相对当前文件、绝对路径、`file:///`，可带 `#L12` 或 `:12`）在查看器里打开（`passages.ts` 的 `resolveLink`）。没做：右栏快速查看里的 HTML 仍是源码；HTML 里没有 Ctrl+F。同日：**查看器是默认方式**——对话里单击 .html 也进查看器（原来是浏览器），浏览器在菜单里；文件右键菜单改成共用的 `lib/ActionMenu.tsx`（分组 + 分隔线，每项右边一个字母，菜单开着时按字母直接执行，菜单先接按键所以不和页面快捷键冲突）。对话里：在查看器中打开 O / 在侧栏预览 P / 查看未提交的改动 D / 用 VS Code 打开 V / 用浏览器打开 W（仅 html）｜在资源管理器中显示 E｜复制路径 C / 加书签 B。Review 文件列表：在查看器中打开 O / 用 VS Code 打开 V / 用浏览器打开 W｜在资源管理器中显示 E｜复制路径 C。Review 文件标题栏「查看文件」挪到最前；侧栏预览标题栏加「在查看器中打开」。 同日：**位置批注**——HTML 页面任意位置右键「在这里批注」（A；有选中文字时还有「给选中的文字批注」S），钉编号圆点，批注栏里同号。记的是元素（先按 id，再按路径并用文字核对，最后按附近文字）和点在元素框里的比例（`GitCommentPassage.point`）。HTML 交给 iframe 前每个开始标签加 `data-amo-line`（`passages.ts` 的 `lineTags`），复制出的批注写 `path:元素所在行（位置批注：标题 › 元素）`，`>` 后是离它最近的文字。用户 10-28 决定：**截图先不做**（原方案：Electron 截点附近一块存 attachments，批注里写路径），先用一段时间再定；框选区域也没做。已知：行号是写批注时的，文件重新生成后不更新。

**2026-10-27 · 画布审阅（分支 `studio/review-canvas`，worktree `G:\PROJECT\AgentMonitorOverlay-review`，未合并）**：要点多的审阅放到专题画布上。AI 用 `canvas_items_post` 铺编号的审阅条目卡片，用 `canvas_callout` 在卡片上写说明或提问。人在画布上点问题，弹窗回答；回答作为消息发回提问的会话，问题框收成「已回答」，卡片显示进行中。条目右键可以改状态，或者「就这条展开聊」（开一个新会话）。侧栏新增「沟通」页。计划、场景和进度在 `plans/review-canvas.md`，决定记在 memory `review-canvas-decisions`。10-27 用户让直接合并（fast-forward 到 master）并重启验收；重启前备份在 `.dataackup-before-review-canvas-20261027`，重启后任务 38、专题 3、会话 150 与重启前一致，数据库到迁移 22。同次：Review 文件列表右键对 .html/.htm 加「浏览器打开」（`7a113fc`）。阶段 3 也已合并（`6fd0d6e` 专题分组、`38c78e8` Focus 画布问题 + 画布小窗），15:13 重启，**带着 `AMO_STUDIO_TRACE_STALLS=1`**：用户说推进任务时又有卡顿（14:40 主进程最长 4.1 s、14:48 880/718 ms），抓到后分析（15:15:13 那份）：主线程 646 ms 卡在 `amo:app-icon` → `mainWindow.setIcon`（等 Windows 处理 WM_SETICON），AMO 娘表情一变就换一次窗口图标 → 改成窗口图标固定为她的头像（`afd9a42`）。同时发现 15:14:13 Host 被看护误重启：看护改为 `/api/health`、5 s × 3 次、进程还在就只记日志不重启，日志进 resize-trace.log；`host:stop` 遇到 taskkill 部分失败不再崩（`744849e`）。15:26 重启，仍带 `AMO_STUDIO_TRACE_STALLS=1`。

**2026-10-26 · AMO 中转（`packages/relay`）开工**：让 AI 会话把请求发给团队里的人（比如策划的 AI 去问程序），人和人之间也能直接聊，记录存在服务上。中转服务跑在 Mac 上。计划和进度见 `plans/relay.md`，用户的决定记在 memory `relay-decisions`，用法见 `packages/relay/README.md`。已经做好服务、命令行、MCP、桌面客户端（`relay-app` 外壳 + `relay-ui` 界面，界面由服务器下发热更新）和账号密码。**本机已经部署**：`http://172.16.1.62:47120/`，用 `scripts/relay-service.ps1` 启停。更新界面跑 `npm run relay:release`，不用重启服务，在线的客户端会自己更新（窗口没在用、也没有草稿时）；改了服务端代码要 restart。登录页和登录后都会显示服务器状态，断开后自动重连（1c）。10-27：话题、归档、气泡（1d）；阶段 2 方案 `plans/relay-tasks.md`，**2a 完成**：请求变成会话（现在等谁、AI 取回 / 卡住 / 我来处理、需要回复的会话只有发起方能标记完成），界面换成 Studio 的设计（引用 `packages/ui/src/styles/base.css`，深浅色）。**2b（团队任务）、2c（文件）、2d（批注）也已完成**（服务 0.5.0），进度见 `plans/relay-tasks.md`。Mac 打包机部署等用户准备好 SSH。
