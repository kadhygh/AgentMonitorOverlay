// 第 0 章的概念图：平台装哪些工具，Studio 里 专题 / 项目 / 任务 / 会话 是什么关系。点方块看说明。
// 宽窗口和窄窗口（手机宽度）各有一套坐标，同一份方块和说明；说明里的 [[按钮名]] 和正文一样会被单测核对。
(function () {
  const T = (globalThis.AMO_TUTORIAL = globalThis.AMO_TUTORIAL || {});

  /** id, 名字, 一行小字, 说明（行内格式）, 宽版 [x, y, w, h], 窄版 [x, y, w, h], 虚线框 */
  const NODES = [
    ["platform", "AMO 平台", "登录 · 装工具", "托盘常驻的管家：用团队服务器的账号登录（登录只在平台里做），从服务器装、更新工具，有测试和稳定两个通道，装坏了能在 [[⋯]] 里回到上个版本。[[环境]] 页查 Claude Code、Codex、git 装没装；[[目录]] 页设 Studio 的数据目录。不装平台，各个工具也能单独用（要登录的功能除外）。", [16, 150, 146, 64], [16, 12, 308, 52]],
    ["studio", "AMO Studio", "工作台", "每天主要用的工具：看板、任务、和模型（Claude、Codex、DeepSeek）的会话、画布。自带便签和 Reviewer，不用另装。会话跑在后台（Host）里，关掉窗口会话照样跑。", [196, 14, 548, 290], [24, 92, 300, 444], true],
    ["topic", "专题", "相关任务，可跨项目", "比任务高一层：把相关的任务放在一起，可以跨几个项目（比如「3.2 版本」下面有客户端和服务器的任务）。左栏 [[专题]] 那一行的 `+` 新建。专题也可以有自己的会话，用来协调下面的任务。只做一件小事时可以不用。", [222, 66, 130, 54], [38, 152, 128, 50]],
    ["canvas", "画布", "专题的全局图", "每个专题一张：任务卡片、分组、依赖、便签，AI 也能在上面铺审阅条目、向你提问。看板旁边的 [[画布]] 页签打开，[[小窗]] 把它放进一个置顶的小窗。", [440, 30, 130, 46], [38, 246, 128, 46]],
    ["project", "项目", "电脑上的文件夹", "一个文件夹，通常是 git 仓库。左栏 [[项目]] 那一行的 `+`（还没有项目时是 [[+ 添加项目]]）登记。任务的会话在这个文件夹里跑命令、改文件；git 项目能开 Git Review。", [222, 196, 130, 54], [182, 152, 128, 50]],
    ["common", "公共目录", "没选项目时", "新任务不选项目，就在公共目录里跑：适合查资料、写文档这种不属于哪个项目的事。它默认在 Studio 的数据目录里（[[设置]] → [[项目与目录]] 里能看到），不在左栏列出来。", [440, 238, 130, 48], [38, 338, 128, 50], true],
    ["task", "任务", "看板上的一张卡片", "一件要推进的事。属于一个项目（开过会话以后不能换项目），最多放进一个专题。看板四列：[[待办]]、[[进行中]]、[[待审阅]]、[[完成]]；卡片由你拖，会话开始、停下时 Studio 会在 [[进行中]] 和 [[待审阅]] 之间自己挪，AI 不会挪。", [440, 128, 130, 54], [182, 246, 128, 50]],
    ["session", "会话", "和模型的一段对话", "相当于在终端里开一次 `claude` 或 `codex`。一个任务可以有几段会话：任务页右上角 [[新会话]] 再开一段，可以换模型。会话里 AI 要跑命令、改文件时会先问你（看权限设置）。", [612, 128, 118, 54], [182, 338, 128, 50]],
    ["branch", "分支 · 子会话", "从会话里再开", "会话头上的 [[分支]] 从某处分出一段新对话，换个思路或换个模型再试；AI 也能自己开子会话、把一部分活委派出去，它们排在原会话下面。", [612, 232, 118, 54], [182, 430, 128, 50]],
    ["relay", "AMO 中转", "找人确认 · 聊天", "局域网里的服务加桌面程序：策划的 AI 把要确认的事发给程序，程序回复后 AI 接着做；人和人也能直接聊。用的是同一个团队账号。", [196, 334, 170, 54], [24, 568, 300, 46]],
    ["reviewer", "Reviewer（独立版）", "可以单独用", "Git Review 和查看器的独立程序，给不装 Studio 的人用。装了 Studio 就不用另装，Studio 里带着同样的功能。", [384, 334, 170, 54], [24, 626, 300, 46]],
    ["notes", "便签（独立版）", "随手记", "托盘常驻的随手记，有全局快捷键。Studio 自带一份，打开 Studio 时会顺带启动它；不用 Studio 的人可以单独装。", [572, 334, 172, 54], [24, 684, 300, 46]],
  ].map(([id, name, sub, text, wide, narrow, dashed]) => ({ id, name, sub, text, wide, narrow, dashed: !!dashed }));

  /** from, to, 线上的字（可空）, 宽版的路径和字的位置, 窄版的 */
  const EDGES = [
    ["platform", "studio", "安装 · 更新", "M162 182 H196", [89, 140], "M170 64 V92", [230, 82]],
    ["platform", "relay", "", "M89 214 V316 H281 V334", null, "M16 38 H8 V591 H24", null],
    ["platform", "reviewer", "", "M281 316 H469 V334", null, "M8 649 H24", null],
    ["platform", "notes", "", "M469 316 H658 V334", null, "M8 707 H24", null],
    ["topic", "canvas", "每个一张", "M352 80 C396 74 400 53 440 53", [392, 58], "M102 202 V246", [134, 228]],
    ["topic", "task", "放进", "M352 104 C396 110 400 150 440 150", [380, 132], "M166 186 C200 200 210 220 230 246", [176, 236]],
    ["project", "task", "在这里跑", "M352 212 C396 206 400 168 440 168", [392, 222], "M246 202 V246", [282, 228]],
    ["common", "task", "不选项目时", "M505 238 V182", [538, 214], "M166 363 C190 350 200 320 214 296", [196, 334]],
    ["task", "session", "一个或几个", "M570 155 H612", [591, 120], "M246 296 V338", [282, 322]],
    ["session", "branch", "", "M671 182 V232", null, "M246 388 V430", null],
  ].map(([from, to, label, wd, wl, nd, nl]) => ({ from, to, label, wide: { d: wd, at: wl }, narrow: { d: nd, at: nl } }));

  T.concept = { NODES, EDGES };
  if (typeof document === "undefined") return;

  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function render(box) {
    const narrow = box.clientWidth < 600;
    const lay = narrow ? "narrow" : "wide";
    const [vw, vh] = narrow ? [340, 744] : [760, 404];
    const sel = box.dataset.sel || "studio";
    const edges = EDGES.map((e) => `<path class="edge" d="${e[lay].d}" marker-end="url(#cm-arrow)"/>${e.label && e[lay].at ? `<text class="elab" text-anchor="middle" x="${e[lay].at[0]}" y="${e[lay].at[1]}">${esc(e.label)}</text>` : ""}`).join("");
    const nodes = NODES.map((n) => {
      const [x, y, w, h] = n[lay];
      const big = n.id === "studio";
      return `<g class="node-g${n.id === sel ? " sel" : ""}${big ? " big" : ""}${n.dashed && !big ? " dashed" : ""}" data-id="${n.id}" tabindex="0" role="button" aria-pressed="${n.id === sel}" aria-label="${esc(n.name)}：${esc(n.sub)}">
        <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${big ? 14 : 10}"/>
        <text class="t" x="${x + (big ? 16 : w / 2)}" y="${y + (big ? 26 : h / 2 - 3)}" text-anchor="${big ? "start" : "middle"}">${esc(n.name)}</text>
        <text class="s" x="${x + (big ? 16 : w / 2)}" y="${y + (big ? 44 : h / 2 + 14)}" text-anchor="${big ? "start" : "middle"}">${esc(n.sub)}</text>
      </g>`;
    });
    // Studio 的大框先画，别的方块压在上面。
    const order = [nodes[1], ...nodes.filter((_, i) => i !== 1)];
    const node = NODES.find((n) => n.id === sel);
    box.innerHTML = `<svg viewBox="0 0 ${vw} ${vh}" role="group" aria-label="AMO 的工具和 Studio 里几个词的关系">
        <defs><marker id="cm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="arrowhead"/></marker></defs>
        ${order.join("")}${edges}
      </svg>
      <div class="concept-detail" aria-live="polite"><b>${esc(node.name)}</b><span class="concept-sub">${esc(node.sub)}</span><p>${T.inline(node.text)}</p></div>`;
    box.querySelectorAll(".node-g").forEach((g) => {
      const pick = () => {
        box.dataset.sel = g.dataset.id;
        render(box);
        box.querySelector(`.node-g[data-id="${g.dataset.id}"]`)?.focus();
      };
      g.addEventListener("click", pick);
      g.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick()));
    });
  }

  function mount() {
    document.querySelectorAll("[data-concept]").forEach((box) => {
      let w = 0;
      new ResizeObserver(() => {
        const narrow = box.clientWidth < 600;
        if (narrow === w) return;
        w = narrow;
        render(box);
      }).observe(box);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
