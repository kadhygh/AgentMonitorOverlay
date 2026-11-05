# 文档分层（Archify 三层，2026-11-06）

> 状态：进行中。分支 `studio/docs-archify` 上三步做完，等用户一起审，没合进 master。合进去之后这份是长期有效的「文档怎么维护」。

## 起因

用户 11-06 定：照 project_mining 用「Archify 三层」整理文档的做法（`G:\PROJECT\project_mining\AIWork\active\long-term\doc-architecture-maintenance\README.md`，那边验证过有效），AMO 也整理一遍。三步（HANDOFF 瘦身、导航索引加锚点测试、plans 只留决定）都做完，用户最后一起审，中间不停下来问。只借做法和 `guide` 的格式，不搬 Archify 工具本身（画图、PMTable、能力维护都用不上）。

整理前量的：
- `studio/HANDOFF.md` 82 KB，11-04 刚把旧记录挪走，两天又长回来；11-01 以来 197 个提交里 58 个改了它。每个新会话先读它，约两万多 token。「最近的改动」和提交信息、各包 CHANGELOG 大量重复，合分支 rebase 时反复出现重复条目、条目落到已发布版本下面。
- `studio/plans/` 33 份，每份把设计决定和进度混在一起，过一阵分不清哪部分还算数。
- 10-27 统计过：AMO 第一次改代码前只碰约 4 次文档（project_mining 是 15），所以找代码本来不算贵，这次重点是**可维护**。

## 目标的三层

| 层 | 在哪 | 写什么 | 不写什么 |
|---|---|---|---|
| ① 导航索引 | `studio/docs/guide/*.json`，`node scripts/guide.mjs` 查 | 功能在哪、常见改动要改哪几处、代码锚点（文件 + 文件里的原文）、相关主题、下一步读哪份文档 | 实现细节、参数、算法 |
| ② 节点文档 | `studio/plans/<主题>.md`（只留决定）、`studio/HANDOFF.md`（只留现在的状态）、各包 README | 代码看不出来的：为什么这样、约束、跨模块的决定、用户定的事（带日期） | 进度流水、测试数字、逐提交的记录 |
| ③ 末端细节 | 代码、测试、各包 `CHANGELOG.md`、提交信息 | 怎么做的、改了什么、怎么验证的 | — |

硬规则（提交、发布、重启、凭据、架构约束）留在根目录 `AGENTS.md`，不进索引。

## 维护原则

**分层**
- 每层只放本层的，不复述下一层。HANDOFF 不记改动（看 git log 和 CHANGELOG）；plans 不记进度（同上）；索引不写实现（看它指的代码）。

**索引**
- 每个主题都给「下一步读」（`next`），不让 agent 停在索引这一层：查到后至少读一份它指的代码或文档再动手。
- 查不到不等于没有这个功能：先搜代码核实，确认是索引的缺口就补主题。
- 锚点用文件里的字面原文（类名、函数声明）。锚点失效（`scripts/guide.test.mjs` 报）就直接改指到现在的代码，或删掉；不留失效的锚点。
- 宁可准不要多：主题按工具和 Host 的 feature 分，同一处代码不在两个主题里各写一遍做法，用 `related` 互相指。

**HANDOFF**
- 只有「在哪、怎么跑」「规则补充」「还开着的事」「已知问题」。做完一段只改受影响的行：事做完了删掉那一行，新开的加一行。目标 10 KB 以内。

**plans**
- 每份开头一行状态：进行中 / 做完 / 搁置 / 被取代（指向取代它的）/ 待确认。正文只留决定和原因。做完的挪进 `plans/done/`，挪的时候用 `git grep` 把指向它的链接都改掉（代码注释、AGENTS.md、HANDOFF、索引）。

## 索引格式

每个 `docs/guide/*.json` 是 `{ "schemaVersion": 1, "topics": [...] }`。一个主题：

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

1. HANDOFF 瘦身：82,403 → 8,165 字节；「最近的改动」（11-01 到 11-06）原样挪进 `docs/history/handoff-2026-11.md`；「还开着的事」按 git log、tag、分支和 worktree 核对过。`AGENTS.md` 的规矩改成：做完只改「当前状态 / 还开着的事」里受影响的行，改动说明写 CHANGELOG。
2. 导航索引：`docs/guide/` 48 个主题，`scripts/guide.mjs` 查询，`scripts/guide.test.mjs` 检查字段、id、related、锚点和 next。`AGENTS.md` 加了入口。
3. plans 整理：见「plans 的状态」。

## 对比实验

照 project_mining 实验 2 的做法缩小规模：3 个固定问题，分别在 master（旧文档，主工作区只读）和这个分支（新文档）上各开一个只读子 agent（sonnet）回答，只告诉它仓库路径、问题和「先读 AGENTS.md」。

（结果待补）

## 以后怎么维护

- 改一个功能：先 `node scripts/guide.mjs --query …`；查到的主题和代码对不上就顺手改主题；没有的补主题。
- 加 feature、改名、挪文件：跑 `npx vitest run scripts/guide.test.mjs`（全量 vitest 里也有它），失败信息说清是哪个主题哪个锚点、怎么改。
- 做完一段：CHANGELOG「下一版」+ 提交信息；HANDOFF 只改受影响的行；方案做完就在开头标「做完」、挪进 `plans/done/`。
- 隔一两个月按同样 3 个问题复测一次（问题和答案要点在本文「对比实验」一节）。
