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
