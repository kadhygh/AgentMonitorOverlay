# 三层架构：userlayer / datalayer / agentlayer（2026-11-01，讨论中）

用户 11-01 提出换个角度、从人的角度推进：

- **userlayer**：面向人的表达，不限于看板、画布，什么形式都行，要「不用学」。
- **datalayer**：按规范存的数据，AI 看得懂结构，人不关心。唯一的事实来源。
- **agentlayer**：人不关心。不再是「主 agent + 子 agent」，而是分工：**整理 agent**（梳理 datalayer：归并、补关联、标需复查）、**表达 agent**（按 datalayer 生成 userlayer）、**推进 agent**（照常干活，往 datalayer 交结果）。

和 10-30 的 `plans/canvas-workflow.md` 的关系：那份里画布要同时给人看、给 AI 读，两边互相掣肘（「布局归人」等规矩就是为此定的）。这里把它拆开：数据只为 AI 设计，表达只为人设计，表达可以随便换。

第一步（用户定）：先定 datalayer 规范，用假数据直接做出几种给人看的表达，让人上手感受。这个文件夹就是第一步的产物。

11-01 看完 9 种示例，用户觉得**刷卡片**（`v-swipe.html`）和**地图**（`v-map.html`）更合理。下一步在这两种上往下走。

## 文件

| 文件 | 是什么 |
|---|---|
| `README.md` | 这份：规范草案 0.1 |
| `sample.json` | 假数据：AMO 中转 0.7.x（10-31 一天 7 次部署）的审核 |
| `lib.js` | 各个表达共用的读写层：读数据、人的操作（回答、搁置……）、事件、标签文字 |
| `sync.mjs` | 把 `claude-style.css`、`lib.js`、`sample.json` 灌进每个 HTML 的标记区里，HTML 仍是双击就能开的单文件 |
| `shot.mjs` | 用 Playwright 给 HTML 截图（浅色和深色），检查排版 |
| `index.html` | 9 种表达的入口 |
| `views-brief.md`、`_template.html` | 给做表达的会话的共用说明和起手模板 |
| `v-*.html` | 每种表达一个文件 |

改了 `sample.json` 或 `lib.js` 之后跑 `node studio/plans/userlayer/sync.mjs`。

## datalayer 规范 0.1（草案）

一份数据对应一件事（`context`），比如一次审核、一个专题。顶层：

```jsonc
{
  "spec": "amo.datalayer/0.1",
  "context": { "id", "title", "goal", "updatedAt" },
  "viewer":  { "name", "lastSeenAt" },          // 这个人上次看的时间，用来算「上次以来」
  "areas":   [{ "id", "name", "summary" }],      // 这件事分成的几块（地图的区域、书房的抽屉……）
  "agents":  [{ "id", "name", "role", "model", "status", "doing", "item"? }],   // item：正在处理的条目
  "items":   [ Item ],
  "links":   [{ "from", "to", "rel", "note"? }],
  "events":  [{ "at", "item"?, "actor", "kind", "text" }]
}
```

### Item：条目

| 字段 | 说明 |
|---|---|
| `id`、`num` | 稳定 id；给人看的编号 #n |
| `type` | `decision` 决定、`question` 问题、`bug`、`finding` 发现、`task` 事项、`conclusion` 结论 |
| `title`、`short`、`summary`、`body` | 一行标题；12 字以内的短标题（便签、书脊、大头针用）；一两句摘要；正文（Markdown） |
| `status` | `needs_you` 等你、`working` 进行中、`waiting` 等别人、`settled` 已定、`parked` 搁置 |
| `importance` | `high` / `normal` / `low`：表达时决定大小、远近、版面位置 |
| `area` | 属于哪一块（`areas[].id`） |
| `owner` | 现在球在谁手里：`human`、某个 agent id，或 `team:<人名>` |
| `source` | 谁写的（agent id） |
| `ask` | 要人拍板时才有：`question`、`options[{id,label,detail}]`、`recommend`、`why`、`deep`（复杂，建议去对话里谈）、`answer{option,note,at}` |
| `conclusion` | 定下来的结论 |
| `eta` | 可选：估计什么时候好（「今天上午」「#2 定了之后」） |
| `evidence` | 证据：`[{kind: file/commit/session/url/log, ref, note}]` |
| `createdAt`、`updatedAt` | 时间 |

### Link：关联

`rel`：`depends`（from 要等 to 先定）、`affects`（from 变了 to 要复查）、`answers`（from 回答了 to）、`supersedes`（from 取代 to）、`part_of`（from 是 to 的一部分）。

### Event：事件

只追加。`kind`：`created`、`status`、`answered`、`concluded`、`evidence`、`comment`。用来算「上次以来变了什么」，也是上下文压缩后找回历史的地方。

### 三类 agent 怎么用它（设想，未验证）

- **推进 agent**：做完一段，交条目（结论、问题、发现）和它自报的关联；不读别人的聊天，只读条目目录（标题 + 一句结论）。
- **整理 agent**：只在有新事件时被叫起，只读新条目和相关条目：归并重复、补关联、沿 `affects` 标需复查。能用代码做的（沿连线传播、统计、变化标记）不交给模型。
- **表达 agent**：常看的视图由代码渲染（快、稳定、位置不乱跳）；讲机制、做对比这类定制表达才按需用模型生成。

### 人的操作（userlayer → datalayer）

以结构化操作为主：回答 `ask`（选项 + 一句话）、搁置、重新打开、标为已看。都写成事件，`owner` 交回提问的 agent。自由文字的批注作为 `comment` 事件，由整理 agent 归档。

## 规范 0.2：lane（2026-11-01）

用户看完 9 种示例后的方向：**刷卡片延后**；地图改成 **3D 倾斜视角，每个任务一条 lane**。lane 中间可以分出支线，推进到一部分会长出节点，节点旁边出内容；从大地图（多个任务）丝滑缩放到单个任务的 lane，任务有层级就再往下一层。节点上立 billboard 牌子，点了快速弹出常规窗口。lane 的方向出几版比较，不一定是向右。

0.2 在 0.1 上加了（数据见 `sample-lanes.json`，照「AMO迭代」专题的 6 个任务编）：

```jsonc
"now": "…",                                   // 假数据的「现在」
"lanes": [{
  "id", "title", "short",
  "kind": "task | sub | branch",              // 任务、任务里的子车道、支线
  "parent"?,                                  // sub / branch 属于哪条
  "branchKind"?: "session | idea",            // 真开出来的分支会话（实线），思路上的分叉（细虚线）
  "forkFrom"?, "mergeInto"?,                  // 从哪个条目分出来、并回哪个条目
  "end"?: "merged | dropped | parked",        // 支线的结局：并回、断掉 ✕、搁置
  "status": "running | waiting | done | parked",
  "column"?, "agent"?, "startAt", "endAt"?
}]
```

条目多了 `lane`（在哪条 lane 上）和 `at`（在 lane 上的时间位置），类型多了 `milestone`（发布、开工、交接）。`needs_you` / `waiting` 的条目在 lane 上画成**闸门**，路修不过去。

## 技术底层换成 deck.gl（2026-11-01）

canvas 2D 版（`v-lanes.html`）用户点不了，也嫌太像地图 App。用户定：底层换 **deck.gl**；**纯黑地图**，用亮线勾勒区域和节点，连接线像科幻电影里的地图；**不展示子车道**。

- 包：`vendor/deck.min.js`（deck.gl 9.4.1 的 core + layers + extensions，esbuild 打成 IIFE，约 1.2 MB），页面里放 `/*@deck*/…/*@/deck*/` 标记，由 `sync.mjs` 灌进去，HTML 仍是单文件。
- 冒烟测试 `_deck-smoke.html`：headless Edge 能渲染 WebGL，中文用系统字体（`characterSet: "auto"`），真实鼠标点击能拾取。
- `v-deck2.html`（11-01）：用户嫌 `v-deck.html` 浮夸、信息太多、近景掉帧，重做成最少内容的起点（只有区域、一条 lane、「等你」和普通点、等你的牌子），三种风格 `#line` `#star` `#chart` 只换皮。性能做法：静态图层只建一次，动效只改 `opacity`、`radiusScale`、`sizeScale`；空闲时停掉 deck 的渲染循环（`animationLoop.stop()`，有输入再 `start()`，呼吸用 `animationLoop.redraw()` 一秒 12 帧）；牌子在视角停下后排一次；不用 CollisionFilterExtension 和加法混合；`useDevicePixels` 最多 1.5。`#stress` 近景拖动从 66～68 fps（每帧 deck CPU 约 7 ms）到跑满刷新率（约 1 ms）。验证和测速：`shot-deck2.mjs`。
- `v-deck3.html`（11-01）：用户说 v-deck2 不如第一版好看；要的「风格」是偏设计向的不同美术方向（配色都可以换），内容保留第一版的丰富度。于是在第一版的内容上做了四套风格，一张风格表驱动同一个引擎：`#oblivion` 冰白全息、`#nostromo` 琥珀终端、`#abyss` 深海荧光、`#haze` 橙雾，`&nofx` 关掉模糊和叠加层。性能沿用 v-deck2 的做法，`#stress` 近景每帧 CPU 3～4.8 ms（第一版 6.5 ms），页面 165～170 fps。验证：`shot-deck3.mjs`（真实鼠标，62 项）。用户 11-01 选定 **冰白全息（oblivion）**，正式做就用这套视觉语言。
- 选它的理由：倾斜视角、billboard 文字、防重叠、弧线、拾取、飞行过渡都是现成的；以后表达 agent 可以输出 `@deck.gl/json` 的视图描述，正好对上三层架构。

## 待定

- deck.gl 星图（`v-deck.html`）提的：agent 和 lane 的对应只留一处（现在 `lanes[].agent` 和 `agents[].item` 两处都写）；`links` 加短 `label` 放弧顶；区域位置要稳定（lane 顺序或 `AMO.layout`）。CollisionFilterExtension 的坑：优先级最高给 900（1000 会被整层裁掉）；按锚点判断遮挡，用像素偏移挪开的文字会被整个判成挡住；

- lane 地图（`v-lanes.html`）做出来后提的规范缺口：哪些条目挡路、先后顺序、等谁（`waitingOn`，可以和 `people` 合并）；lane 修到哪（`front`）和计划中的下一步、预计时间；子车道的分出点（`forkFrom`）；lane 的 `importance` 和固定位置；「做完了」这种不带选项的闸门怎么抬（读写层缺 `done`）；

- 团队成员单独成表（`people`：谁、做什么、怎么联系、问出去的时间），现在只有 `team:测试同事` 一个字符串（C 组建议）；
- 事件 `text` 的口气统一（不带主语，主语看 `actor`），或者加结构化字段，拼叙述时不用特判（B 组建议）；
- 「最要紧」怎么排：同为 high 时现在按创建先后，#3 排在 #1 前面；要不要加截止时间之类的字段；

- 一份 datalayer 对应任务、专题还是项目；
- userlayer 是打开时生成，还是数据变了就更新；
- 推进 agent 由人开，还是 agentlayer 自己调度。

## 接进 Studio（第一版，2026-11-01）

用户定：设置里加一页「测试功能」，给这个功能一个开关（默认关），开着时顶栏「画布」后面多一个选项卡「全景」（代码 id `panorama`）。名字是中性的：星图只是一种主题，以后可以换，数据结构不动。正式迭代从最简单的内容开始。

**做了什么**

- 设置 → 测试功能：`protocol/src/api.ts` 的 `EXPERIMENTAL_FEATURES` 表和 `StudioSettings.experimentalFeatures`（开着的列表；和 `disabledFeatures`「默认开、关掉隐藏」相反）。Host 的 `features/config/service.ts` 照 `disabledFeatures` 读写、校验（只认表里有的 id），存在 kv `settings:experimental-features`。界面 `ui/src/settings/ExperimentalSection.tsx`。视图表里 `ViewDef.experimental` 标着的页，开关关着时没有选项卡、也打不开（`App.tsx` 过滤）。
- 页面在 `ui/src/panorama/`：
  - `datalayer.ts`：纯函数 `toPanorama({ topic, tasks, sessions, profiles, now })` → 0.2 的形状（`spec`、`context`、`now`、`lanes`、`items`）。页面只读它，不碰 Studio 的状态；以后挪进 Host 不用改画的部分。单测 `datalayer.test.ts`。
  - `layout.ts`：从 datalayer 算位置（区域、lane、节点、地面网格），不依赖 deck.gl，也有单测。只看 lane 和条目的先后，状态变了位置不动。
  - `themes.ts`：风格表，现在只有 `oblivion`（冰白全息），引擎的颜色、线、字和面板的 CSS 变量都从这张表来，加主题就是加一项。
  - `engine.ts`：deck.gl 9.4.1（`@deck.gl/core`、`@deck.gl/layers`，没用 extensions），命令式 `new Deck`，页面用动态 import 懒加载。
  - `PanoramaPage.tsx`、`view.tsx`、`panorama.css`：HUD（专题名、「N 件等你」、缩放和重置视角）、点节点的弹窗（最少的信息 + 「打开任务」）、WebGL 起不来时的列表。

**数据怎么映射**（0.2 上加的字段都标着）

| Studio | datalayer |
|---|---|
| 范围里的专题（没有就第一个活着的） | `context`：`id`、`title`、`goal`（专题说明）、`updatedAt` |
| 专题里没归档的任务，按创建时间 | `lanes[]`：`kind: "task"`、`title`（空的写「未命名任务」）、`short`（12 字）、`column`、`startAt` = 创建时间、`endAt` = 完成列时的更新时间；`status`：完成列 → `done`，有会话在跑或在等人 → `running`，其余 → `waiting`；加了 `ref.taskId` |
| 任务的主会话和分支会话（子代理不画），按开始时间 | `items[]`：`type: "session"`（新加的类型）、`at` = 开始时间、`num` 按 lane 再按时间编号；`status`：待批准 / 等你回答 / 待审阅 → `needs_you`（`owner: "human"`），运行中 → `working`，空闲、已完成、已归档 → `settled`，出错、被中断 → `parked`；`summary` 是一句状态（「等你批准」「在跑」……）；加了 `ref`（`taskId`、`sessionId`、`sessionStatus`、`kind`、`model`） |
| 「N 件等你」的顺序 | `needs_you` 的条目按 `updatedAt`（等得最久的先） |

**性能**照 v-deck2 那套：只随数据变的图层在数据变了才重建（会话只是时间戳变了不重建）；脉动只改透明度、`sizeScale`、角度，每帧重建的只有几个对象（等你的准星、选中环）；没有动的东西时停掉 deck 的渲染循环，有输入再开；牌子在视角停下后排一次（格子查重叠，等你的先放、挡住了往上抬）；`useDevicePixels` 最多 1.5；不用 CollisionFilterExtension；页面隐藏或离开这个选项卡时全停（离开就销毁）。

**验证**：`ui/src/panorama/datalayer.test.ts`（映射和布局 6 项）、`host/src/mcp/amo-mcp.test.ts`（开关的读写校验）；e2e `e2e/studio/panorama.spec.ts`：默认没有选项卡 → 设置里打开 → 选项卡在「画布」后面 → 地图画出来（测试窗口里 WebGL 能起）→ 真实鼠标点「N 件等你」两次（依次飞到两件、弹窗）、点等你的节点、重置视角后点普通节点 → 「打开任务」→「← 全景」回来 → 没有 WebGL 时是列表 → 关掉开关选项卡消失。截图 `studio/screenshots/studio/panorama-*.png`。

**包大小**：主包 main 690.3 kB → 704.0 kB（全景页、数据、设置页）；deck.gl 在懒加载的 `engine-*.js` 780.5 kB，另有它按需带的 webgl / gpu-data-evaluator / array-utils-flat / get-attribute-from-layouts 共约 164 kB。

**还缺的**

- 开关存在 Host 的设置里：跑着的 Host 是旧代码时不认 `experimentalFeatures`，会忽略它，勾上又弹回去，选项卡不出来；要重启 Host 才行。
- 只有会话一种节点。决定请求（`decision_request`，顶栏「需要你」也算它）还没画成「等你」；以后条目可以接画布审阅项、checklist、交接等。
- 「等你」的牌子只写状态和会话标题；要写清在等什么（批准哪条命令、问了什么），得从会话的内容里取，datalayer 还没有这一层。
- 支线（分支会话从哪个节点分出来）、lane 的计划部分（虚线）、关联弧线、子车道、语义缩放的第三层（3 行牌子）都没做。（P1 补上了支线、终点前的虚线和依赖弧线，见下一节。）
- 专题里任务多了（比如几十个）还没测过帧率；`#stress` 那种压力测试没搬进来。
- 主题切换的入口没有（表里只有一套）。

## P1：从起点长向终点的树（2026-11-02）

用户定的表达见 `panorama.md`「节点的表达」。P0 的「区域里一条路 + 会话点」换成每个任务一棵树。

**datalayer 加的字段**（`ui/src/panorama/datalayer.ts`，都是 0.2 上加的）

| 字段 | 意思 | 从哪来 |
|---|---|---|
| `lane.goal.state` | `open` 还在路上 / `review` 待验收 / `reached` 到了 | 看板列：待办、进行中 → `open`，待审阅 → `review`，完成 → `reached` |
| `lane.goal.checklist` | `{ done, total }`，没有清单是 `null` | 任务的清单（`data.checklist`） |
| `item.round` | 主干上第几轮（1、2…）；支线上是 `null` | 主会话按开始时间数 |
| `item.forkFrom` | 支线从哪个条目岔出来；主干上是 `null` | 分支会话的 `parentId`；用 session_start 开的会话的 `startedBy`（开它的会话也画着时才算，比如开它的是子代理就当主干的一轮） |
| `item.ended` | 支线停了（归档了，或会话已完成），画暗 | `archivedAt`、`status === "completed"` |
| `item.ref.how` | `round` / `fork` / `started` | 同上 |
| `links[]` | `{ from, to, rel: "depends" }`，`to` 等 `from` | 专题画布的依赖（`CanvasDoc.edges`），只留两头都在这个专题里的 |

**布局**（`layout.ts`）：起点（信标）在第 1 轮前面；主干一轮一节，等距；一个会话开出的会话（不管几个）合成一条支线，从它那里弯出去，放在主干上方或下方空着的轨道上，节点按开始时间排开；终点在最前节点前方，没清单时 24 个单位，有清单时 12 + 每个没勾的步骤 0.6 轮，完成列时主干接到终点；在跑的会话前面那段路是光点流动的路径；依赖从被等的任务的终点连到等它的任务的起点。位置只看先后，状态变了不动（光点除外）。

**远和中**：打开时是「远」（整个专题）：起点、主干、终点、等你的环和牌子、依赖弧，支线淡淡的。往里拉一点（`home + 0.3`，而且每轮间距不少于约 28 px）到「中」：每轮节点、「第 N 轮」、支线和支线节点、终点状态字（「终点 · 清单 2/5」「待验收」「已到达」）、起点日期。再近是所有节点的牌子。左下角读数显示现在在哪一档。

**场景**：照 `v-deck3.html#oblivion` 加了地面雷达（同心圆、虚线圈、刻度圈、十字）、切角外框和刻度、打开时从上往下扫出来的入场和扫描线、依赖弧（三层叠光）和弧上流动的光点。

**性能**：静态图层照旧只在数据变了重建；每帧只重建光点（每条路径 3 个）、等你准星、选中环。有会话在跑时光点按 20 帧一直动，有等你或选中时 30 帧；都没有时停。在预览里量（Edge，1600×900，AMO迭代 的快照，1 个会话在跑）：拖动时主线程约 160 ms/秒，停下后约 70 ms/秒（光点在流）。

**预览页**：`plans/userlayer/panorama-preview.html` + `panorama-preview/`（由 `panorama-build.mjs` 用 Vite 从 `ui/src/panorama/preview.tsx` 打包，和 Studio 用同一份页面、布局、引擎代码）。数据是 `panorama-snapshot.json`，由 `panorama-snapshot.mjs` 从跑着的 Host 只读取（GET `/api/state`、`/api/checklist`、`/api/topics/:id/canvas`），只留结构字段和标题：不带对话、任务和专题的说明、清单的文字、路径、凭据（Host 的 token 只用来读，不写进去）。`panorama-snapshot-demo.json` 是在真实快照上手改的演示数据（加了依赖、清单、一个等你、一个完成），页面顶上会标出来。

**验证**：单测 `datalayer.test.ts` 11 项（新加：树的轮次和分叉、一个会话开的会话合成一条支线、终点状态和清单、依赖过滤、树的布局、清单让终点变近、完成时路接上终点）；e2e `panorama.spec.ts` 加了：打开是远、读数、画布依赖画成弧、点区域名飞进去变成中、点普通节点弹窗写「第 1 轮」。预览用 Edge 经 Tailscale 地址截了远、中、弹窗（真实数据和演示数据各一组），图在 `studio/screenshots/userlayer/panorama-p1-*.png`。

## P1 补：底座、轨道、天际线（2026-11-02，只在预览里，等用户挑）

用户看了预览觉得每个任务中间一条线单薄：1 像素的线放在大框里比例失调，倾斜视角下贴地的线被压扁，每轮一样没节奏。试了四样，都是风格表 `themes.ts` 里 `PanoramaLook` 的开关（`track` / `pillars` / `plinth` / `drafting`），不是散落的判断：

| 后缀 | 开的 | 地址 |
|---|---|---|
| `#base` | 都不开（Studio 里现在的样子） | `http://100.107.87.64:47130/panorama-preview.html#base` |
| `#a` | 轨道 | `…#a` |
| `#ab` | 轨道 + 天际线 | `…#ab` |
| `#ad` | 轨道 + 底座（含工程图细节） | `…#ad` |
| `#abd` | 全开，预览的默认 | `…#abd`（演示数据：`?data=panorama-snapshot-demo.json#abd`） |

- **D 底座**（`plinth`）：区域不再是固定大小的大框，改成贴着树的胶囊形底座（淡色底 + 细描边），树多大底座多大（`layoutPanorama(data, { tight: true })`）；任务名和状态行挪到底座近边下方（远边会被高光柱戳到）；排布时按底座和名字谁宽占位。**E 工程图细节**（`drafting`）跟着底座开：远边外一条从起点到终点的尺寸线（每轮一个小刻度，中间写「N 轮 · 共多少小时」）、底座远边的小刻度、角上的坐标读数，不带别的信息。
- **A 轨道**（`track`）：从起点到终点一条带子，走过的一段填亮、两边发光，没走的只有淡轮廓一直到终点；每轮一道横刻度。支线是窄一些的带子。
- **B 天际线**（`pillars`）：每轮立一根光柱，节点在柱顶。高度按工作量，支线的矮四成，停了的变暗；在跑的那根有光点往上汇进柱顶、柱顶轻轻呼吸。远看也画。

**工作量**：datalayer 加了 `item.work = { minutes, weight }`。Studio 的状态里没有回合数（回合在会话的条目里），所以用时长：开始到结束（归档时间；在跑或在等你时算到现在；否则算到最后一次变化 `updatedAt`）；`weight` 取对数，10 小时以上算满（`workOf()`）。柱高 220 + 1900 × weight 米。

**性能**（Edge 1600×900，AMO迭代 快照）：拖动时主线程 `#abd` 约 142 ms/秒，`#base` 约 131；有一个会话在跑时停下后两者都约 58 ms/秒（光点在流）；没有会话在跑时两者都停（脚本约 1.5 ms/秒）。

截图：`studio/screenshots/userlayer/panorama-p1-abd-far.png`、`-abd-mid.png`、`-base-far.png`、`-base-mid.png`、`-demo-abd-far.png`。

## P1 再补：前锋、压缩、固定占地、共同流向（2026-11-02，只在预览里）

用户的四点和 A/B/D 的理由记在 `panorama.md`「节点的表达」。都是风格表 `PanoramaLook` 的开关（`front` / `fold` / `span` / `curve`），布局的参数在 `layout.ts` 开头（`SPAN`、`FOLD`、`CHEV`、`FLOW`、`SPIRAL`），Studio 还是 `#base`。

| 地址后缀 | 样子 |
|---|---|
| 不写 `#`、`#abd-flow` | 预览默认：A/B/D + 前锋 + 压缩 + 固定占地 + flow |
| `#abd-spiral` | 同上，路改成旋臂 |
| `#abd-wave` | 同上，路还是 P1 各自的小波浪 |
| `-nofront` `-nofold` `-nospan` | 拼在后面，去掉一样，比如 `#abd-flow-nofold` |
| `#abd`、`#base` 等 | 上一版的样子（不带这四样） |

长任务演示数据：`?data=panorama-snapshot-long.json`（`node plans/userlayer/panorama-demo-long.mjs` 从演示快照生成：加了「长任务演示」40 轮、「百轮演示」100 轮两个虚构任务）。

- **做法**：每个任务先在自己的直坐标里排（x 沿路，y 横过路），再整体映射到地图上。wave 就是平移；flow 是全专题一个只上下推、不前后推的场（两道正弦，随 y 慢慢错相），所以各条路一起弯、互相平行、不会折叠交叉；spiral 是每个任务一条旋臂（同一条螺线转不同角度，角度按任务宽窄分），从中心外一圈出发。底座、支线、刻度、尺寸线都是映射出来的，自然跟着路弯。名字：flow 放在底座近边弯得最低处的下面；spiral 放在臂的外端，按臂的朝向左右或上下对齐。
- **压缩**（`foldRuns`）：第一轮、最近两轮、开过会话或分支的、等你的、在跑的不压；其余连续 ≥3 轮压成一段。一段 n 轮占 `1 + 0.5·log2(n)` 轮的长度，开着关着一样长，所以打开它别处都不动；压着时节点挤在中间（柱子矮一半、按段长变暗），路上画 ⫽，下面写「×N 轮」，点它打开（变成「收起 N 轮」，再点收回），状态在 `PanoramaPage` 里；拉到「中」（`mid ≥ 0.6`，退回到 0.3 以下才收）全部打开，这时整个布局重排一次（量过：没有超过 50 ms 的长任务）。
- **固定占地**（`spacing`）：主干 10 轮以内照旧每轮 18；更长时总长按指数饱和逼近 15 轮的长度，位置用 `(e^κt − 1)/(e^κ − 1)` 分布，κ 让最新几轮间距约 1.1 轮、越早越挤；支线节点的最小间距跟着缩。终点离最前节点最多 54。40 轮和 100 轮的任务宽度差不到 5%（单测）。
- **前锋**：每个任务最前面的节点（x 最大，一样时取晚的）柱子至少 2700 米、比自己高四分之一，加宽光和柱顶光晕；从它往前到终点画 ›（完成的任务没有）。任务里有会话在跑时，箭头上有一道亮光一个接一个往前走、光点顺柱子往上灌；不在跑时箭头静止、暗一半。
- **性能**（Edge 1600×900）：真实快照 `#abd-flow` 拖动约 151 ms/秒，1 个会话在跑时停下约 62 ms/秒，没有会话在跑时停（脚本约 1.3 ms/秒）；`#abd-spiral` 拖动约 150、在跑时约 76；长任务演示（3 件等你按 30 帧、2 条依赖弧）拖动约 178、停下约 102。engine 包 824.68 kB（上一版 817.36）。
- **名字**（看 `panorama-p1-abd-far.png` 时发现名字和底座、前排光柱、终点圈叠在一起）：有底座时名字挂在底座近边下面 7.5 个单位，躲开角上的刻度；名字和状态行加深色牌子底（风格表 `name.plate`），前排的光柱、终点的光晕穿过来时被盖住；坐标读数从底座角上挪到名字下面当第三行（原来长名字会压到它）；有底座时行距 62 → 70；flow 的场随 y 错相从 0.005 降到 0.002，前后排弯得更一致。
- **验证**：单测 19 项（新加 6 项：哪些轮压、打开一段别处不动、40 轮和 100 轮占地相近、前锋和箭头、flow 和 spiral 的走向、地址后缀）；e2e `panorama.spec.ts`（Studio，`#base`）照旧通过；预览截图 `studio/screenshots/userlayer/panorama-p1-flow-*`、`-long-flow-*`、`-spiral-*`、`-long-spiral-*`。

## 0.3：专题和项目（2026-11-03，只在预览里）

用户看完 flow/spiral：路还是直线好。预览默认改成 `#abd-line`（直线 + 前锋、压缩、固定占地、底座、光柱、名字牌子底），`-flow` `-spiral` `-wave` 留作后缀。新的一层是**专题区块**（风格表开关 `blocks`，`-noblocks` 去掉；带后缀就开，`#abd` 等不带后缀的照旧没有）：一张全景上放几个专题，一个专题一块。Studio 里还是 `#base`。

### 数据（`DATALAYER_SPEC = "amo.datalayer/0.3"`，在 0.2 上加）

| 新的 | 字段 | 说明 |
|---|---|---|
| `topics[]` | `id` `title` `short` `goal` `status` | 一个专题一块。`goal`：专题说明的头一段（Studio 的 `topic.description`）；`status`：有任务在跑是 running，全完成是 done，其余 waiting |
| `projects[]` | `id`（`专题id/项目id`）`topic` `workspace` `title` `short` `status[]` `summary` `updatedAt` `by` | 专题里的一个项目，一条项目带。**`status` 是自由的字段表** `{label, value, tone?}`（tone：good / warn / bad / info），写什么由专题自己的规范定，以后由专题的专项管理 agent 按规范填；最后总有一行默认的「任务 N 个 · M 在跑 · K 完成」。`summary` 一句话，`by` 谁写的（例如「专项管理 · 第 5 轮」） |
| `docs[]` | `id` `topic` `kind`（spec / doc）`title` `summary` `updatedAt` | 资料架上的一份。标题里有「规范」算 spec；`summary` 是正文头几行（去掉标题行和标记，最多 240 字），快照没带正文时是空的 |
| `lanes[]` 加 | `topic` `project` `proposedBy` | 任务属于哪个专题、哪个项目；`proposedBy`：哪一轮主控提出的它（专题自己会话的 id），有就从主控脊连一条线到它的起点 |
| `items[]` 加 | `type`（session / decision / question / finding / note）`topic` `of` `body` | `lane` 可以是 null：专题自己的会话（主控脊，每个一轮）和公告板上的条目。决定、问题、发现、便签也是 item：`of` 是它出自的会话——那个会话是任务的一轮时，它挂在那一轮的柱子旁边；出自主控或没有出处时放公告板 |

输入（`PanoramaInput`）多了 `topics` `workspaces`（项目名）`docs`（专题文档，正文可省）`reviews`（画布上的审阅条目）`extra`。`extra` 是 Studio 现在还没有的东西，预览的演示数据用它：`projects`（`专题id/项目id` → 状态字段、一句话、谁写、时间）、`proposedBy`（任务 → 主控会话）、`cards`（决定、问题、发现、便签，可以挂在某个会话上，`needsYou` 算等你）。

Studio 的状态怎么对上（能取就取，取不到先空着，没为此改 Host）：专题说明 → `goal`；专题文档 → 资料架（Studio 的 `TopicDoc` 有正文，快照脚本只取标题时 `summary` 为空）；专题的项目（`topic.workspaceIds` 加上任务所在的项目）→ 项目带，状态只有任务数那一行；画布的审阅条目 → 公告板（confirmed、done 算决定，discuss 算问题，todo 算发现，parked 算便签）；`session.topicId` 有值、没有 `taskId` 的会话 → 主控脊。`proposedBy` 和挂在轮上的条目 Studio 里还没有。

### 画法（`layout.ts` 的 `planBlocks` / `placeBlocks` / `blockOut`，`engine.ts` 的 `blockLayers`）

- **远**（看全部专题）：每个专题一块框，框上面是专题名、目标、每个项目一行（名字 + 前两个字段，超标的带 !）、几件等你、在不在动、几个任务；文字按这一级的缩放裁到不超过框宽。任务只画成细线（走过的一段亮，往终点的一段暗，终点一个点）；项目带的底色和主控脊也淡淡画出来；等你的事是脉动的圈。点专题名或框飞进去。
- **中**（专题里面）：从西往东四列——资料架（一份一块牌子：类型和标题、头一行、更新时间）、公告板、主控脊（专题自己的会话一轮一个点，顶上「主控 · N 轮」，到它提出的任务起点各一条细线）、项目带（一个项目一条，带头是项目状态牌，后面是这个项目的任务，两个一排）。块里的文字按 `BLOCK_ZOOM`（约 10.6）排；进专题时镜头压到 40°，块太大时只框西北角（资料架、公告板、主控、前几条带），不会退到比 `BLOCK_ZOOM` 更远。
- **近**：任务的轮次和牌子（原来那套），挂在某一轮上的条目在那根柱子旁边一个点，拉近后显示「决定 · …」。
- 点资料架的牌子、公告板的条目、柱子旁的条目、主控脊的点都会弹窗（`PanoramaPage` 的 `DocWindow` / `PointWindow`，主控会话用原来的窗口）。

### 演示数据

`?data=panorama-snapshot-topics.json`，`node plans/userlayer/panorama-demo-topics.mjs` 生成：「AMO迭代」是真实快照（补上了它的项目名）；「mining 迭代」（三个项目：客户端看版本/包体/帧率，服务端看部署环境/在线人数/接口错误率，策划配置看配置表进度/待评审；五份资料里四份规范，其中「项目状态牌规范」写了每个项目的牌子看什么；主控 5 轮，6 个任务是主控提出的；6 张卡片，2 件等你）、「官网改版」（一个项目两个任务一份规范）、「美术资源管线」（工具 + 资源库两个项目，字段不同；「贴图自动压缩」已到终点）是虚构的，页面顶上写着「演示」。

### 验证

单测 22 项（新 3 项：专题、项目、资料、主控脊、proposedBy；条目挂轮或上公告板、审阅条目按状态分；区块布局——块不重叠、项目带不重叠、任务在自己的带里、主控连线落在任务起点、spiral 或不开时没有区块；地址后缀的期望改成带 `blocks`）。

## 世界：区域 = 专题（2026-11-03 晚，只在预览里）

用户嫌胶囊底座不好看，要「区域和线路」既能分区又有不规律的美感。草图在 `sketches.html`（`sketches/gen.mjs` 按种子生成，截图 `screenshots/userlayer/sketch-terrain-*.png`、`sketch-metro-*.png`），用户定了地形岛和地铁两个主题，决定记在 `panorama.md`「已定 · 区域和线路」。这一版把草图搬进全景。

**地址**：`#terrain`（预览默认）、`#metro`；加 `-pillars` 打开每轮的光柱对比。旧的 `#base` `#a` `#ab` `#ad` `#abd` 和 `-line` `-flow` `-spiral` `-wave` `-no…` 都还在（世界主题不接 `-flow` `-spiral` `-wave`，路只能是直线）。Studio 里还是 `#base`。

### 代码

- `ui/src/panorama/regions.ts`（新，纯函数，不依赖 deck.gl 和 AMO）：从 `gen.mjs` 搬来的距离场 + 噪声 + domain warp + marching squares（地形岛），粗格子 + 只留拐角（地铁），海湾切法（`cutStyles`：主控区不切、项目之间东西轮换、不够深不切）、地铁的切角分界（`headedBands`，裁到轮廓里面，deck.gl 没有 clipPath，用多边形裁剪做）、专题错落摆放（`placeTopics`）。草图里的参数原样保留，算法在草图的单位里跑（一轮草图 26、这里 18，`K = 18/26`）。**种子从专题 id 来**（FNV-1a），同一个专题每次形状一样；形状按专题的几何缓存，展开压缩重排时不再算。顺手修了草图的两个毛病：轮廓挂出细长尖刺（对场做一次开运算——先腐蚀再膨胀两格——再按线路托底），东湾贴着 lane 的那条边像刀切（湾里留给线路的地加了一圈噪声起伏）；岛外的碎块只留最大的那块。
- `layout.ts`：`LayoutOptions.world`（`terrain` / `metro`）。`planWorld` 按草图 `layoutTopic` 在专题自己的坐标里排：上面是头（名字 + 一行数字）、书架（一份文档一本书）、公告板（前三条），左边主控脊（专题自己的会话一轮一个点），下面一个项目一条带：带头状态牌，后面一个任务一行直线 lane（行高按它的子 lane 有几条），lane 从状态牌往东一段开始（地铁：从状态牌旁的始发站成束出来 45° 拐上自己那一行，项目带左右错开）。然后 `regions.ts` 算形状、`placeTopics` 摆位置。输出 `PanoramaLayout.world`（每个专题：轮廓、往里的光晕圈、各部分的填充、分界虚线、头、主控脊、状态牌、书架、公告板）和 `dots`（地铁的点阵底）；`RegionLayout` 加 `tint`（项目序号，地铁的线路颜色）、`pre`（地铁的出站线）、`tick`（起点刻度）、`goalRing`（终点虚线圈）、`branches[].merge`。子 lane 在世界里全排在主干南边，第 k 条在 15·k 处，45° 分出，最后一个会话有 `mergeInto` 而且并回点在更前面时 45° 并回。节点贴地；前锋的光柱照旧（`top`）。
- `themes.ts`：`PanoramaLook.world`；`LOOKS.terrain` / `LOOKS.metro`（前锋、压缩、固定占地开，底座、轨道、工程图、每轮光柱关，直线）；`THEMES.terrain` / `THEMES.metro`（冰白全息的色值不变）；风格表新段 `world`（项目色、岛和地铁的填充 / 轮廓 / 分界 / 点阵、lane 线、刻度、前锋点、头的字号）。`PREVIEW_LOOK = "terrain"`。
- `engine.ts`：`worldLayers`。远（看全部专题）：轮廓、分区填充、分界、头（专题名 + 「N 项目 · N 任务 · N 在跑」，等你金色）、主控脊、空白的状态牌 / 书架 / 公告板、直线 lane、起点刻度（地铁是始发站）、前锋亮点和光柱、终点虚线圈、等你的脉动圈；点专题名或岛飞进去。中（专题里面，`inside`）：状态牌上的字（项目名、一句话、字段，最多三行，多的写「另 N 项」，有等你的牌子左边一道金边）、书脊上竖排的标题（点开是文档窗口）、公告板的条目（点开是条目窗口）、主控节点、lane 名字（在起点上面）、每轮节点、子 lane 分叉 / 并回处的圈。近：第 N 轮和所有牌子（照旧）。旧的区域底座、框、起点光柱、终点图标、区域名下的那行字在世界主题里不画。探针加 `world`，`blockHead` 也认世界的专题名。

### 数据

`items[].mergeInto`（0.3 里加，可空）：支线最后一个会话并回到主干的哪一轮。Studio 里没有这个概念，只从 `extra.merges`（支线会话 → 主干会话）来，并且只认同一任务主干上的轮。演示数据里「新矿洞玩法 · 客户端」第 2 轮的分支并回第 4 轮。

### 验证

- 单测 27 项（新 `world.test.ts` 5 项：后缀；同一个 id 形状一样、换 id 不一样、一个项目的专题只有一块地没有湾；摆放可重复、互不重叠；两个主题下演示数据每个专题一块、每条 lane 的起点、终点、节点都在本专题的陆地上，状态牌在陆地上，lane 是直线，子 lane 在主干南边、并回的落在第 4 轮上，地铁的 lane 都从始发站出来，重排时形状取缓存）。
- Node 里量的排布时间（4 个专题）：地形岛第一次约 0.94 s、再排约 40 ms；地铁约 0.43 s、再排约 9 ms。
- Edge（Tailscale 地址，1600×900）：`#terrain` `#metro` 的远、中（点「mining 迭代」的名字进去）、近，真点了一次等你（「删掉旧版本 UI 图集」）和一个节点（「按权重表走服务端」）都弹出窗口；`#terrain-pillars` 和旧的 `#abd-line` 也打开看过。截图 `screenshots/userlayer/panorama-world-{terrain,metro}-{far,mid,need,node,near}.png`。

### 字贴在地上（11-04）

用户看完预览：只有立在光柱、节点上的牌子正对镜头，其它字都印在地上（决定记在 `panorama.md`「已定 · 字贴在地上」）。

- `engine.ts` 的 `ground()`：TextLayer `billboard: false`、`sizeUnits: "meters"`，字号用布局单位写在风格表 `world.type`（`title 20`、`info 8`、`text 5`、`label 4`、`lane 4.6`、`round 3.4`、`fold 3.8`，一个单位约 111 m），乘 `M_PER_UNIT` 换成米。字的「上」朝北，lane 往东走，所以 lane 名、「第 N 轮」沿着 lane；书架上的书名转 −90° 顺着书脊。
- 贴地的：专题名、一行数字（「· 2 等你」紧跟在后面，位置按 canvas 量的字宽）、主控、状态牌上的字、书名、公告板的标题和条目、lane 名、「第 N 轮」（节点南边）、终点的状态字、「×N 轮」。照旧正对镜头的：等你的牌子、节点牌子、近处每轮的牌子。
- 语义缩放：中景的字跟着「专题里面」淡入（原来的阈值）；专题名和那行数字按它在屏幕上大概多少像素淡出（`legible`：专题名小于约 7 px、数字小于约 8 px 就藏），所以远景只看到专题名。
- 避让：世界主题里 lane 名不再在牌子的避让里占位（字在地上，和地上的东西一起排好了）；牌子之间的避让照旧。
- 顺手修了小号 j 不显示（`glyphs`，原因见 `panorama.md`），所有主题都受益。

验证：类型检查、单测 27 项、`npm run build`、e2e `studio/panorama.spec.ts`（1 项，Studio 的 `#base` 截图看过，字正常）、预览重建。Edge 截图 `screenshots/userlayer/panorama-world-{terrain,metro}-{far,far-rot,mid,mid-rot,need,node,near,near-rot}.png`，`-rot` 是按住 Ctrl 拖转了视角的（远 35～46°、中 281～292°、近 41～45°），贴地字跟着地面转，牌子还正对镜头。

### 区域包住内容、近处的字用 SDF、开场动画（11-04 晚）

用户看了贴地字的版本提了三件事。

**1. 区域没包住内容（bug）**：`#metro` 的 mining 中景，公告板伸出了轮廓。原因：形状只按 lane 和几块面的大致范围算，切角、噪声、海湾之后没再查一遍。
- `layout.ts` 的 `planWorld` 给每个专题列一张「必须是陆地」的表（`TopicFrame.must`，边距 `margin`：地形岛 9、地铁 7 个单位）。表里有：头（框、专题名、那行数字，按字宽量）、书架和公告板（连同上面的小标题）、主控脊和它的标题、每张状态牌、每条 lane 的线和出站线、lane 名、「第 N 轮」、终点圈和字、子 lane（往南多留一截给它的字）。字宽用 `groundW`（中文一个字号宽，其它 0.62 个），字号表搬到 `layout.ts` 的 `WORLD_TYPE`，风格表直接用它。
- `regions.ts`：地形岛在开运算之后把「离 must 不到 margin 的格子」抬成陆地，`dropIslets` 之后再抬一次（防止被当碎块去掉）；地铁的粗格子里，中心离 must 不到 `margin + C·√½` 的格子四个角都算陆地。
- 单测 `world.test.ts`「keeps all of a topic on its land」（两个主题各一项）：演示数据 4 个专题，头的字框、状态牌、书架和标题、公告板和标题、主控脊和标题，lane 上的每个点（走过的、前面的、出站线、刻度、`›››`、终点圈）、lane 名框、终点字框、子 lane、「第 N 轮」的字框，四角都在轮廓里、不在海湾里（300 多个点，一个不落）。不修时地铁报「AMO迭代: 公告板」「mining 迭代: 公告板 (label)」。
- 截图：`screenshots/userlayer/panorama-fit-metro-mid{,-rot}-{before,after}.png`。

**2. 字能不能无损缩放**：选了「大字 SDF、小字位图」。
- 每个贴地字图层有一个 SDF 的双胞胎（id 加 `~sdf`）：字在屏幕上（按视图中间的缩放）小于 24 px 用位图图集，大于等于 24 px 换成 SDF 图集，同一时刻只画一个。SDF 是自己算的（`glyphs.ts` 的 `sdfFromAlpha`：Felzenszwalb 距离变换，64 px 字、半径 8、cutoff 0.25），因为 deck.gl 只要传了 `_getFontRenderer` 就不用它自带的 TinySDF。边缘的柔化量（`smoothing`）按屏幕上的字号算，分档（每 1/3 个 2 倍一档），档变了才换图层属性。
- 小字不用 SDF：上次全用 SDF 时中文小字碎成点，就是 64 px 的距离场缩到十几像素时笔画采样不到。
- 数字（Edge，1600×900，中景字最多的视角）：拖动时主线程每帧 3.3 ms → 3.5 ms，帧间隔 5.9 ms 不变；拉近、拉到最近都没有长任务。图集：位图 1024×2048（247 个字）、SDF 1024×2048（224 个字），各约 8 MB RGBA。
- 没选的：(a) 按缩放分档重新栅格化——拉到最近时一个中文字要 128 px 以上，CJK 图集会超过纹理上限或要约 64 MB，而且换档时整张图集重画会卡；(c) 字形转几何——浏览器拿不到字体文件的轮廓（Electron 能，但要带字体文件、有授权问题），中文三角化约百万个三角形，小字还会有锯齿。
- 截图：`screenshots/userlayer/panorama-text-terrain-{near,max}-{before,after}.png`、`panorama-text-terrain-max-compare.png`（上 before、下 after，拉到最近）。

**3. 打开太久 → 开场动画**：
- 形状挪进 Web Worker：`regions.worker.ts`（收 `{key, frame, kind}`，回形状和耗时），`shapes.ts` 的 `requestShape` 管排队和缓存，worker 起不来或出错就退回 `setTimeout` 一次算一个专题。预览包里是 `panorama-preview/assets/regions.worker-*.js`。
- 缓存：`shapeKey` = 主题 + 专题的整个 `TopicFrame`（id、几何、must，0.1 取整）的 JSON，命中就不算；超过 64 个清空。只在页面（窗口）里，刷新就没了。
- 入场（`engine.ts` 的 `INTRO`）：扫描线从西往东扫过地面、身后留下网格（然后淡掉），扫过的地方每个专题先是一个呼吸的框和点；专题的形状一到就开始（专题之间至少隔 170 ms）：轮廓被一支笔描一圈（0～520 ms）→ 面和内发光淡入（200～700）→ lane 从起点往前长、节点被路走到时亮起（460～1060）→ 贴地的字淡入（880～1280）；最后一个专题之后 1150～1450 ms 等你的牌子弹出，流动的光和依赖弧最后进来。播的时候每个专题一组图层（id 加 `@k`），播完合成一组。
- 只在第一次排布、有形状没算过的时候播；换主题回来直接出（缓存）。展开 / 收起压缩的轮会改 `must`，形状要重算：先用这个专题上一次的形状，新的算完再换上，不播开场。
- 数字（Edge，1600×900，preview 打包版）：

  | | 地形岛 | 地铁 |
  |---|---|---|
  | 开场开始（离导航） | 1359 ms | 1397 ms |
  | 开场长度 | 2957 ms | 2667 ms |
  | 开场中的帧 | 354 帧，中位 5.9 ms，p95 6 ms | 316 帧，中位 5.9 ms，p95 11.7 ms |
  | 开场中的长任务 | 无 | 1 个 130 ms（+1.3 s） |
  | 播完合图层 | 304 ms 长任务 | 287 ms 长任务 |
  | 第一次换到另一个主题 | 2660 ms（它自己的开场） | 2858 ms |
  | 换回来（缓存） | 310 ms，不播 | 292 ms，不播 |

  改之前：打开地形岛整页卡约 2.8 s 才出图，期间什么都不动。
- 发现：着色器编译是同步的（luma.gl 链接完马上读属性，`compilation-status-async-webgl` 帮不上），ANGLE 还会把一部分编译拖到第一次画。所以开场前先画一遍透明的「热身」图层（多边形、线、点、图标、字各一个），第一帧之后两个 rAF 才开始计时，编译的约 0.9 s 长任务落在开场之前（这时页面只有空地面）。播的时候图层按需交给 deck（还没出现的不给），图集上传从 664 ms 降到 84 ms。
- 截图：`screenshots/userlayer/panorama-intro-{terrain,metro}-{1,2,3,4}.png`（开场后 +150 / +550 / +1000 / +1500 ms）、`-5-done`（播完）、`-6-back`（换主题再回来）。

验证：类型检查；单测全量 1213 项里 1 项失败（host 的 DSH 集成测试「session_start with write in a folder not set up」，全量负载下超时，单独跑通过，这次没碰 host），全景 29 项都过；`npm run build`；e2e `studio/panorama.spec.ts` 1 项过（截图已还原）；预览正常打包（`panorama-build.mjs` 加了 `PANORAMA_NOMINIFY=1` 出不压缩的包，查性能用）。Edge 里两个主题的远、中、近、旋转，点等你和节点都弹窗。

### 滚轮缩放（11-04 晚）

用户：快速连续滚动、来回拉近拉远时有明显掉帧的感觉。先测再改。

**怎么测**：Edge 1600×900（屏幕 170 Hz，一帧 5.9 ms），在 mining 上用 CDP 发真的滚轮事件，三种滚法各来回 3 次：鼠标快滚（14 格，每格 deltaY 100，隔 30 ms）、鼠标慢滚（9 格，隔 110 ms）、触控板（110 次 deltaY 9，隔 10 ms）。记帧间隔、长任务（PerformanceObserver）、逐帧的 zoom、引擎计数（探针 `stats`：重排次数和耗时、牌子排版次数），用 CPU profile 看长任务里是谁。改前改后都用不压缩的包、不开 profile（开 profile 本身会多出 100 ms 上下的帧）。

**改前找到的来源**：
1. 滚轮本身：deck.gl 的 `scrollZoom: { smooth: true }` 每个滚轮事件都从「镜头现在的位置」重起一个 250 ms 过渡，连续滚动时目标一直被重置：快滚 14 格只走了约 1.6 级，触控板 110 次只走了约 0.7～0.9 级，动起来一顿一顿。
2. 压缩的轮在缩放中途展开 / 收起：跨过「中」的阈值就重排（`relayout`），慢滚 3 个来回重排 26～30 次。每次重排重建所有图层；每个字图层各有一份字体图集纹理（deck.gl 的做法），新图层、或图集多了一个字，都要再传一份 8 MB 的纹理（profile 里是 `_transferState → createTexture → texSubImage2D`），一次 100～390 ms。
3. 牌子排版、SDF 字切换不是来源：排版一次不到 1 ms（但新牌子的字要重算顶点，约 35 ms，在下一帧）；SDF 图集开场结束时已经生成（之后探针一直是 `S223@2048`），第一次拉近不再生成。

**改了什么**（`engine.ts`，新文件 `sharedText.ts`）：
- 自己接滚轮（`scrollZoom: false`，`onWheel` / `wheelStep`）：每个事件把目标 zoom 往前加（多少按 deck.gl 原来的曲线，`WHEEL.speed`），每帧走剩下距离的 `1 − e^(−dt/85ms)`，最快每秒 14 级（快滚在 60 Hz 屏上不会一帧跳半级）；鼠标下的地面点每帧都留在鼠标下（`zoomAbout`）。触控板捏合（浏览器发成 Ctrl + 滚轮）的增量乘 2.5（没用真触控板试过，手感要用户看）。按下鼠标、飞行（点按钮、点专题）会停掉它。
- 缩放中不做重活：压缩的轮只在镜头停下 300 ms 后才展开 / 收起（`FOLD_SETTLE`，中途又动就取消），牌子只在停下后排；探针的 `busy` 也等这一下。展开本来就有滞回（打开在「中」0.6，收起在 0.3）。
- SDF 交接改成一段重叠：字在屏幕上 22～27 px 时 SDF 的字盖在位图字上渐显，满了位图才撤，不在一帧里替换，停在阈值上也不闪。SDF 字边的柔化量改走字符子层的属性（`_subLayerProps.characters.smoothing`），原来改 `fontSettings` 会让整层的字重新排一遍。
- 字体图集纹理共享（`SharedAtlasTextLayer`）：一个图集只上传一份纹理，所有字图层共用；图集变了只传一次；没人用的旧纹理 2 s 后删掉（`sweepAtlases`）。原来每个字图层各有一份；现在停下来后共 4 份（探针 `stats.atlasTextures`，位图和 SDF 各有还在被旧图层用着的上一版）。

**数字**（改前 → 改后；中位帧间隔都是 5.9 ms）：

| 主题 · 滚法 | zoom 走到 | p95 / 最大帧 | >33 ms 的帧 | 长任务 | 中途重排 |
|---|---|---|---|---|---|
| 地形岛 · 鼠标快滚 | 9.24～10.86 → 7.94～14.20 | 6.0 / 11.9 → 6.0 / 40.0 ms | 0 → 1 | 0 → 0 | 0 → 0 |
| 地形岛 · 鼠标慢滚 | 9.25～12.77 → 7.94～13.52 | 11.8 / 364.8 → 11.8 / 26.3 ms | 22 → 0 | 18 个（最长 367 ms）→ 0 | 26 → 0 |
| 地形岛 · 触控板 | 9.90～10.77 → 7.94～14.20 | 11.8 / 31.9 → 11.8 / 99.9 ms | 0 → 2 | 0 → 2（82、55 ms） | 0 → 2（停稳后） |
| 地铁 · 鼠标快滚 | 9.24～10.87 → 7.94～14.20 | 6.0 / 6.0 → 6.0 / 6.0 ms | 0 → 0 | 0 → 0 | 0 → 0 |
| 地铁 · 鼠标慢滚 | 9.27～12.26 → 7.94～13.52 | 6.0 / 158.8 → 11.8 / 30.7 ms | 3 → 0 | 3 个（最长 162 ms）→ 0 | 30 → 0 |
| 地铁 · 触控板 | 9.26～9.97 → 7.94～14.20 | 11.8 / 35.3 → 11.8 / 58.8 ms | 1 → 2 | 0 → 1（51 ms） | 0 → 4（停稳后） |

- 改前快滚和触控板的帧看着干净，是因为根本没走远（停在远景，没跨过任何阈值）。改后三种滚法都走满全程（7.94 是最远的限制，14.20 是最近的限制）。
- 改后剩下的长任务都在「停稳 300 ms 后展开 / 收起压缩的轮」那一下：一次约 60 ms（排布 16 ms、deck.gl 更新图层 40 ms，其中新字形那次图集上传 8 ms）；改前同一件事要 100～390 ms 还在缩放中途。再往下压要让没变的图层不重建，这次没做。
- 改前慢滚在两次运行之间差别不小（另一次地铁 13 个长任务、最长 301 ms，地形岛 17 个、最长 393 ms）。
- 顺带：共享纹理后换主题快了（地铁开场收尾的长任务 225 → 68 ms，换回地形岛 310 → 165 ms 稳定）；开场结束合成图层仍约 300 ms。

**锚点和样子**：鼠标放在一个节点上滚 3 格进、再 4 格进、再 3 格出，节点离开鼠标 1～11 px（拉到近景时压缩的轮展开，节点本身挪了一点）。SDF 交接区间（z 12.07～12.81，「第 N 轮」从位图换成 SDF）每 0.15 级截一张，字没有重影：`screenshots/userlayer/panorama-wheel-{terrain,metro}-handover-{1..6}.png`。

验证：类型检查；单测全量 1213 项里 1 项失败（`platform.test.ts` 的「重启 Studio」那项，全量负载下读不到状态，单独跑 16 项全过，这次没碰 platform）；`ui` 单测 327 项全过；`npm run build`；e2e `studio/panorama.spec.ts` 1 项过，新加了一段：从全景滚 6 格，能一路拉到「中」，鼠标下的节点不离开 12 px（截图已还原）；预览重新打包（压缩版）。

## Studio 的全景页换成新画法（11-04 晚，framework.md 第 0 步）

- **入口**：左边栏「全部任务」下面一行「全景」（`ScopeNav` 的 `panorama`，`data-testid="nav-panorama"`），只在「设置 → 测试功能 → 全景」开着时有；看板 / 画布那排选项卡里不再有「全景」。打开时左边栏留着，全景占右边主区域；全景在前时范围那几行都不亮，从全景打开的任务也算在全景里（入口亮着，「←」回全景）。左栏折叠成窄条时没有这个入口。
- **画法**：地形岛 / 地铁两个世界画法（贴地字、开场动画、worker 算形状、平滑缩放都在），右下角「地形岛 | 地铁」切换，记在本机 `localStorage["amo.panorama.look"]`，默认地形岛。换画法是重建整张图（`key`），会再放一次开场动画。`#base` 那套 P1 画法 Studio 里不再用，预览里还能看。
- **数据**：每个没归档的专题一块，没有专题的任务一块「没归专题的任务」（datalayer 的 `loose`，`LOOSE_TOPIC = "loose"`，按项目分带；没有就不画）。`view.tsx` 给每个专题读画布（依赖 → 弧线，审阅条目 → 公告板）和专题文档（书架），跟着 `canvas.updated`、`topicdoc.*` 和重连更新；专题说明 → 目标，专题自己的会话 → 主控脊，分支和 session_start 开的会话 → 子 lane。Host 没改。
- **快照**：`panorama-snapshot.mjs --all [数据目录]` 写 `panorama-snapshot-all.json`（每个专题 + 没归专题的任务；专题文档和审阅条目只带标题，项目只带名字，不带专题说明）；预览 `panorama-preview.html?data=panorama-snapshot-all.json#terrain`。
- **真实数据（11-04 21:17 快照）**：3 个专题 + 没归专题的任务 37 个里没归档的那些，共 24 个任务、126 个会话、11 个项目、1 份专题文档、38 条审阅条目；地形岛开场到停稳约 5.4 s，地铁约 3.3 s（预览，Edge 1600×900）。截图 `screenshots/userlayer/panorama-all-{terrain,metro}.png`。
- **验证**：类型检查；`ui` 单测 328 项全过（新加：没归专题的任务一块、按项目分带、没要或只有归档的不画、一个专题都没有时只画它一块）；全量单测 1214 项里 1 项失败（host `peer.test.ts` 的 session_start 报告那项，单独跑也超时 5 s，这次没碰 host）；`npm run build`；e2e `studio/panorama.spec.ts` 改成新入口和新画法，过；全量 studio e2e 跑到一半时失败的 attachments / board / mailbox / dsh 各项单独重跑都过（负载抖动），cli.spec 的 Codex 压缩是 master 上已修的那项（ac09e379，本分支还没合）。截图 `screenshots/studio/panorama-{settings,entry,far,need-1,node,metro,list}.png`，别的 e2e 顺带改写的截图已还原。

