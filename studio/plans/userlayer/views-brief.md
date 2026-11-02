# 给做表达示例的会话：共用说明

## 背景

用户在试一个三层架构（先读 `README.md`）：datalayer 是 AI 看得懂的结构化数据，userlayer 是给人看的表达，表达可以随便换。用户觉得看板、流程图、画布都偏「逻辑」，要先学规则才能看懂。他想回归人天生就会的能力，要求是**不用学**：第一次打开不看说明就知道怎么用，几秒内知道「有几件事等我、最要紧的是哪件」。

这批示例一共 9 种表达，用同一份假数据（`sample.json`：AMO 中转 0.7.x 的审核），用户会挨个打开比较，然后决定往哪个方向走。所以每一种都要**把那个比喻做足**，像真的产品原型，而不是同一个列表换几种皮。

## 文件和工具（都在 `studio/plans/userlayer/`）

- `_template.html`：复制它开始。标记区里的样式、数据、读写层不要手改，由 `sync.mjs` 灌进去。
- `lib.js`：只通过 `window.AMO` 读数据、做操作，**不要改 `lib.js`、`sample.json`、`sync.mjs`**。缺什么就在页面里自己写；觉得读写层该加东西，写在最后的回报里。
- 常用接口：
  - 查询：`AMO.data`（context/viewer/areas/agents/items/links/events）、`AMO.items(pred)`、`AMO.item(id 或 num)`、`AMO.agent(id)`、`AMO.area(id)`、`AMO.links(id)`（返回 `{out:[{rel,label,note,item}], in:[…]}`）、`AMO.needsYou()`（按重要程度排好）、`AMO.counts()`、`AMO.isNew(item)`（上次看过之后 agent 改过）、`AMO.changesSince()`、`AMO.lastSeen()`；
  - 文字：`AMO.ownerName(owner)`，`AMO.TYPE / STATUS / REL / EVIDENCE`（中文标签；`STATUS[s]` 有 `label`、`sym`（! ◐ ○ ✓ –）、`color`、`soft`），`AMO.md(text)`（简单 Markdown，`#5` 会变成 `<a class="amo-ref" data-num="5">`，记得接住这个点击，跳到那一条），`AMO.esc`、`AMO.fmtTime`、`AMO.ago`；
  - 操作：`AMO.answer(id, optionId, note)`、`AMO.park(id, note)`、`AMO.reopen(id)`、`AMO.comment(id, text)`、`AMO.markSeen()`、`AMO.reset()`、`AMO.toast(msg)`、`AMO.toggleTheme()`；
  - 订阅：`AMO.on(render)`，数据一变（包括在别的表达里操作过）就会回调。
- 做完一个文件：在 `studio/` 下跑 `node plans/userlayer/sync.mjs`，再跑 `node plans/userlayer/shot.mjs v-xxx.html`（浅色、深色各一张，存到 `studio/screenshots/userlayer/`，输出里有页面报错）。
  - 要截交互后的样子：加 `--click "选择器" --tag 名字`。
  - **用 Read 打开截图看一遍**：文字溢出、重叠、看不清、深色下颜色不对，都要修。至少看总览和「点开一条」两个状态。

## 每种表达都要有的

1. **一眼看到**：有几件事等你，最要紧的是哪件（`needs_you`，`importance` 高的更显眼）；哪些是上次以来新变的（`isNew`）。
2. **点开一条**：能看到摘要、正文、证据（`evidence`）、关联（`links`，可以跳过去）、谁提的、现在在谁手里。
3. **回答**：`ask` 的选项按钮，推荐项要标出来，并写理由（`ask.why`）；可以附一句话；另外还要能搁置。回答后表达里要看得出「已交回某某 agent，在进行中」。
4. **其它状态也要表达出来**：进行中、等别人（谁）、已定（结论）、搁置。agent 在干什么（`agents[].doing`），按比喻需要来体现。
5. 右上角：「← 全部表达」（`index.html`）和深浅色切换。另放一个不起眼的「恢复假数据」（`AMO.reset()`）。

## 规矩

- 单文件，不引任何外部资源：不用 CDN，不引外部字体、图片、脚本。图形用 CSS、内联 SVG、canvas 画。
- 不加装饰性图标和 emoji。状态用 ✓ ◐ ○ ! – 加文字表达，不能只靠颜色。
- 浅色、深色都要好看。颜色尽量用样式里的变量（`--bg --surface --line --text --accent-fill --s1 --s2 --s3 --good --warn` 等）。比喻需要自己的质感时（木桌、纸、报纸），浅色和深色各调一套。
- 字体：标题和正文用衬线 `var(--serif)`，标签和数据用 `var(--sans)`，代码用 `var(--mono)`。
- 界面文字用中文，写得具体、直白。不要在页面上写大段「怎么用」的说明：不用学，就体现在不需要说明。
- 窗口按 1440×900 设计，1280×800 也不能坏。
- 页脚或角落注明：数据 `studio/plans/userlayer/sample.json`（假数据）。
- 不提交 git，不改这个文件夹以外的文件（截图除外）。

## 回报

做完回报：

- 每个文件实现了什么，哪些交互能用；
- 截图路径；
- 你觉得这种表达好在哪、不够在哪（一两句，诚实）；
- 对 `lib.js` 或数据规范的建议（如果有）。
