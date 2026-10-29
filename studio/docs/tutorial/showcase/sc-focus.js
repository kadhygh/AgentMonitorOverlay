// 展示第 2 屏：人在写文档，Focus 小窗里一个会话亮起「! 批准」，在 Focus 里点「批准」，它接着跑
// （focus/FocusApp.tsx、FocusEntry.tsx、StatusWord.tsx 的状态字）。内容只是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  T.scene({
    id: "sc-focus",
    title: "Focus 只在需要你时亮起",
    height: 400,
    narrowHeight: 460,
    poster: 1,
    ui: ["Focus", "◐ 运行|运行", "! 批准|批准", "✓ 完成|完成", "批准"],
    html: `<div class="sc-desk">
      <div class="s-win sc-doc">
        <div class="s-titlebar"><span class="s-title">3.2 版本需求.md</span></div>
        <div class="body"><span class="s-dim">## 掉落规则</span>
<span data-k="doc"></span></div>
      </div>
      <div class="sc-focus" data-k="focus">
        <div class="sc-focus-head">Focus<span class="s-sp"></span><span class="s-faint" style="font:12px var(--font-ui)">3 个会话</span></div>
        <div class="sc-row" data-k="r1"><span class="w" data-k="r1w">◐ 运行</span><span class="n">掉落表校验报错 · Claude</span></div>
        <div class="sc-row" data-k="r2"><span class="w" data-k="r2w">◐ 运行</span><span class="n">写打表工具 · Codex</span>
          <div class="more" data-k="r2more" data-off><code>python tools/gen_tables.py</code><span class="s-btn att" data-k="ok">批准</span></div></div>
        <div class="sc-row" data-k="r3"><span class="w">◐ 运行</span><span class="n">查资源加载的资料 · DeepSeek</span></div>
      </div>
    </div>`,
    steps: [
      { hold: 200, do: [["type", "doc", "Boss 必掉一件紫装，"]] },
      { hold: 700, do: [["on", "r2", "att"], ["text", "r2w", "! 批准"], ["show", "r2more"], ["hl", "r2"]] },
      { hold: 900, do: [["unhl", "r2"], ["click", "ok"], ["off", "r2", "att"], ["text", "r2w", "◐ 运行"], ["hide", "r2more"]] },
      { hold: 300, do: [["type", "doc", "其余按掉落表。", true]] },
      { hold: 1100, do: [["on", "r1", "done"], ["text", "r1w", "✓ 完成"]] },
    ],
  });
})();
