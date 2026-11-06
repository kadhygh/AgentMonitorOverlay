# 文档分层（Archify 三层，2026-11-06）

> 状态：进行中（长期有效的「文档怎么维护」）。三步 2026-11-06 做完，用户审过后合进 master；审时用户定：索引目录改名 `docs/nav/`（Host 里已有 agent 用的 `features/guide`），加 `plans/later/` 放以后推进的。

## 起因

用户 11-06 定：照 project_mining 用「Archify 三层」整理文档的做法（`G:\PROJECT\project_mining\AIWork\active\long-term\doc-architecture-maintenance\README.md`，那边验证过有效），AMO 也整理一遍。三步（HANDOFF 瘦身、导航索引加锚点测试、plans 只留决定）都做完，用户最后一起审，中间不停下来问。只借做法和 `guide` 的格式，不搬 Archify 工具本身（画图、PMTable、能力维护都用不上）。

整理前量的：
- `studio/HANDOFF.md` 82 KB，11-04 刚把旧记录挪走，两天又长回来；11-01 以来 197 个提交里 58 个改了它。每个新会话先读它，约两万多 token。「最近的改动」和提交信息、各包 CHANGELOG 大量重复，合分支 rebase 时反复出现重复条目、条目落到已发布版本下面。
- `studio/plans/` 33 份，每份把设计决定和进度混在一起，过一阵分不清哪部分还算数。
- 10-27 统计过：AMO 第一次改代码前只碰约 4 次文档（project_mining 是 15），所以找代码本来不算贵，这次重点是**可维护**。

## 目标的三层

| 层 | 在哪 | 写什么 | 不写什么 |
|---|---|---|---|
| ① 导航索引 | `studio/docs/nav/*.json`，`node scripts/nav.mjs` 查 | 功能在哪、常见改动要改哪几处、代码锚点（文件 + 文件里的原文）、相关主题、下一步读哪份文档 | 实现细节、参数、算法 |
| ② 节点文档 | `studio/plans/<主题>.md`（只留决定）、`studio/HANDOFF.md`（只留现在的状态）、各包 README | 代码看不出来的：为什么这样、约束、跨模块的决定、用户定的事（带日期） | 进度流水、测试数字、逐提交的记录 |
| ③ 末端细节 | 代码、测试、各包 `CHANGELOG.md`、提交信息 | 怎么做的、改了什么、怎么验证的 | — |

硬规则（提交、发布、重启、凭据、架构约束）留在根目录 `AGENTS.md`，不进索引。

## 维护原则

**分层**
- 每层只放本层的，不复述下一层。HANDOFF 不记改动（看 git log 和 CHANGELOG）；plans 不记进度（同上）；索引不写实现（看它指的代码）。

**索引**
- 每个主题都给「下一步读」（`next`），不让 agent 停在索引这一层：查到后至少读一份它指的代码或文档再动手。
- 查不到不等于没有这个功能：先搜代码核实，确认是索引的缺口就补主题。
- 锚点用文件里的字面原文（类名、函数声明）。锚点失效（`scripts/nav.test.mjs` 报）就直接改指到现在的代码，或删掉；不留失效的锚点。
- 宁可准不要多：主题按工具和 Host 的 feature 分，同一处代码不在两个主题里各写一遍做法，用 `related` 互相指。

**HANDOFF**
- 只有「在哪、怎么跑」「规则补充」「还开着的事」「已知问题」。做完一段只改受影响的行：事做完了删掉那一行，新开的加一行。目标 10 KB 以内。

**plans**
- 每份开头一行状态：进行中 / 做完 / 以后推进 / 被取代（指向取代它的）/ 待确认。正文只留决定和原因。做完的挪进 `plans/done/`，挪的时候用 `git grep` 把指向它的链接都改掉（代码注释、AGENTS.md、HANDOFF、索引）。
- 以后推进（用户 2026-11-06）：谈出来但这一轮不做的功能、做到一半停下的，放进 `plans/later/`，开头写清停在哪，`plans/later/README.md` 的清单跟着改；HANDOFF 只用一行指过去。重新开工挪回 `plans/`。

## 索引格式

每个 `docs/nav/*.json` 是 `{ "schemaVersion": 1, "topics": [...] }`。一个主题：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | `类别.名字`，例如 `studio.remote`，全局不重复 |
| `label` | 是 | 一行中文名 |
| `aliases` | 是 | 查询时会命中的别名：界面上的叫法、类名、命令名 |
| `category` | 是 | `workflow`（常见改动）、`flow`（跨模块流程）、`host`、`runtime`、`app`、`ui`、`tool`（其他工具）、`infra`（发布、测试、文档） |
| `purpose` | 是 | 一两句：管什么、在哪 |
| `steps` | 否 | 常见改动要改哪几处，或流程经过哪些地方（1～12 条） |
| `anchors` | 是 | `{ label, path, anchor? }`：path 从仓库根目录起（`studio/…`），anchor 是文件里的一段原文；不写 anchor 就只查文件（或文件夹）在不在 |
| `related` | 是 | 相关主题的 id |
| `next` | 是 | 下一步读的文档或代码路径（从仓库根目录起） |

文件分三份：`studio.json`（Host、runtime、外壳、界面）、`tools.json`（Reviewer、便签、中转、平台、账号、手机）、`workflows.json`（常见改动、跨模块流程、发布、测试、文档）。

## 这次做了什么

见下面三节的提交（分支 `studio/docs-archify`）。

1. HANDOFF 瘦身：82,403 → 8,165 字节（第三步又补了三行「还开着的事」和一条已知问题，现在约 8.8 KB）；「最近的改动」（11-01 到 11-06）原样挪进 `docs/history/handoff-2026-11.md`；「还开着的事」按 git log、tag、分支和 worktree 核对过。`AGENTS.md` 的规矩改成：做完只改「当前状态 / 还开着的事」里受影响的行，改动说明写 CHANGELOG。
2. 导航索引：`docs/nav/` 48 个主题，`scripts/nav.mjs` 查询，`scripts/nav.test.mjs` 检查字段、id、related、锚点和 next。`AGENTS.md` 加了入口。
3. plans 整理：33 份每份开头加了状态，删掉进度流水（测试数字、截图清单、逐提交记录、做完的步骤表），用户的决定、取舍的理由、约束、没做完的事留着；和现在代码对不上的说法按代码改了。合计 414,292 → 338,247 字节（LF）。做完的 24 份挪进 `plans/done/`，145 个文件里指向它们的路径跟着改（代码注释、e2e、索引、HANDOFF、其他 plans；`docs/history/`、`docs/archive/` 是原样的归档，没改）。删掉的原文都在 git 历史里（`f46907f2` 及之前）。

### plans 的状态（2026-11-06）

| 留在 `plans/` | 状态 |
|---|---|
| `amo-lan-platform.md` | 进行中（长期有效的平台方案）。没做：工具读 `updates.json` 在设置旁亮点和「更新」页（AGENTS.md 第 3 条写的，代码里还没有）；中转改用已装的 Reviewer |
| `release.md`、`maintenance.md` | 进行中（长期有效的发布规则；遗留小问题的记录） |
| `host-structure.md` | 进行中：剩一组 feature 环、8b 留下的 19 处请求体 `as never`、8d 没开工 |
| `ios.md` | 进行中：等 App Store Connect API Key |
| `issues.md` | 做完，但留在原地：它也是值守的设计文档，值守还在用 |
| `doc-architecture.md` | 这一份 |
| `later/tutorial-onboarding.md`、`later/lan-file-transfer.md`、`later/canvas-workflow.md` | 以后推进（用户审时定：暂时先不做，作为后续推进内容），清单在 `later/README.md` |

挪进 `plans/done/` 的 24 份：relay、relay-tasks、relay-in-sessions、relay-round-2026-11-05、todo、remote-session、remote-page-and-new-task、remote-reviewer、android-studio、android-mobile-redesign、package-slim、notes-standalone、reviewer-standalone、remove-old-amo、merge-to-master、claude-code-mirror、message-delivery、send-now、mcp、prompt-templates、cleanup-2026-11、subsession-mention-2026-11-05、resume-cli-sessions、review-canvas。`plans/userlayer/` 是原型目录（另一个分支在改），没动。

## 对比实验

照 project_mining 实验 2 的做法缩小规模：3 个固定问题，分别在 master（旧文档，主工作区只读）和这个分支（新文档）上各开一个只读子 agent（sonnet）回答，只告诉它仓库路径、问题和「先读 AGENTS.md」。

问题和答案要点（要点先从代码核对过，以后复测沿用）：

1. **远程任务页上显示的被控端额度，是怎么从 A 推到 B 的？要改推送频率改哪里？**
   - A：`features/remote/usage.ts` 的 `RemoteUsageSender`，`start()` 每 `POLL_MS`（10 秒）`tick()`，只读缓存（`runtime.cachedUsage`、`channels.cachedBalance`），变了才经设备通道发 `REMOTE_KINDS.push`（`type: "usage"`）；谁能看由 `sharesUsage` 和 kv `remote.usageShare` 定；
   - B 要列表或任务时 `again()`，`SOON_MS`（1 秒）后补发；
   - B：`RemoteFeature` 收到 push 交给 `RemoteUsageCopies.receive`，远程状态的 `usage` 带给界面，任务页 `ui/src/task/RemoteBanner.tsx`；
   - 改频率：`POLL_MS` / `RemoteFeature` 的 `usagePollMs` 选项、`SOON_MS`；额度本身的刷新不在这里。
2. **平台的「更新记录」数据从哪来、发布时怎么生成？**
   - 来源是各包 `CHANGELOG.md`（「下一版」发布时改成版本标题）；
   - `relay-mac.mjs` publish → `amo-tools.mjs` 的 `changelogHistory` / `releasedSections` → `platform-publish.mjs` 的 `historyFor` → `buildManifest` 写进清单的 `history`；
   - 中转服务的 summary（`relay/src/platform.ts` `manifestServed`）原样带出，服务不用改；
   - 平台 `manifest.ts` `checkHistory`、`platform.ts` `changelog()` 合并通道和本机版本，旧清单退回 notes（partial）；界面 `ChangelogPage.tsx`。
3. **新加一个 Host 路由要改哪几处？**
   - protocol 里主题自己的 `XxxRoutes`（或 `api.ts` 的 `HostRoutes`）声明键和 `{req, res}`；
   - feature 的 `routes.ts` 里 `route("METHOD /path", handler)`（`http/route.ts`），请求体自己检查；
   - 任务 / 会话的写路由要远程副本能用就写 `remoteCopy`，`remote-tasks.test.ts` 的清单跟着改；
   - 新 feature 才动 `features/index.ts` 的 `FEATURES`；界面 `ui/src/host/client.ts` 的 `call()` 按键调用。

结果（每个组合跑 1 次；「token」是子 agent 结束时报的总 token 数，不是加权消耗）：

| 问题 | 旧文档：调用 / token | 新文档：调用 / token | 答案 |
|---|---|---|---|
| 1 远程额度 | 4 / 56,125 | 3 / 55,398 | 都答全了；旧的没点出界面是 `RemoteBanner.tsx`，新的点出了 |
| 2 更新记录 | 9 / 63,111 | 8 / 58,781 | 都答全了主干；旧的漏了服务器的 summary 和界面 `ChangelogPage`，新的都有 |
| 3 新路由 | 5 / 62,511 | 4 / 57,588 | 都答全了；**新的只读了索引，一行代码没打开**（它自己说了） |
| 平均 | 6 / 60,582 | 5 / 57,256 | 新的少约 5% token、少 1 次调用 |

看法：
- 和 10-27 的统计一致：AMO 找代码本来就便宜（旧文档平均 6 次调用就答全了），这次省的不多，收益主要在可维护：HANDOFF 从 82 KB 到 9 KB，每个新会话少读约两万 token（上面的实验没算这一项：子 agent 只读了 AGENTS.md，没读 HANDOFF）。
- 新的答案多覆盖了界面和服务两端（索引的锚点把链路两头都列出来了）。
- 和 project_mining 一样，agent 容易停在索引这一层（第 3 题）。已经在 `nav.mjs` 的输出末尾加了一行「至少打开一处代码核对」，`AGENTS.md` 也这样写；下次复测看它有没有用。
- 局限：每个组合只跑 1 次；索引是我知道这三个问题之后写的（三个题都有正好对口的主题），对没见过的问题帮助多大要靠以后的复测和实际会话。

## 以后怎么维护

- 改一个功能：先 `node scripts/nav.mjs --query …`；查到的主题和代码对不上就顺手改主题；没有的补主题。
- 加 feature、改名、挪文件：跑 `npx vitest run scripts/nav.test.mjs`（全量 vitest 里也有它），失败信息说清是哪个主题哪个锚点、怎么改。
- 做完一段：CHANGELOG「下一版」+ 提交信息；HANDOFF 只改受影响的行；方案做完就在开头标「做完」、挪进 `plans/done/`。
- 隔一两个月按同样 3 个问题复测一次（问题和答案要点在本文「对比实验」一节）。
