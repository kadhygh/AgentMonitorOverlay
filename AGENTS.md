# AMO 项目说明（给在这个仓库里工作的 AI 会话）

每个新会话都会先读这份。它只写长期有效的事：项目由什么组成、架构上的约束、怎么干活。进度和历史不写在这里：当前状态看 `studio/HANDOFF.md`，具体计划看 `studio/plans/`。

## 这是什么

AMO 是一组给「有 AI 参与的项目」用的 Windows 桌面工具。代码全在 `studio/` 下，是一个 npm workspace。`master` 就是主线。

| 工具 | 是什么 | 主要的包 |
|---|---|---|
| AMO Studio | 工作台：看板、任务、和模型的会话（Codex / Claude / DeepSeek）、画布 | `app`（Electron 主进程）、`host`（常驻后台，会话都在里面）、`protocol`（共用类型和接口）、`ui`（全部界面） |
| AMO Reviewer | Git Review 和查看器（含 HTML 批注），可以单独用，Studio 里也带着 | `reviewer`（独立程序的入口），界面在 `ui/src/gitreview` 等，后台用 `host` |
| AMO 便签 | 托盘常驻的随手记，可以单独用，Studio 会顺带启动它 | `notes` |
| AMO 中转（Relay） | 局域网服务 + 桌面客户端：策划的 AI 把要确认的事发给程序，人和人聊天 | `relay`（服务、命令行、MCP）、`relay-ui`（客户端界面，从服务器热更新）、`relay-app`（客户端外壳） |
| AMO 平台（规划中） | 托盘常驻：从团队服务器安装、更新、设置上面这些工具 | 还没有，方案见 `studio/plans/amo-lan-platform.md` |

`testkit` 是测试用的假服务器和工具。团队服务器是一台 Mac mini（`http://172.16.8.85:47120/`，SSH 别名 `mac`），上面跑着中转服务，以后也是平台的发布点。

## 架构约束（2026-10-28 定，新功能不要违反）

用户定的方向：在本机开发 → 确认没问题 → 推送到团队服务器 → 其他人自己选怎么更新。为了让这条路走得通：

1. **工具不依赖平台**。不装平台也必须能单独运行（需要登录的功能除外，见第 7 条）。平台只通过工具已经支持的方式和它们打交道：环境变量、启动参数、工具自己的设置文件、只读的健康检查接口，以及平台在 `%APPDATA%\AMO\` 下写、工具只读的几个文件（`programs.json`、`updates.json`、`account.json`，还有平台的设置 `platform.json`：Studio 从里面读数据目录 `studioDataDir`）。例外是本机的设备号 `device.json`（`packages/account/src/device.ts`）：平台或 Studio、便签谁先用到谁创建，之后共用。不要为平台去改工具的内部逻辑。
2. **数据不放在程序文件夹里**。平台按版本给每个工具一个文件夹，升级就是换一个文件夹。所以数据、设置、日志都要放在程序文件夹外面：比如 `%APPDATA%\AMO …`，或者数据目录由 `AMO_STUDIO_DATA_DIR` 这类变量指定。不要新增「写在 exe 旁边」的东西。portable 版现在默认把数据放在 exe 旁边的 `data/`，平台装的版本会用变量改掉这一点，不要再加类似的默认。
3. **更新只由平台做**。工具自己不检查、不下载、不安装更新。平台把更新状态写进 `%APPDATA%\AMO\updates.json`，工具只读它，然后在「设置」入口旁亮一个点，设置里有一页「更新」，操作交给平台。不要在顶栏或主界面另占地方放更新按钮。**中转**（2026-10-28 晚改）：也从平台安装和更新外壳；它的界面内容照旧由服务器热更新。平台装的中转不做自己的「一键更新外壳」（它会改写程序文件夹里的文件，而平台装的工具共用硬链接的 Electron 文件）。
4. **Reviewer 只有一份**。别的程序要用 Reviewer 时，去找已经装好的那份（Studio 里带的，或者独立版），不要自己再打包一份。中转以后通过 `%APPDATA%\AMO\programs.json` 找它。
5. **每个工具有自己的版本号和改动说明**（各自包的 `package.json` 和 `CHANGELOG.md`），发布时写清这次改了什么，平台会显示给用户。
6. **重启要由人点**。尤其是 Studio：重启 Host 会打断正在跑的会话。任何更新或修改都不能在有会话运行时自己重启 Host。
7. **登录只在平台**（2026-10-28 定）。账号是团队服务器的账号，登录界面只有平台有，登录代码是共用模块，不要在别的工具里再做一套。需要登录的功能（中转、以后的远程会话）读平台存的 `%APPDATA%\AMO\account.json`（按当前 Windows 用户加密），没有就提示「在 AMO 平台里登录」。登录凭据**不通过环境变量传**：Studio 会把环境变量传给 agent 跑的命令；也不明文写进 agent 读得到的设置文件（中转给 AI 用的 `settings.json` 只记「用平台的账号」，用时从 `account.json` 解密，2026-11-04）。过渡例外：手动解压、没装平台的中转客户端还留着自己的登录框（平台装的只显示「在 AMO 平台里登录」），所有人换到平台后再删。

## 怎么干活

- 用中文和用户交流。界面文字也是中文，用户看得到的写法要具体、直白。
- **用户要求才提交、推送**，提交信息照最近几条的风格写。不要自己合并或删除别人的分支和 worktree。
  - 例外（2026-10-31 用户定，维护节奏见 `studio/plans/release.md`），只限这两条车道：
    - **维护值守**（提示词模板「问题页值守」）：在值守目录 `G:\PROJECT\AgentMonitorOverlay-duty`（master 的 detached worktree）里修问题页上的小问题，验证通过后自己提交，`npm run release -- land` 合进 master。测试包不用它打：挂在它下面的值守项「自动打包」不开模型，在打包目录 `G:\PROJECT\AgentMonitorOverlay-release` 里跑 `release.mjs auto --if-due`（改动放够 30 分钟、或人点了「发布打包」就发，修好的问题自己标已发布）；没成功时值守去查。大的先在问题里写清楚打算怎么做，标「需要确认」，和人谈定再做（人点了「前往讨论」的问题值守不碰）；合不进、验证不过就停下，标「卡住了」。
    - **维护迭代**（当天维护任务里的会话，模板「维护迭代」）：在主工作区改，只 add 自己改的文件，验证通过就自己提交到 master，写 CHANGELOG「下一版」；不打包、不发布。
- 代码风格跟周围保持一致；注释写「为什么」，可以带日期和用户的决定。仓库里是长行，**不要跑 prettier**（没有配置，它会把文件改成 80 列）。
- 跑重的任务（vitest、e2e、打包）用低优先级：`BelowNormal`，加 `--maxWorkers=6`。普通优先级会让用户的桌面卡。
- 常用命令（在 `studio/` 下）：
  - `npm run verify`：类型检查、单测、构建；
  - `npm run e2e`：e2e 按程序分成几个 Playwright project：`studio`、`notes`、`reviewer`、`relay`、`platform`；
  - `npm run package:portable`：打 portable 包；
  - 发布都走 `npm run release`（`scripts/release.mjs` 开头有全部用法）：`status` 看各工具和两个通道；`<工具…>` 或 `auto` 发到平台的测试通道（跑测试、升版本、「下一版」改成版本标题、提交进 master、打包、发布、打 tag `<工具>-v<版本>`）；`relay-service` 部署中转服务（会重启中转几秒；服务器上只有一份，**不要绕过它直接 deploy 没提交的中转改动**，下一次部署会把它冲掉）；`promote <工具> <版本>` 转正式版。只从提交过的 master 打包：主工作区有没提交的改动时到值守目录里发。改动说明先写进各包 `CHANGELOG.md` 的「## 下一版」，没写的不发。工具 id 见 `studio/scripts/amo-tools.mjs`。
  - `relay:release`、`relay:mac -- deploy | publish`、`package:platform` 是 `release` 调用的底层步骤，只在排查时单独用。每次发布（底层是 `relay:mac -- publish`）之后会自动删这个工具的旧版本（留最新 3 个和两个通道指向的，`--keep-all` 不删），`platform-prune [--dry-run]` 对所有工具清理。
- **不要擅自重启用户正在用的 Studio**（`host:stop` 会杀掉进行中的会话）。要重启先问，而且只在没有会话运行时做。
- 改了界面就截图看一遍。e2e 的截图放在 `studio/screenshots/<程序>/`。
- 计划和方案写在 `studio/plans/<主题>.md`。做完一段，在 `studio/HANDOFF.md`「最近的改动」最上面加一条（做了什么、怎么验证的、还剩什么），「当前状态」里过时的也顺手改掉；超过一两周的记录挪进 `studio/docs/history/`。
- 在 Windows 上用 shell 改含中文的文件容易出乱码，用编辑工具改。

## 文档在哪

| 位置 | 内容 |
|---|---|
| `studio/HANDOFF.md` | 当前状态和最近的改动，新会话先读 |
| `studio/plans/` | 各个主题的方案和进度；`amo-lan-platform.md` 是平台方案；做完的阶段计划在 `plans/done/` |
| `studio/docs/history/`、`studio/docs/archive/` | 瘦身前的 HANDOFF 原文；/loop 时期的 STATUS、ROADMAP 等（只查历史时看） |
| `studio/packages/relay/README.md` | 中转的部署、发布、命令 |
| `studio/README.md`、根目录 `README.md` | 给用户看的介绍 |
| `studio/design/` | 早期架构文档（2026-10-13，部分已过时） |
