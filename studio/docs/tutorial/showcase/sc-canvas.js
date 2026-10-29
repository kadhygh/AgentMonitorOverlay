// 展示第 4 屏：专题画布上的任务卡片、依赖箭头（「它要等…做完才开始」）、AI 铺的审阅条目和它的提问
// （canvas/review.tsx：「? 待你确认」气泡、可选的回答、「发送回答」、「✓ 已回答」、「◐ AI 处理中」）。内容只是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  T.scene({
    id: "sc-canvas",
    title: "画布上的状态、依赖和提问",
    height: 400,
    narrowHeight: 480,
    poster: 1,
    loopGap: 1000,
    ui: ["? 待你确认", "发送回答", "✓ 已回答", "◐ AI 处理中", "问题", "进行中", "待办", "完成"],
    html: `<div class="sc-canvas">
      <div class="sc-group"><span class="gt">3.2 版本</span></div>
      <div class="sc-tcard" style="left:var(--ax);top:17%" data-k="A"><b>掉落表重构</b><span class="sc-st"><span class="s-dot run" data-k="a-dot"></span><span data-k="a-st">进行中</span></span></div>
      <div class="sc-arrow" style="left:calc(var(--ax) + var(--cw) + 6px);right:calc(100% - var(--bx) + 6px);top:25%" data-k="arrow"></div>
      <div class="sc-tcard" style="left:var(--bx);top:17%" data-k="B"><b>结算改版</b><span class="sc-st"><span class="s-dot" data-k="b-dot"></span><span data-k="b-st">待办</span></span></div>
      <div class="sc-tcard sc-item" style="left:var(--ax);top:56%" data-k="item"><span class="num">审阅 #3</span><b>掉落概率加起来不是 1</b><span class="s-dim s-hide-narrow">Boss_Lv20 0.97 · Chest_Rare 1.04</span></div>
      <div class="sc-tcard" style="left:var(--bx);top:56%"><b>发版说明</b><span class="sc-st"><span class="s-dot"></span>完成</span></div>
      <span class="sc-bubble" style="left:calc(var(--ax) + 24px);top:calc(56% - 16px)" data-k="bubble" data-off>? 待你确认</span>
      <div class="sc-dialog" data-k="dialog" data-off>
        <span class="s-faint">问题 · 审阅 #3</span>
        <div class="q">差的那点补到哪一项，还是整张表按比例缩放？</div>
        <span class="s-row"><span class="s-chip" data-k="opt1">补到最大的一项</span><span class="s-chip" data-k="opt2">按比例缩放</span></span>
        <span class="s-row" style="margin-top:10px;justify-content:flex-end"><span class="s-btn ghost">收起</span><span class="s-btn pri" data-k="send">发送回答</span></span>
      </div>
    </div>`,
    steps: [
      { hold: 500, do: [["show", "bubble"]] },
      { hold: 200, do: [["click", "bubble"], ["show", "dialog"]] },
      { hold: 200, do: [["click", "opt2"], ["on", "opt2", "sel"]] },
      { hold: 500, do: [["click", "send"], ["hide", "dialog"], ["text", "bubble", "✓ 已回答"], ["on", "bubble", "ok"]] },
      { hold: 600, do: [["text", "bubble", "◐ AI 处理中"]] },
      { hold: 400, do: [["text", "a-st", "完成"], ["off", "a-dot", "run"], ["hide", "bubble"]] },
      { hold: 1100, do: [["on", "arrow", "go"], ["text", "b-st", "进行中"], ["on", "b-dot", "run"]] },
    ],
  });
})();
