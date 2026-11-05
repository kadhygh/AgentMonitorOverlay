# amo-lan-platform：团队里安装、更新、设置 AMO 工具的地方（2026-10-28）

> 状态：进行中（长期有效的平台方案，`AGENTS.md` 引用它）。做了：第 1、2 步（每个工具的版本号和 CHANGELOG、服务器发布、平台 v1，10-28 合进 master）、共用 Electron、装在平台所在的文件夹、环境页、平台自更新、下载页的平台 zip、更新记录（2026-11-06，AMO 平台 0.9.25）。还剩：第 3 步里工具那一侧（平台写 `updates.json`，Studio、Reviewer、便签在设置旁亮点、设置里加「更新」页）和平台的「更新」页（每个工具的更新方式、跳过版本）；第 4 步中转改用 Reviewer；目录页的便签工作文件夹（现在目录页写的是「Reviewer 和便签放在哪，平台自己知道」，拿不准是不是不做了）。11-03 的「用完整包更新」还没在用户机器上真点过。进度流水（「进度」一节、开工前整理的逐步记录、实测过程）2026-11-06 删掉了，原文见 git 历史（提交 f46907f2 之前的版本）。

## 起因

用户 10-28 的想法：

- 做一个 amo-lan-platform，里面放各种工具和设置，还能简单地设置工作目录之类的东西。用的人装一次就能快速安装、更新，设好几个目录就能用。
- 以后的升级也都走它，**不去改软件本身**。
- 需要重启之类的升级提示也收进平台里。
- ~~**中转保持现状**：它有自己的界面热更新和桌面程序一键更新，平台不接管。~~（10-28 晚改：中转的外壳也从平台安装和更新，界面内容照旧由服务器热更新；平台装的中转不做自己的「一键更新外壳」。见 `AGENTS.md` 架构约束第 3 条。）

这份方案取代当天上午那份「AMO 套件」评估（那份要把几个程序合进同一个安装目录，会改动程序本身的打包方式）。

## 以后的开发流程（用户 10-28 定的）

1. 在本机开发和维护 AMO 的各个工具（Studio、Reviewer、便签、中转、平台自己）。
2. 自己确认没问题后，推送到 LAN 服务器：一条命令打包、算清单、只上传变了的文件，写上这次改了什么（现在是 `npm run release`，见 `plans/release.md`）。
3. 其他人的平台收到「有新版」，看到版本号和改动说明。
4. **怎么更新由每个人自己选**：
   - 每个工具单独设：自动（下载好，空闲时自己换）/ 提醒我（下载好，等我点）/ 手动（只提示有新版，点了才下载）；
   - 也可以跳过这个版本、留在旧版，或者回滚到上一版。
   - 要重启的，平台写清楚原因和现在能不能重启，由人点。

推送方只管发布，不能强制别人更新。只有一种例外：服务器上的中转升级后，旧客户端不兼容了，这时提示「要更新才能继续用」。

## 平台是什么

一个常驻托盘的小程序「AMO 平台」，连着团队服务器（就是 Mac 上的中转服务）。原定的页面（现在的平台是 工具 / 环境 / 目录 / 设置，加上底部的账号；「更新」页还没做）：

| 页面 | 做什么 |
|---|---|
| 工具 | 列出团队发布的工具：AMO Studio（自带便签和 Reviewer）、AMO Reviewer（独立版）、AMO 便签（独立版）、AMO 中转。每个工具显示：没装 / 已装和版本 / 有新版。按钮有「安装」「打开」「更新」「卸载」 |
| 更新 | 有新版时在这里提示，写清要不要重启、现在能不能重启（比如「Studio 有 2 个会话在跑，停下后再重启」）。下载在后台进行，重启由人点 |
| 目录 | 工具装在哪（能整体搬走）、Studio 数据目录、便签工作文件夹。Reviewer 等工具的位置平台自己知道，不用人设。改了在下次启动对应工具时生效 |
| 设置 | 服务器地址（最近 3 个，和中转一样）、开机启动、自动下载更新开关、更新通道（稳定 / 测试） |

工具本身不需要知道平台的存在。平台只用工具已经支持的方式和它们打交道：

- **Studio 数据目录**：启动时设 `AMO_STUDIO_DATA_DIR`（`packages/app/src/paths.ts`）。这一条很重要：portable 版默认把数据放在 exe 旁边的 `data/`，平台装的版本必须把数据放到程序目录外面，升级才不会碰到数据。
- **便签工作文件夹**：便签自己的 `settings.json`（`%APPDATA%\AMO Notes`）里本来就有 `workFolder`，平台改这个文件，或者以后给便签加一个环境变量。
- **Studio 正在跑几个会话**：读 Studio 数据目录里 Host 的地址，问它的 `/api/health`。只读不改。
- **Reviewer 在哪**：平台把已装工具的位置写进 `%APPDATA%\AMO\programs.json`。

常驻托盘（用户 10-28 同意）：不显示时把窗口销毁，只留主进程，内存几十 MB；打开时再建窗口。

## 工具里的更新提示（用户 10-28 定，还没做）

更新都由平台管，工具自己不检查、不下载：

- 平台把每个工具的更新状态写进 `%APPDATA%\AMO\updates.json`，包括现在的版本、新版本、改动说明、是否已下载、要不要重启。工具只读这个文件。
- 有设置界面的工具，在「设置」入口旁边亮一个点。设置里加一页「更新」，同样带点，里面写清新版本、改了什么、要不要重启。按钮是「在 AMO 平台里更新」，点了打开平台的更新页；要重启的另有「会话停下后重启」。真正的操作都交给平台。
- 不另占窗口空间：顶栏、主界面都不放更新按钮。
- 没装平台时，「更新」页只写「更新由 AMO 平台管理」和平台的下载地址，设置旁也不出现点。
- 原型见画布上的「工具里的更新提示」。

## 安装和更新怎么做（不在原地改文件）

- **更新 = 装一个新版本文件夹，再把 `current` 指过去。** 每个版本一个完整的程序文件夹，`current` 是目录联接（junction），指向正在用的版本。正在跑的程序还在用旧文件夹，不受影响；重启后就是新版。出问题时把 `current` 指回去就能回滚。保留最近 2 个版本。放在哪见下面「装在平台所在的文件夹里」。
- **只下载变了的文件**：新版本文件夹先用硬链接把已有的相同文件「复制」过来（不占空间、瞬间完成），再下载变了的文件。这个比中转原来的「运行中逐个换文件」简单，也不会碰到「Electron 本体变了只能手动重装」的问题。
- **服务器**：每个工具每个版本一份清单（每个文件的路径、大小、sha256），文件按 sha256 存，同一个文件只存一份。发布时算清单，只上传服务器上没有的文件。
- **平台自己的更新**：平台的新版本也装成版本文件夹，提示「重启平台」；同事只下载一次平台（用户 10-28）。

## 和中转的关系

- 中转的外壳由平台安装和更新（10-28 晚改，见「起因」）；界面内容照旧从服务器热更新。
- 中转看文件改用 Reviewer（用户已同意，第 4 步，还没做）：读 `%APPDATA%\AMO\programs.json`，有 Studio 就用 `AMO Studio.exe --amo-app=reviewer`，没有就用独立版 Reviewer。都没有时，提示「在 AMO 平台里安装 Reviewer」，并且保留中转自己的文件预览，浏览器用户也用这个。
- 这样 Reviewer 在电脑上只有一份：装了 Studio 就不需要独立版。平台看到 Studio 已装时，「工具」页把独立版 Reviewer 标成「Studio 里已带，可以卸载」。

## 用什么做

**平台也用 Electron**，和其他工具同一套技术：

- 可以直接用现成的东西：Studio 的界面样式（`packages/ui`）、中转的热更新和下载代码（`relay-app/src/content.ts`）、服务器地址和最近列表。
- 代价是平台自己又多一份 Electron，后来用「共用 Electron」解决（见下面）。

另一个做法是用 Windows 自带的 WebView2 写一个几 MB 的小程序。但要引入 C#/Rust 工具链，界面和下载代码也都要重写，不划算。

## 要注意的

- 团队拿到的 Studio 是开发中的版本，所以分两个通道：稳定（默认）和测试（自己和愿意尝鲜的人）。发到稳定之前要跑完 e2e。原来的「只在发版时打 portable 包」（memory `studio-portable-at-release-only`）变成「发布到平台」。
- 同事用 Studio 时，Claude 走他们自己的 Claude Code 登录。
- 第一次下载平台的 exe 会被 SmartScreen 拦一下；之后通过平台装的不会。
- 只做 Windows。

## 开工前的整理（10-28）

新架构开工前先做了一轮只动文档和打包脚本的整理：根目录的 `AGENTS.md` / `CLAUDE.md`、`HANDOFF.md` 瘦身（旧记录进 `docs/history/`）、/loop 时期的文档进 `docs/archive/`、做完的阶段计划进 `plans/done/`、每个工具单独的版本号。

**数据位置的结论**（10-28 用 portable 包实测，代码也对得上）：Studio 设了 `AMO_STUDIO_DATA_DIR` 就不走首次设置，不写 exe 旁的 `amo-studio.json`（`app/src/paths.ts`），Host 的东西全在数据目录下（`host/src/host-process.ts`）；Reviewer、便签不设变量时也默认在 `%APPDATA%`（`AMO_REVIEWER_HOME`、`AMO_NOTES_HOME` 可改）。只有 Studio 不设变量时会用 exe 旁的 `data/` 和 `amo-studio.json`，所以平台装 Studio 时**必须**设 `AMO_STUDIO_DATA_DIR`。没覆盖到的：真实会话、DSH、附件，但这些都按 Host 的数据目录走。

`scripts/relay-service.ps1`（本机跑中转）已经不用了，保留作为退路，在 `packages/relay/README.md` 里注明。

暂时不建议动的：

- 把 `studio/` 改名，或者重新拆包：路径到处都在用（worktree、memory、e2e、打包脚本），收益小。
- 拆 1000 行左右的大文件（`relay/src/store.ts`、`ui/src/canvas/CanvasPage.tsx`）：和新架构无关，碰到时再拆。

## 10-28 晚定的推进方式（用户和主会话讨论后定）

- **两种开发方式并存**：
  1. 照旧：脚本启动、随用随改，每个模块可以单独起，完成后可以打 portable；
  2. 脚本启动平台（`start-platform.cmd`，带 `--channel test`），平台装的是测试通道的版本。日常：本机改完 → 发布到测试通道 → 本机平台更新测试版 → 确认没问题 → 转成正式版（`promote`，不重新打包，同事拿到的就是测试过的那批文件）。用户日常的 Studio 也从平台拉起，每次改完发一版测试版，重启也由用户在平台里点。
- **叫「测试通道」不叫「测试模式」**：`AMO_STUDIO_TEST` 等是 e2e 的测试模式，不混用。平台设置里有「更新通道：稳定 / 测试」，启动参数 `--channel test` 效果一样。
- **本机只有一份 Studio 数据目录**：平台第一次拉起 Studio 之前，在「目录」里先设 Studio 数据目录（用户会填现在的 `studio\.data`，源码启动默认也是它）。同一时间只开一份 Studio。Host 发现数据库的迁移版本比自己认识的新时拒绝启动，提示先更新（源码版比测试版新，可能先升级了数据库）。
- **维护终端**：只在源码启动时有，用户从平台拉起时自己开 CLI。维护终端加 Codex：两种终端可选（Claude Code / Codex），都是在工程目录里开用户自己的 CLI。
- **登录只在平台**：账号就是团队服务器（中转服务）的账号。装平台时就要登录。登录代码抽成共用模块（`packages/account`），平台用；中转客户端到平台发布时一起改成用平台的登录，不再保留自己的登录页。Studio 不做登录界面，需要登录的功能（远程会话）读平台存的登录，没有就提示「在 AMO 平台里登录」。凭据放 `%APPDATA%\AMO\`，按当前 Windows 用户加密（DPAPI），工具只读，**不通过环境变量传**（Studio 会把环境变量传给 agent 的命令）。
- **测试通道谁能看到**：所有登录的人都能在设置里切换。
- 这次先不管 Codex / Claude Code 的会话记录写在 C 盘用户目录的问题（`~/.codex/sessions` 28 GB、`~/.claude/projects` 1.1 GB）。
- **之后的顺序**（10-28 夜，用户定）：共用 Electron → 环境页 → 平台自更新（都做了）。环境页检测 Claude Code、DSH 桌面版（https://www.deepseek.com/harness/ ）、Codex、git，没装给官方下载链接，不替人安装；11-03 起 Claude Code 和 Codex 可以在环境页安装、更新（`plans/done/claude-code-mirror.md`）。
- **平台不建开始菜单快捷方式**：从平台装的工具从平台启动（用户 10-28）。

## 接口约定（10-28 第一版，之后补的写在各条里）

**服务器（Mac，`~/Services/amo-relay/platform/`，在 `app/` 外面，deploy 不碰）**

```
platform/
  objects/<sha256 前两位>/<sha256>[.gz]   文件内容，按 sha256 存，同一个文件只存一份
  tools/<tool>/<version>.json             一个工具一个版本的清单
  channels.json                           { "stable": { "studio": "0.9.0", … }, "test": { "studio": "0.9.1", … } }
  downloads/AMO-Platform-win.zip          只在还没发布过平台时用（见下面）
```

- 工具 id：`studio`、`reviewer`、`notes`、`platform`、`relay`（中转的外壳，10-28 晚加进来）。服务端按通用格式校验 id，不写死名字；能不能发布由 `scripts/amo-tools.mjs` 的 `platform: true` 决定。
- 清单：`{ tool, name, version, builtAt, exe, notes, files: [{ path, size, sha256 }] }`，`path` 用 `/` 分隔、相对程序文件夹，`exe` 是程序文件夹里主程序的相对路径（如 `AMO Studio.exe`），`notes` 是这次的改动说明（Markdown），`builtAt` 是毫秒数。可选的 `runtime`（Electron 版本）。2026-11-06 加 `history`：`[{ version, date, notes }]`，这个工具 `CHANGELOG.md` 里到这一版为止所有已发布的版本（不含「下一版」），新的在前，发布时生成；平台的「更新记录」用它。放在清单里而不是单独一个文件：通道指着的清单不会被清理，它只含这个通道已经到的版本，中转服务的 `…/summary` 原样带出，服务不用改。之前发的清单没有它，平台退回各版本自己的 `notes`。
- 中转服务加的接口（都要登录，`Authorization: Bearer <key>`）：`GET /api/platform/channels`（直接返回 `channels.json`，没发布过时是 `{"stable":{},"test":{}}`）、`GET /api/platform/tools/<tool>/<version>`、`GET /platform/objects/<sha256>`（也接受 `?key=`）。错误 401 没登录、400 参数不对、404 没有平台目录或还没发布。目录由服务的启动参数或环境变量给，Mac 上是 `$ROOT/platform`。
- 发布在本机通过 SSH 做，不开 HTTP 写接口：`relay:mac -- publish <tool> [--channel test|stable] [--notes "…"]`（读打好的程序文件夹，算清单，只上传服务器上没有的文件，写清单，改 `channels.json`；`--notes` 不给时取该工具 `CHANGELOG.md` 里这个版本的一节）；`promote <tool> <version>`（把稳定通道指过去，版本必须已经发布过）；`platform-status`。平时都经 `npm run release` 调它们。
- `publish` 不写 `--channel` 时发到测试通道。**稳定通道不会比测试通道旧**：发到稳定或 `promote` 时，测试通道更旧或没有就一起指过去。同一版本号再发布、文件相同时只改通道，文件不同时拒绝（先升版本号）。
- 服务器每个工具留最近 3 个版本加两个通道指向的（`b2aca32`，publish 后自动清理，`platform-prune`）。
- **压缩存放（10-28 晚）**：object 存成 `<sha256>` 或 `<sha256>.gz`，sha256 永远是原文件的；gzip 后小于原大小 90% 才存 `.gz`，两种都有时服务优先用 `.gz`。发布问「缺哪些」时两种名字都算已有，上传的 `.gz` 在服务器端解压核对 sha256。`GET /platform/objects/<sha256>`：有 `.gz` 且请求接受 gzip 就发 `.gz`（`Content-Encoding: gzip`）；不接受就边解压边发原文；客户端拿到的永远是原文，按清单的 size 和 sha256 校验。`relay-mac.mjs platform-compress` 把原样存放的压成 `.gz`（原子替换，服务运行时也能跑，能重复跑）。**先部署新服务再压缩**，旧服务不认 `.gz`。
- **下载页的平台 zip**：2026-11-03 起由最新发布的平台现做（`relay/src/platform-zip.ts`），每次发布平台就跟着更新；`downloads/AMO-Platform-win.zip`（手放的）只在还没发布过平台时用。

**版本号**：每个工具的版本在各自包的 `package.json`（Studio = `packages/app`、`packages/reviewer`、`packages/notes`、`packages/platform`、中转外壳 `packages/relay-app`），以后发布哪个升哪个。改动说明写在各自包的 `CHANGELOG.md`（`## 0.9.1（2026-10-29）` 这样一节一版）。`package-portable.mjs` 按工具取版本，可以只打一个工具。

**本机（平台写，工具读）**

```
<平台的文件夹>\apps\<tool>\<version>\     一个版本一个完整的程序文件夹
<平台的文件夹>\apps\<tool>\current        目录联接，指向正在用的版本
<平台的文件夹>\apps\<tool>\<version>.json 每个已装版本的记录（在程序文件夹外面）
%APPDATA%\AMO\platform.json               平台设置：服务器、最近 3 个服务器、通道、Studio 数据目录（studioDataDir）、开机启动、root
%APPDATA%\AMO\programs.json               { "tools": { "studio": { "version", "dir"（current 的路径）, "exe" }, … } }
%APPDATA%\AMO\account.json                { server, name, key（DPAPI 加密，base64） }
%LOCALAPPDATA%\AMO\                       平台的 Chromium 配置（platform-profile）和单实例锁
```

- 新版本：先用硬链接把已有的、sha256 相同的文件带过来，再下载缺的，校验 sha256，最后把 `current` 指过去。保留最近 2 个版本。
- `programs.json` 的 `exe` 是相对 `dir` 的路径，读的人用 `join(dir, exe)`。
- 拉起 Studio：环境变量 `AMO_STUDIO_DATA_DIR` = 平台设置里的 Studio 数据目录，没设时不让拉起，先去「目录」设。
- Studio 有没有会话在跑：读数据目录里的 `host.json`，问 `GET /api/health`（不要令牌，返回 `{ ok, pid, running }`，`running` 按看板「进行中」算），只读。
- 测试和开发用的变量：`AMO_HOME`（代替 `%APPDATA%\AMO`）、`AMO_LOCAL_HOME`（代替平台的根目录）、`AMO_PLATFORM_UI_DIR`、`AMO_PLATFORM_TEST=1`（e2e 的测试模式）。中转、Studio 读 `account.json`、`programs.json` 也认 `AMO_HOME`。
- **装在平台所在的文件夹里（10-28 深夜，`cb35829`，取代原来的 `%LOCALAPPDATA%\AMO\apps`）**：根目录 = 用户解压平台的文件夹，工具和平台自己的新版本都在 `<根目录>\apps\<工具>\<版本>` 加 `current`；`file-index.json`、`platform-entry.json` 在 `apps\` 下。外面的 `AMO Platform.exe` 启动时先看 `apps\platform\current`，有更新的就转过去；平台从 `apps` 里运行时把外面那套文件换成新版（只换内容变了的，挪到暂存目录再换，不碰 `apps`，不原地改写硬链接的文件）。`platform.json` 记 `root`。根目录不能写时提示移走整个文件夹，网络盘、可移动盘只提示。开机启动注册的是外面这个 `AMO Platform.exe`（它自己会转到新版本）。
- **工具从真实版本文件夹启动，不走 `current`（10-28 夜查过，不改）**：从 `current` 启动时切换联接本身没问题，但 Electron 按 exe 的路径找自己的文件，切换后还在跑的旧版会读到新版的文件（Ctrl+R 加载新界面配旧 Host、按需加载的模块变成新版），所以照旧从版本文件夹启动。代价：固定到任务栏的工具，旧版本被清掉后固定项失效，要重新固定；数据目录不受影响（`8be9e9e`）。

## 共用 Electron（10-28 晚用户要做，做了，`1d2f264`）

起因：每个工具解压后 340–400 MB，其中 321 MB 是 Electron（exe 本体 235 MB），我们自己的代码只有 17–74 MB。

做法（不改工具本身）：**同一个 Electron 版本的文件在本机只存一份，各工具的程序文件夹用硬链接指向它**。

- 各工具的 exe 原来不一样，只因为打包时用 rcedit 给每个 exe 写了自己的图标和版本信息，其余 Electron 文件逐字节相同。所以发到平台的包用 `npm run package:platform -- --only <工具>` 打（产物在 `release/platform/<Name>/`），exe 只改名不写图标，所有工具的 Electron 文件 sha256 相同。portable zip（不装平台单独用）照旧 `npm run package:portable`，给每个 exe 写自己的图标，约束第 1 条不变。
- 程序文件夹的 `resources/app/package.json` 带 `amoBuild: { mode: "platform" | "portable", runtime }`，publish 只收 `platform` 模式的。
- 安装引擎按 sha256 从**本机所有已装工具和版本**里找相同文件硬链接（索引 `apps\file-index.json`，只是缓存，可以删），找不到才下载。10-28 实测：先装 Studio 再装便签，便签只下 3 个文件，两个工具实际占 372 MB（不共用是 714 MB）。
- 程序文件夹的样子和 portable 版完全一样（exe 名字照旧，只是硬链接；`resources/app` 是各自的），所以工具代码一行不改，任务管理器里的进程名也照旧各是各的。
- 代价：资源管理器里这些 exe 文件的图标都一样；窗口和托盘的图标是程序自己设的，不受影响。Studio 没设 AppUserModelID，任务栏按 exe 路径分组，不会和别的工具归成一组，没补。
- 要不要做成真正独立的「运行时」包，看这一步的效果再说。

## 分几步

1. **服务器发布**（做了）：每个工具单独的版本号和 CHANGELOG、版本清单、publish / promote、中转服务的平台接口、下载页加「AMO 平台」。
2. **平台 v1**（做了）：托盘 + 工具、目录、设置、账号，能安装、打开、更新、回滚，服务器地址带最近列表，写 `programs.json`。
3. **更新提示和目录**：
   - 平台的「更新」页：会话在跑时等着（没做）；
   - 平台的「目录」页：工具装在哪、Studio 数据目录（做了）、便签工作文件夹（没做）；
   - 平台写 `updates.json`；Studio、Reviewer、便签读它，在设置旁亮点，设置里加「更新」页（没做）。
4. **中转改用 Reviewer**：读 `programs.json`，批注「发回会话」（没做）。
5. 以后再考虑：平台界面里的更多团队设置。

界面原型（10-28，示例数据）：https://claude.ai/artifact/Uu4fL3bXZg1NZHXDSKBPc9 ，有主窗口四页（可点）、托盘菜单、工具里的更新提示。
