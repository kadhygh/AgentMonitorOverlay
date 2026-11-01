# 发布流程整理（2026-10-31，方案；第 1 到 7 项已做，见文末）

用户：「发布 studio、platform 等工具和发布服务器没有统一的脚本，整理梳理一轮」。

## 现在怎么发

| 发什么 | 步骤（全靠人或 AI 记） | 脚本 |
|---|---|---|
| 平台上的工具（studio、reviewer、notes、platform、中转客户端外壳 relay） | 改包的 `package.json` 版本号 → `CHANGELOG.md` 的「下一版」改成版本标题 → `npm run package:platform -- --only <工具>`（先整体 build）→ `npm run relay:mac -- publish <工具>`（测试通道，顺手删旧版本）→ 手写「chore: test channel — …」提交 → 试过后 `promote` | `package-portable.mjs --platform`、`platform-publish.mjs`（经 `relay-mac.mjs publish/promote/platform-*`） |
| 中转服务 + 中转客户端界面 | `npm run relay:release`（`-- --shell` 时连外壳 zip）→ `npm run relay:mac -- deploy`（服务变了才重启，重启前自动备份数据库） | `relay-release.mjs`、`relay-mac.mjs deploy` |
| portable zip（不装平台的人用） | `npm run package:portable` → `smoke:portable` | `package-portable.mjs`、`smoke-portable.mjs` |
| 本机的中转服务（Windows） | `scripts/relay-service.ps1` | 早期用，现在服务在 Mac 上 |

## 问题

1. **步骤分散、靠记**：版本号、CHANGELOG、打包、发布、提交五步分开做，发几个工具就重复几遍；提交说明手写。今天的问题页值守模板里也只能把这些步骤抄一遍给 AI。
2. **不检查工作区**：打包用的是磁盘上的文件，不是提交过的代码。2026-10-31 发 Studio 0.9.17 时，主工作区里有别的会话没提交的中转改动，差点打进包里（当时改从干净的 worktree 打）。
3. **不知道该发哪些工具**：Studio 包里带着便签、Reviewer 和 `relay/light`；改了 `packages/notes` 要不要发 Studio，全靠人判断。也没有「上次发布以来改了什么」的记录：没有发布 tag，只能翻提交说明。
4. **不跑测试**：发布前不强制 typecheck 和单测。
5. **中转服务没有版本**：`packages/relay` 版本是 0.0.0，没有 CHANGELOG；部署了什么只能看提交记录。客户端外壳的 `SHELL_VERSION` 要手动改。
6. **两套入口**：工具走 `package:platform` + `relay:mac publish`，服务走 `relay:release` + `relay:mac deploy`，命令名看不出关系。

## 建议：一个入口 `npm run release`

```
npm run release -- status                     各工具：本地版本、测试通道、稳定通道、上次发布以来的提交数、「下一版」写了几条
npm run release -- studio notes [--dry-run]   发这几个工具到测试通道
npm run release -- relay-service              部署中转服务和客户端界面
npm run release -- promote studio 0.9.17      转正式版（照旧）
```

`release <工具…>` 按顺序做，任何一步失败就停，前面的已发布的照实报：

1. **检查**：在 master 上；这些工具会打进包的目录（各自的包，加上 Studio 带的便签、Reviewer、protocol、host、ui、relay 等）没有未提交的改动，有就停下，列出文件。每个工具的 CHANGELOG「下一版」不能是空的。
2. **验证**：`typecheck` + 单测（低优先级，`--maxWorkers=6`）；`--skip-tests` 可以跳过，提交说明里会写上。
3. **定版本**：补丁号加一（`--minor` 加次版本号），「下一版」改成 `## <版本>（<日期>）`。
4. **打包、发布**：`package:platform --only <这几个>`，逐个 `publish` 到测试通道（照旧删旧版本）。
5. **提交并打 tag**：提交说明自动生成（「chore(studio): test channel — Studio 0.9.18、便签 0.9.8；publish dropped …」），每个工具打一个 tag（`studio-v0.9.18`）。以后 `status` 和「该不该发」都按 tag 算。
6. **收尾**：打印每个工具的版本和 promote 命令。

`release relay-service`：`relay:release`（外壳版本变了才带 `--shell`）→ 部署（照旧：服务变了才重启，重启前备份）→ 提交并打 `relay-service-v<n>` tag。中转服务也加一个版本号和 CHANGELOG（`packages/relay`），部署时写进服务，`/api/health` 能看到。

**中转服务只从提交过的代码部署**（2026-10-31 补）：服务器上只有一份构建，谁后部署谁的为准。那天上午另一个会话在主工作区直接 `relay:mac deploy` 了「服务器状态」（没提交），下午从值守目录发 0.7.1 就把它冲掉了。所以：改中转不要绕过 `release relay-service` 直接 deploy；`release relay-service` 发之前看主工作区 `packages/relay`、`packages/relay-ui` 有没有没提交的改动，有就停下（先提交进 master；确定不要它们才加 `--main-dirty-ok`）。

**依赖提示**：`status` 列出「改了但没发」的工具时，把打进 Studio 的包（notes、reviewer、relay/light…）的改动也算到 Studio 头上。

旧命令（`package:platform`、`relay:mac publish/deploy`、`relay:release`）保留，`release` 只是把它们串起来；AGENTS.md 和问题页值守模板改成只写 `npm run release -- …`。

## 已定（2026-10-31 用户）

- 发布前跑 typecheck + 单测；每个工具打 tag；中转服务加版本号和 CHANGELOG；portable zip 和 `relay-service.ps1` 留着不动。

## 维护节奏（2026-10-31 用户定）

只有用户一人维护，高速迭代期，每天大量小修复；小问题修好直接打包、不审核。

- **两份常驻副本**：主工作区（用户和「情况 2」的会话改、提交）；**值守目录** `G:\PROJECT\AgentMonitorOverlay-duty`（master 的干净副本，不建分支，依赖装一次复用；值守修问题和打包都在这里，开工前同步到 master 最新）。包只从主干（master 的提交）打，从不读主工作区里没提交的文件。在主工作区跑 `release` 时有没提交的文件就停下，提示去值守目录打。
- **情况 1**：用户在问题页提问题，不管了；定期看「要你看」。值守：判断大小 → 小的在值守目录修、测、提交、快进合进 master（不再每个问题开 `issue/<编号>` worktree）→ 到打包条件自动 `release` → 标已发布。大的（新功能或有几种做法、改 protocol / 数据格式、跨几个工具、估计 5 个以上文件）不修，标新状态「建议单开讨论」。
- **情况 2**：用户在当天的维护任务里开子会话迭代（用模板「维护迭代」），在主工作区改；**验证通过就自己提交到 master**，写 CHANGELOG「下一版」。下次打包一起发。
- **每天开工**：新建任务「MM-DD 维护」，用模板「开始维护」：建好或改好值守项（会话开在这个任务里、跑在值守目录、每分钟先检查问题页和 `release due --wait 30`、话是「照模板「问题页值守」做」），只批准一次。

## 这一轮要做的

1. ✓ `npm run release`（`scripts/release.mjs`）：status、due、`<工具…>` / auto、relay-service、promote，加上值守目录用的 `sync`（同步到 master 最新、依赖变了才装）和 `land`（值守目录的提交快进进 master）。中转服务的版本只在 `packages/relay/src/protocol.ts` 的 `RELAY_VERSION` 和 `packages/relay/CHANGELOG.md`（`packages/relay/package.json` 保持 0.0.0：workspace 里互相依赖写的是 0.0.0，改了 npm ci 会去 registry 找，404）。tag：`<工具>-v<版本>`、`relay-service-v<版本>`。
2. ✓ 值守项选了任务时可以指定会话跑在另一个项目的文件夹里（设置 → 值守的「在哪」；duty_save 的 `workspace` 按名字或路径）。
3. ✓ 一个值守项可以先查几样（`check: {kind: "all", checks: […]}`，最多 5 样）：「开始维护」设的是问题页（`issues.pending`）加 `node studio/scripts/release.mjs due --wait 30`，一个会话、一个文件夹，不并行。
4. ✓ 问题页：新状态「建议单开讨论」（discuss）和「要你看」页签；中转服务 0.7.1 已部署（2026-10-31）。
5. ✓ 顶栏「值守 N 项开着」和值守窗口；看板卡片、任务头的「值守」，会话列表的「值守开的」「设了值守」。
6. ✓ 远程任务的模板窗口也列出那台电脑上的模板（`rt.templates`，只读；两台都要是新版）。
7. ✓ 三份模板的原文在 `studio/docs/prompt-templates/`：`start-maintenance.md`（开始维护）、`issues-duty.md`（问题页值守，改成值守目录 + release）、`maintenance-iterate.md`（维护迭代）；AGENTS.md 的车道例外改了。duty_save 也认 `model`、`permission`（read-only / write / full）、`effort`，不写就用调用它的会话的模型和权限。
8. 值守目录已建（`G:\PROJECT\AgentMonitorOverlay-duty`）。
9. ✓ 2026-11-01 打包不再开模型（用户：「打包真的有必要跑个agent么」）：值守项「自动打包」是一条命令 `release.mjs auto --if-due`，每分钟看一次，在打包目录 `G:\PROJECT\AgentMonitorOverlay-release`（又一份 master 的 detached worktree，没人在里面改）里发。什么时候发：一个工具最后一次改动后 30 分钟没有新改动，或最早的改动等了 2 小时（`--wait` / `--max`），或者人点了「发布打包」；以前是「最早的改动等了 30 分钟」，一个没写说明的老改动让 0.9.24 在 #5 修好 5 分钟后就发了，#6 没赶上。发完把「已修好」的问题标成已发布（问题里 AI 写的提交号在这个包里、碰了发出去的工具；没写提交号的也标）。失败了记下那个 master（打包目录 git 文件夹里的 `amo-release-failed.json`），不再自己重试，等 master 动了或人点「发布打包」；问题页检查 `issues.pending` 看到「上一次打测试包没成功」才开日常值守的会话去查。值守项能挂在另一项下面（`parentId`，一层）：只表示关系，父的关掉子的跟着关，父的关着时子的开不了。还要：发 Studio 测试版（带上面 2、3、5、6、7 的改动）；用户更新 Studio 后把三份模板存进 Studio，开第一天的维护任务试一遍。
