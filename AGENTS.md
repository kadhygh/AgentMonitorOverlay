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

1. **工具不依赖平台**。不装平台也必须能单独运行。平台只通过工具已经支持的方式和它们打交道：环境变量、启动参数、工具自己的设置文件、只读的健康检查接口。不要为平台去改工具的内部逻辑。
2. **数据不放在程序文件夹里**。平台按版本给每个工具一个文件夹，升级就是换一个文件夹。所以数据、设置、日志都要放在程序文件夹外面：比如 `%APPDATA%\AMO …`，或者数据目录由 `AMO_STUDIO_DATA_DIR` 这类变量指定。不要新增「写在 exe 旁边」的东西。portable 版现在默认把数据放在 exe 旁边的 `data/`，平台装的版本会用变量改掉这一点，不要再加类似的默认。
3. **更新只由平台做**。工具自己不检查、不下载、不安装更新。平台把更新状态写进 `%APPDATA%\AMO\updates.json`，工具只读它，然后在「设置」入口旁亮一个点，设置里有一页「更新」，操作交给平台。不要在顶栏或主界面另占地方放更新按钮。**中转例外**：它保留现在的界面热更新和外壳一键更新，平台不接管。
4. **Reviewer 只有一份**。别的程序要用 Reviewer 时，去找已经装好的那份（Studio 里带的，或者独立版），不要自己再打包一份。中转以后通过 `%APPDATA%\AMO\programs.json` 找它。
5. **每个工具有自己的版本号和改动说明**，发布时写清这次改了什么，平台会显示给用户。
6. **重启要由人点**。尤其是 Studio：重启 Host 会打断正在跑的会话。任何更新或修改都不能在有会话运行时自己重启 Host。

## 怎么干活

- 用中文和用户交流。界面文字也是中文，用户看得到的写法要具体、直白。
- **用户要求才提交、推送**，提交信息照最近几条的风格写。不要自己合并或删除别人的分支和 worktree。
- 代码风格跟周围保持一致；注释写「为什么」，可以带日期和用户的决定。仓库里是长行，**不要跑 prettier**（没有配置，它会把文件改成 80 列）。
- 跑重的任务（vitest、e2e、打包）用低优先级：`BelowNormal`，加 `--maxWorkers=6`。普通优先级会让用户的桌面卡。
- 常用命令（在 `studio/` 下）：
  - `npm run verify`：类型检查、单测、构建；
  - `npm run e2e`：e2e 按程序分成几个 Playwright project：`studio`、`notes`、`reviewer`、`relay`；
  - `npm run package:portable`：打 portable 包；
  - `npm run relay:release` 之后 `npm run relay:mac -- deploy`：发布中转。
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
