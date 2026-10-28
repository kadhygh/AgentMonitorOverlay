# amo-lan-platform：团队里安装、更新、设置 AMO 工具的地方（方案，2026-10-28）

## 起因

用户 10-28 的想法：

- 做一个 amo-lan-platform，里面放各种工具和设置，还能简单地设置工作目录之类的东西。用的人装一次就能快速安装、更新，设好几个目录就能用。
- 以后的升级也都走它，**不去改软件本身**。
- 需要重启之类的升级提示也收进平台里。
- **中转保持现状**：它有自己的界面热更新和桌面程序一键更新，平台不接管。

这份方案取代当天上午那份「AMO 套件」评估（那份要把几个程序合进同一个安装目录，会改动程序本身的打包方式）。

## 以后的开发流程（用户 10-28 定的）

1. 在本机开发和维护 AMO 的各个工具（Studio、Reviewer、便签、中转、平台自己）。
2. 自己确认没问题后，推送到 LAN 服务器：一条命令打包、算清单、只上传变了的文件，写上这次改了什么。
3. 其他人的平台收到「有新版」，看到版本号和改动说明。
4. **怎么更新由每个人自己选**：
   - 每个工具单独设：自动（下载好，空闲时自己换）/ 提醒我（下载好，等我点）/ 手动（只提示有新版，点了才下载）；
   - 也可以跳过这个版本、留在旧版，或者回滚到上一版。
   - 要重启的，平台写清楚原因和现在能不能重启，由人点。

推送方只管发布，不能强制别人更新。只有一种例外：服务器上的中转升级后，旧客户端不兼容了，这时提示「要更新才能继续用」。这本来就是中转现在的做法，不变。

## 平台是什么

一个常驻托盘的小程序「AMO 平台」，连着团队服务器（就是 Mac 上的中转服务）：

| 页面 | 做什么 |
|---|---|
| 工具 | 列出团队发布的工具：AMO Studio（自带便签和 Reviewer）、AMO Reviewer（独立版）、AMO 便签（独立版）、AMO 中转（只给入口和下载，不管它的更新）。每个工具显示：没装 / 已装和版本 / 有新版。按钮有「安装」「打开」「更新」「卸载」 |
| 更新 | 有新版时在这里提示，写清要不要重启、现在能不能重启（比如「Studio 有 2 个会话在跑，停下后再重启」）。下载在后台进行，重启由人点 |
| 目录 | 工具装在哪（默认 `%LOCALAPPDATA%\AMO`，能整体搬走）、Studio 数据目录、便签工作文件夹。Reviewer 等工具的位置平台自己知道，不用人设。改了在下次启动对应工具时生效 |
| 设置 | 服务器地址（最近 3 个，和中转一样）、开机启动、自动下载更新开关、更新通道（稳定 / 测试） |

工具本身不需要知道平台的存在。平台只用工具已经支持的方式和它们打交道：

- **Studio 数据目录**：启动时设 `AMO_STUDIO_DATA_DIR`（`packages/app/src/paths.ts` 已经支持）。这一条很重要：portable 版默认把数据放在 exe 旁边的 `data/`，平台装的版本必须把数据放到程序目录外面，升级才不会碰到数据。
- **便签工作文件夹**：便签自己的 `settings.json`（`%APPDATA%\AMO Notes`）里本来就有 `workFolder`，平台改这个文件，或者以后给便签加一个环境变量。
- **Studio 正在跑几个会话**：读 Studio 数据目录里 Host 的地址和 token，问它的 `/api/health`。只读不改。
- **Reviewer 在哪**：平台把已装工具的位置写进 `%APPDATA%\AMO\programs.json`。中转要用 Reviewer 时读这个文件（这是中转唯一要加的东西，见下面「和中转的关系」）。

常驻托盘（用户 10-28 同意）：不显示时把窗口销毁，只留主进程，内存几十 MB；打开时再建窗口。

## 工具里的更新提示（用户 10-28 定）

更新都由平台管，工具自己不检查、不下载：

- 平台把每个工具的更新状态写进 `%APPDATA%\AMO\updates.json`，包括现在的版本、新版本、改动说明、是否已下载、要不要重启。工具只读这个文件。
- 有设置界面的工具，在「设置」入口旁边亮一个点。设置里加一页「更新」，同样带点，里面写清新版本、改了什么、要不要重启。按钮是「在 AMO 平台里更新」，点了打开平台的更新页；要重启的另有「会话停下后重启」。真正的操作都交给平台。
- 不另占窗口空间：顶栏、主界面都不放更新按钮。
- 没装平台时，「更新」页只写「更新由 AMO 平台管理」和平台的下载地址，设置旁也不出现点。
- 中转例外，它的更新照旧自己管。
- 原型见画布上的「工具里的更新提示」。

## 安装和更新怎么做（不在原地改文件）

```
%LOCALAPPDATA%\AMO\
  platform\                    平台自己
  apps\studio\0.9.3\           每个版本一个完整的文件夹（就是现在的 portable 包）
  apps\studio\0.9.4\
  apps\studio\current  ->      目录联接（junction），指向正在用的版本；快捷方式、固定到任务栏都指它
  apps\reviewer\…
```

- **更新 = 装一个新版本文件夹，再把 `current` 指过去。** 正在跑的程序还在用旧文件夹，不受影响；重启后就是新版。出问题时把 `current` 指回去就能回滚。保留最近 2 个版本。
- **只下载变了的文件**：新版本文件夹先用硬链接把上一版没变的文件「复制」过来（不占空间、瞬间完成），再下载变了的文件。平时一次更新几 MB，Electron 换版本时才是整包。这个比中转现在的「运行中逐个换文件」简单，也不会碰到「Electron 本体变了只能手动重装」的问题。
- **服务器**：每个工具每个版本一份清单（每个文件的路径、大小、sha256），文件按 sha256 存，同一个文件只存一份。发布：本机 `npm run package:portable` 打包，再跑一条 `relay:mac -- publish <工具> [--channel test]`，算清单并只上传服务器上没有的文件。要给中转服务加一个静态目录 `/platform/`（很小的改动），平台的下载页也从这里出。
- **平台自己的更新**：平台的界面像中转一样从服务器热更新；外壳很少变，变了就用同样的版本文件夹方式。

## 和中转的关系

- 中转保持现状：自己更新，不归平台管。平台的「工具」页只放它的入口和下载链接，装了就能从平台打开。
- 中转看文件改用 Reviewer（用户已同意）：读 `%APPDATA%\AMO\programs.json`，有 Studio 就用 `AMO Studio.exe --amo-app=reviewer`，没有就用独立版 Reviewer。都没有时，提示「在 AMO 平台里安装 Reviewer」，并且保留中转自己的文件预览，浏览器用户也用这个。
- 这样 Reviewer 在电脑上只有一份：装了 Studio 就不需要独立版。平台看到 Studio 已装时，「工具」页把独立版 Reviewer 标成「Studio 里已带，可以卸载」。

## 用什么做

建议**平台也用 Electron**，和其他工具同一套技术：

- 可以直接用现成的东西：Studio 的界面样式（`packages/ui`）、中转的热更新和下载代码（`relay-app/src/content.ts`）、服务器地址和最近列表。
- 代价是平台自己又多一份 Electron（约 320 MB）。

另一个做法是用 Windows 自带的 WebView2 写一个几 MB 的小程序。但要引入 C#/Rust 工具链，界面和下载代码也都要重写，不划算。磁盘重复的问题以后可以统一处理：平台装的工具共用一份 Electron 运行时，属于后期优化，不影响前面几步。

## 要注意的

- 团队拿到的 Studio 是你开发中的版本。建议两个通道：稳定（默认）和测试（你自己和愿意尝鲜的人）。发到稳定之前要跑完 e2e。现在「只在发版时打 portable 包」（memory `studio-portable-at-release-only`）就变成「发布到平台」。
- 同事用 Studio 时，Claude 走他们自己的 Claude Code 登录（现在的做法不变）。
- 第一次下载平台的 exe 会被 SmartScreen 拦一下；之后通过平台装的不会。
- 只做 Windows。

## 开工前先整理（10-28 调查的结果）

新架构开工前，先做一轮只动文档和打包脚本的整理，不改功能代码：

进度（10-28）：第 0、1、2 步已完成；第 5 步已完成（`relay-service.ps1` 在 `packages/relay/README.md` 注明是退路，三个 html 用户让删了）；第 3 步放进「服务器发布」；第 4 步已完成（结果写在第 4 条下面）。

0. **项目说明**（已完成）：根目录新增 `AGENTS.md`（Codex 读）和 `CLAUDE.md`（只有一行 `@AGENTS.md`，Claude 读）。内容是工具和包的对应关系、上面这些架构约束、怎么干活。新会话打开就会自动读到。
1. **`HANDOFF.md` 瘦身**：现在 319 行，大部分是 10-17 以来按日期堆的改动记录，新会话读起来很重。改成只留「当前状态 + 最近一两周」，更早的记录挪到 `docs/history/handoff-2026-10.md`（git 里本来也有）。
2. **旧文档归档**：
   - `studio/docs/` 里的 LOOP_LOG（1061 行）、LOOP_RULES、NEEDS_YOU、ROADMAP、STATUS，是 /loop 自动迭代时期的，最后一次更新是 10-23；
   - `plans/stage-1…17` 都已经做完。

   把这两部分挪到 `docs/archive/` 和 `plans/done/`，`studio/README.md` 的「开发者文件导航」也跟着改。`design/` 里 10-13 的架构文档标上「已过时的部分」，或者合进一份新的 `design/architecture.md`，把中转、便签、Reviewer、平台都写进去。
3. **每个工具单独的版本号**：现在所有包都是 0.9.0，`package-portable.mjs` 也只用一个版本号。平台要按工具发布、按工具显示改动说明，所以给每个工具一个版本号和 `CHANGELOG`（或发布时写的 notes）。这一条是第 1 步「服务器发布」的前提，放在那一步里一起做。
4. **数据位置检查**：确认 Studio、Reviewer、便签在设了对应变量（`AMO_STUDIO_DATA_DIR`、`AMO_REVIEWER_HOME`、`AMO_NOTES_HOME`）时，不往程序文件夹里写任何东西。Studio 的 `amo-studio.json` 现在写在 exe 旁边，平台装的版本要避开它。
   - **结果（10-28）**：用 `release/` 里 10-24 的三个 portable 包实测（解压到 `%TEMP%mo-studio-sandbox`，设好变量、测试模式、端口 0，各跑一次再关掉，比对程序文件夹前后的文件清单）：三个程序文件夹都**没有任何新增或改动**，`%APPDATA%` 下的 Electron、AMO Studio / Reviewer / Notes、AMO 也没被碰；数据都进了变量指的目录（Studio：studio.db、host.log、codex、common、electron 等；Reviewer：data、electron；便签：electron）。10-24 之后这几处路径代码没改过。代码上也对得上：Studio 设了 `AMO_STUDIO_DATA_DIR` 就不走首次设置，不写 `amo-studio.json`（`app/src/paths.ts`）；Host 的东西全在数据目录下（`host/src/host-process.ts`）；Reviewer、便签不设变量时也默认在 `%APPDATA%`，只有 Studio 不设变量时会用 exe 旁的 `data/` 和 `amo-studio.json`。所以平台装 Studio 时**必须**设 `AMO_STUDIO_DATA_DIR`，另两个设不设都不会写进程序文件夹。没覆盖到的：没开真实会话、没走 DSH、没用附件，但这些都按 Host 的数据目录走。
5. **顺手清掉**：仓库里没跟踪的 `plans/relay-tasks.html`、`relay-ui-prototype.html`、`token-stats-prototype.html` 由用户决定删还是留；`scripts/relay-service.ps1`（本机跑中转）已经不用了，保留作为退路，在 README 里注明。

暂时不建议动的：
- 把 `studio/` 改名，或者重新拆包：路径到处都在用（worktree、memory、e2e、打包脚本），收益小。
- 拆 1000 行左右的大文件（`relay/src/store.ts`、`ui/src/canvas/CanvasPage.tsx`）：和新架构无关，碰到时再拆。

另外，worktree `AgentMonitorOverlay-review` 现在没有未合并的提交（`studio/review-canvas` 和 `studio/stage3-topics` 都已经在 master 里），文档移动不会和它冲突。但如果其他会话正在别的分支上改 `HANDOFF.md` 或 `plans/`，移动前要先确认。

## 10-28 晚定的推进方式（用户和主会话讨论后定）

- **两种开发方式并存**：
  1. 照旧：脚本启动、随用随改，每个模块可以单独起，完成后可以打 portable；
  2. 脚本启动平台（`start-platform.cmd`，带 `--channel test`），平台装的是测试通道的版本。日常：本机改完 → 发布到测试通道 → 本机平台更新测试版 → 确认没问题 → 转成正式版（`promote`，不重新打包，同事拿到的就是测试过的那批文件）。用户日常的 Studio 也从平台拉起，每次改完发一版测试版，重启也由用户在平台里点。
- **叫「测试通道」不叫「测试模式」**：`AMO_STUDIO_TEST` 等是 e2e 的测试模式，不混用。平台设置里有「更新通道：稳定 / 测试」，启动参数 `--channel test` 效果一样。
- **本机只有一份 Studio 数据目录**：平台第一次拉起 Studio 之前，在「目录」里先设 Studio 数据目录（用户会填现在的 `studio\.data`，源码启动默认也是它）。同一时间只开一份 Studio。Host 发现数据库的迁移版本比自己认识的新时拒绝启动，提示先更新（源码版比测试版新，可能先升级了数据库）。
- **维护终端**：只在源码启动时有，用户从平台拉起时自己开 CLI。维护终端加 Codex：两种终端可选（Claude Code / Codex），都是在工程目录里开用户自己的 CLI。
- **登录只在平台**：账号就是团队服务器（中转服务）的账号。装平台时就要登录。登录代码抽成共用模块，平台用；中转客户端到平台发布时一起改成用平台的登录，不再保留自己的登录页（策划还没装中转，到时直接发平台版）。Studio 不做登录界面，需要登录的功能（以后的远程会话）读平台存的登录，没有就提示「在 AMO 平台里登录」。凭据放 `%APPDATA%\AMO\`，按当前 Windows 用户加密（DPAPI），工具只读，**不通过环境变量传**（Studio 会把环境变量传给 agent 的命令）。
- **测试通道谁能看到**：所有登录的人都能在设置里切换。
- 这次先不管 Codex / Claude Code 的会话记录写在 C 盘用户目录的问题（`~/.codex/sessions` 28 GB、`~/.claude/projects` 1.1 GB）。

## 第一版的接口约定（10-28，各部分并行开发时以这里为准）

**服务器（Mac，`~/Services/amo-relay/platform/`，在 `app/` 外面，deploy 不碰）**

```
platform/
  objects/<sha256 前两位>/<sha256>        文件内容，按 sha256 存，同一个文件只存一份
  tools/<tool>/<version>.json             一个工具一个版本的清单
  channels.json                           { "stable": { "studio": "0.9.0", … }, "test": { "studio": "0.9.1", … } }
```

- 工具 id：`studio`、`reviewer`、`notes`、`platform`。
- 清单：`{ tool, name, version, builtAt, exe, notes, files: [{ path, size, sha256 }] }`，`path` 用 `/` 分隔、相对程序文件夹，`exe` 是程序文件夹里主程序的相对路径（如 `AMO Studio.exe`），`notes` 是这次的改动说明（Markdown）。
- 中转服务加的接口（都要登录，`Authorization: Bearer <key>`）：`GET /api/platform/channels`、`GET /api/platform/tools/<tool>/<version>`、`GET /platform/objects/<sha256>`（也接受 `?key=`）。目录由服务的启动参数或环境变量给，Mac 上是 `$ROOT/platform`。下载页（`/`）加平台的下载：`downloads/AMO-Platform-win.zip`。
- 发布在本机通过 SSH 做，不开 HTTP 写接口：`npm run relay:mac -- publish <tool> [--channel test|stable] [--notes "…"]`（读 `release/<Name>/`，算清单，只上传服务器上没有的文件，写清单，改 `channels.json`；`--notes` 不给时取该工具 `CHANGELOG.md` 里这个版本的一节）；`promote <tool> <version>`（把稳定通道指过去，版本必须已经发布过）；`platform-status`（列出两个通道各工具的版本）。

**版本号**：每个工具的版本在各自包的 `package.json`（Studio = `packages/app`、`packages/reviewer`、`packages/notes`、`packages/platform`），都从 0.9.0 起，以后发布哪个升哪个。改动说明写在各自包的 `CHANGELOG.md`（`## 0.9.1（2026-10-29）` 这样一节一版）。`package-portable.mjs` 按工具取版本，可以只打一个工具。

**本机（平台写，工具读）**

```
%LOCALAPPDATA%\AMO\apps\<tool>\<version>\   一个版本一个完整的程序文件夹
%LOCALAPPDATA%\AMO\apps\<tool>\current      目录联接，指向正在用的版本
%APPDATA%\AMO\platform.json                 平台设置：服务器、最近 3 个服务器、通道、Studio 数据目录、开机启动
%APPDATA%\AMO\programs.json                 { "tools": { "studio": { "version", "dir"（current 的路径）, "exe" }, … } }
%APPDATA%\AMO\account.json                  { server, name, key（DPAPI 加密，base64） }
```

- 新版本：先用硬链接把上一版里 sha256 相同的文件带过来，再下载缺的，校验 sha256，最后把 `current` 指过去。保留最近 2 个版本。
- 拉起 Studio：环境变量 `AMO_STUDIO_DATA_DIR` = 平台设置里的 Studio 数据目录，没设时不让拉起，先去「目录」设。
- Studio 有没有会话在跑：读数据目录里的 `host.json`，问 `GET /api/health`（不要令牌，返回 `{ ok, pid, running }`，`running` 按看板「进行中」算），只读。

**做的时候补定的（10-28 晚，第一版已按这些实现）**

- `GET /api/platform/channels` 直接返回 `channels.json`，没发布过时是 `{"stable":{},"test":{}}`；清单的 `builtAt` 是毫秒数；错误 401 没登录、400 参数不对、404 没有平台目录或还没发布。
- `publish` 不写 `--channel` 时发到测试通道。**稳定通道不会比测试通道旧**：发到稳定或 `promote` 时，测试通道更旧或没有就一起指过去。同一版本号再发布、文件相同时只改通道，文件不同时拒绝（先升版本号）。
- 工具 id 服务端按通用格式校验，不写死名字；能不能发布由 `scripts/amo-tools.mjs` 的 `platform: true` 决定（中转是 false）。平台自己也是一行（`AMO Platform`）。
- `programs.json` 的 `exe` 是相对 `dir` 的路径，读的人用 `join(dir, exe)`。
- 测试和开发用的变量：`AMO_HOME`（代替 `%APPDATA%\AMO`）、`AMO_LOCAL_HOME`（代替 `%LOCALAPPDATA%\AMO`）、`AMO_PLATFORM_UI_DIR`、`AMO_PLATFORM_TEST=1`（e2e 的测试模式）。以后中转、Studio 读 `account.json`、`programs.json` 也认 `AMO_HOME`。
- 平台的 Chromium 配置在 `%LOCALAPPDATA%\AMO\platform-profile`；每个已装版本的记录在 `apps\<tool>\<version>.json`（在程序文件夹外面）。
- 平台第一次下载用的 zip：服务先找 `<平台目录>/downloads/AMO-Platform-win.zip`（deploy 不碰），再找客户端的 `downloads/`。还没有命令负责放这个 zip，第一次发布平台时定。

## 进度

- **10-28 晚 · 第一版（第 1、2 步）合进 master**：每个工具单独的版本号和 `CHANGELOG.md`；中转服务的平台接口和 `publish` / `promote` / `platform-status`（含 `--target-dir` 本地模式）；共用登录模块 `packages/account`；平台 `packages/platform` + 界面 `packages/ui/src/platform`（登录、工具、目录、设置）；`start-platform.cmd`（`-Test` 用测试通道）。另有 Host 的数据库版本保护、`/api/health` 带 `running`、维护终端加 Codex。验证见 `HANDOFF.md` 10-28 那条。
- 还没做：部署到 Mac（会重启一次中转）和第一次真实发布；平台 zip 怎么放上服务器；第 3 步（更新页、`updates.json`、各工具的设置旁的点、目录页的便签工作文件夹、托盘上的新版提示）；第 4 步；平台自己的图标（家族方案在 `design/icon/platform/`，等用户定）；打包后的开机启动应指向 `current` 而不是某个版本文件夹（现在注册的是 `process.execPath`）。

## 分几步

1. **服务器发布**：每个工具单独的版本号（上面第 3 条）、版本清单格式（带改动说明）、`relay:mac -- publish <工具> --notes "…"`、中转服务的 `/platform/` 静态目录、下载页加「AMO 平台」。
2. **平台 v1**：托盘 + 「工具」和「设置」两页，能安装、打开、更新、回滚 Studio / Reviewer / 便签，服务器地址带最近列表，写 `programs.json`。
3. **更新提示和目录**：
   - 平台的「更新」页：会话在跑时等着；
   - 平台的「目录」页：工具装在哪、Studio 数据目录、便签工作文件夹；
   - 平台写 `updates.json`；Studio、Reviewer、便签读它，在设置旁亮点，设置里加「更新」页。
4. **中转改用 Reviewer**：读 `programs.json`，批注「发回会话」。
5. 以后再考虑：共用 Electron 运行时、平台界面里的更多团队设置。

界面原型（10-28，示例数据）：https://claude.ai/artifact/Uu4fL3bXZg1NZHXDSKBPc9 ，有主窗口四页（可点）、托盘菜单、工具里的更新提示。用户看过再做第 2 步。
