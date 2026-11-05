# 发布流程和维护节奏（2026-10-31）

> 状态：进行中（长期有效的规则，`AGENTS.md` 引用它）。方案里的事都做了：`npm run release`（`a8c55c13`，2026-10-31）、三份模板（`76426012`）、不开模型的自动打包（`21bcc4cb`，2026-11-01）、更新记录（`82704552`，2026-11-06）；以后改发布规则时接着改这份。「这一轮要做的」勾选清单 2026-11-06 删掉了，里面的决定并进了下面各节，原文见 git 历史（提交 f46907f2 之前的版本）。用法以 `scripts/release.mjs` 开头的说明为准。

用户：「发布 studio、platform 等工具和发布服务器没有统一的脚本，整理梳理一轮」。

## 为什么要一个入口

整理前（2026-10-31）发平台上的工具要手动走五步（改版本号 → CHANGELOG「下一版」改成版本标题 → `package:platform --only` → `relay:mac -- publish` → 手写提交），中转服务另走 `relay:release` + `relay:mac deploy`。问题：

1. **步骤分散、靠记**：发几个工具就重复几遍；问题页值守模板里也只能把这些步骤抄一遍给 AI。
2. **不检查工作区**：打包用的是磁盘上的文件，不是提交过的代码。10-31 发 Studio 0.9.17 时，主工作区里有别的会话没提交的中转改动，差点打进包里。
3. **不知道该发哪些工具**：Studio 包里带着便签、Reviewer 和 `relay/light`；改了 `packages/notes` 要不要发 Studio 全靠人判断。没有发布 tag，「上次发布以来改了什么」只能翻提交说明。
4. **不跑测试**：发布前不强制 typecheck 和单测。
5. **中转服务没有版本**：部署了什么只能看提交记录；客户端外壳的 `SHELL_VERSION` 要手动改。
6. **两套入口**：命令名看不出关系。

## 已定（2026-10-31 用户）

- 发布前跑 typecheck + 单测；每个工具打 tag；中转服务加版本号和 CHANGELOG；portable zip 和 `relay-service.ps1` 留着不动。

## `npm run release`

```
npm run release -- status                     各工具：本地版本、测试通道、稳定通道、上次发布以来的提交数、「下一版」写了几条
npm run release -- studio notes [--dry-run]   发这几个工具到测试通道
npm run release -- auto [--if-due]            发所有到期的工具（自动打包用 --if-due，见下面）
npm run release -- relay-service              部署中转服务和客户端界面
npm run release -- promote studio 0.9.17      转正式版
npm run release -- sync | land                值守目录：同步到 master 最新 / 自己的提交快进进 master
```

`release <工具…>` 按顺序做，任何一步失败就停，前面已发布的照实报：

1. **检查**：在 master 上；这些工具会打进包的目录没有未提交的改动，有就停下，列出文件。每个工具的 CHANGELOG「下一版」不能是空的。
2. **验证**：`typecheck` + 单测（低优先级，`--maxWorkers=6`）；`--skip-tests` 可以跳过，提交说明里会写上。
3. **定版本**：补丁号加一（`--minor` 加次版本号），「下一版」改成 `## <版本>（<日期>）`。
4. **打包、发布**：`package:platform --only <这几个>`，逐个 `publish` 到测试通道（顺手删旧版本）。
5. **提交并打 tag**：提交说明自动生成，每个工具打一个 tag `<工具>-v<版本>`。`status` 和「该不该发」都按 tag 算。
6. **收尾**：打印每个工具的版本和 promote 命令。

- **只从提交过的 master 打包**，从不读主工作区里没提交的文件。在主工作区跑 `release` 时有没提交的文件就停下，提示去值守目录打。
- **依赖提示**：`status` / `due` 列「改了但没发」的工具时，把打进 Studio 的包（notes、reviewer、relay/light…）的改动也算到 Studio 头上。
- **中转服务的版本**只在 `packages/relay/src/protocol.ts` 的 `RELAY_VERSION` 和 `packages/relay/CHANGELOG.md`，tag `relay-service-v<版本>`。`packages/relay/package.json` 保持 0.0.0：workspace 里互相依赖写的是 0.0.0，改了 npm ci 会去 registry 找，404。
- **`release relay-service`**：`relay:release`（外壳版本变了才带 `--shell`）→ 部署（服务变了才重启，重启前备份数据库）→ 提交并打 tag。
- **中转服务只从提交过的代码部署**（2026-10-31 补）：服务器上只有一份构建，谁后部署谁的为准。那天上午另一个会话在主工作区直接 `relay:mac deploy` 了没提交的改动，下午从值守目录发 0.7.1 就把它冲掉了。所以改中转不要绕过 `release relay-service` 直接 deploy；它发之前看主工作区 `packages/relay`、`packages/relay-ui` 有没有没提交的改动，有就停下（先提交进 master；确定不要它们才加 `--main-dirty-ok`）。
- **更新记录**（2026-11-06）：`relay:mac -- publish` 除了这一版的 `notes`，还把这个工具 `CHANGELOG.md` 里到这一版为止所有已发布的节（去掉「下一版」）作为 `history` 写进清单（`amo-tools.mjs` 的 `releasedSections`、`platform-publish.mjs` 的 `historyFor`），平台卡片上的「更新记录」读它。CHANGELOG 照旧写；改了已发布版本的说明，下次发布这个工具时才会带上。
- 旧命令（`package:platform`、`relay:mac publish/deploy`、`relay:release`）保留，`release` 只是把它们串起来；AGENTS.md 和模板里只写 `npm run release -- …`。

## 维护节奏（2026-10-31 用户定）

只有用户一人维护，高速迭代期，每天大量小修复；小问题修好直接打包、不审核。

- **常驻副本**：主工作区（用户和「情况 2」的会话改、提交）；**值守目录** `G:\PROJECT\AgentMonitorOverlay-duty`（master 的干净副本，detached，不建分支，依赖装一次复用，开工前 `release sync` 同步到 master 最新）；**打包目录** `G:\PROJECT\AgentMonitorOverlay-release`（又一份 master 的 detached worktree，只给自动打包用，没人在里面改，2026-11-01 加）。
- **情况 1**：用户在问题页提问题，不管了；定期看「要你看」。值守：判断大小 → 小的在值守目录修、测、提交、`release land` 快进合进 master（不再每个问题开 `issue/<编号>` worktree）→ 自动打包发出去后标已发布。大的（新功能或有几种做法、改 protocol / 数据格式、跨几个工具、估计 5 个以上文件）先不动手，在问题里写清打算怎么做，标「需要确认」，和人在问题里谈定再做。（10-31 当天先做了一个 AI 设的「建议单开讨论」状态，当晚改掉：现在 `discuss`「去会话讨论」只由人点「前往讨论」设，值守不碰这样的问题。）
- **情况 2**：用户在当天的维护任务里开子会话迭代（模板「维护迭代」），在主工作区改；**验证通过就自己提交到 master**，写 CHANGELOG「下一版」。下次打包一起发。
- **每天开工**：新建任务「MM-DD 维护」，用模板「开始维护」设好两个值守项，各批准一次：
  - **日常值守**：会话开在这个任务里、跑在值守目录，每分钟先查问题页（`issues.pending`：新问题、人回复了、上一次打测试包没成功），有事才开会话，话是「照模板「问题页值守」做」。
  - **自动打包**：挂在日常值守下面，见下一节。
- 三份模板的原文在 `studio/docs/prompt-templates/`：`start-maintenance.md`（开始维护）、`issues-duty.md`（问题页值守）、`maintenance-iterate.md`（维护迭代）。改了原文要同步到 Studio 里的模板。

## 自动打包（2026-11-01 定，11-03 改）

用户：「打包真的有必要跑个agent么」。所以测试包不开模型：

- 值守项「自动打包」是一条命令 `release.mjs auto --if-due`，每分钟看一次，在打包目录里发。
- **什么时候发**：一个工具最后一次改动后 30 分钟没有新改动（`--wait`），或第一条「下一版」写进来已经等了 2 小时（`--max`），或者人在问题页点了「发布打包」。
  - 最早是「最早的改动等了 30 分钟」：一个没写说明的老改动让 0.9.24 在 #5 修好 5 分钟后就发了，#6 没赶上（11-01 改）。
  - 2 小时原来从最早一次碰到这个工具的包的提交算起，没写「下一版」的老改动会让刚写进来的第一条马上到期，那时做改动的会话可能还在跑测试（11-03 改成从第一条「下一版」算，用户同意）。
- 发完把「已修好」的问题标成已发布（问题里 AI 写的提交号在这个包里、碰了发出去的工具；没写提交号的也标）。
- **失败了**：记下那个 master（打包目录 git 文件夹里的 `amo-release-failed.json`），同一个 master 上不再自己重试；master 动了以后要安静 10 分钟（`--retry-quiet`）才再试，人点「发布打包」不用等。问题页的打包进度写着停在哪一步；日常值守的检查看到「上一次打测试包没成功」才开会话去查。
- 改了 `release.mjs`，从自动打包的**下一次**运行起才生效（它先载入脚本，再把打包目录同步到新 master）。

## 为维护加到 Studio 里的（2026-10-31 / 11-01）

- 值守项选了任务时可以指定会话跑在另一个项目的文件夹里（设置 → 值守的「在哪」；`duty_save` 的 `workspace` 按名字或路径）。
- 一个值守项可以先查几样（`check: {kind: "all", checks: […]}`，最多 5 样）：一个会话、一个文件夹，不并行。
- 值守项能挂在另一项下面（`parentId`，一层）：只表示关系，父的关掉子的跟着关，父的关着时子的开不了。
- `duty_save` 认 `model`、`permission`（read-only / write / full）、`effort`，不写就用调用它的会话的模型和权限。
- 问题页有「要你看」页签；顶栏「值守 N 项开着」和值守窗口；看板卡片、任务头的「值守」，会话列表的「值守开的」「设了值守」；远程任务的模板窗口也列出那台电脑上的模板（只读）。
