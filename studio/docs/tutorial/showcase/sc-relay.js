// 展示第 6 屏：策划的 AI 拿不准，用中转的 relay_session_open（发会话）问程序；程序在中转客户端里回答，点
// 「回复并返回给 … 的 AI」；AI 用 relay_session_wait 拿到回复接着改（packages/relay/src/mcp.ts、
// relay-ui/src/SessionView.tsx）。人名、字段和回答只是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  T.scene({
    id: "sc-relay",
    title: "策划的 AI 经中转问程序",
    height: 400,
    narrowHeight: 560,
    poster: 4,
    ui: ["AMO 中转", "工具调用", "回复并返回给", " 的 AI", "已返回给"],
    html: `<div class="sc-two">
      <div class="sc-pane">
        <div class="s-titlebar"><span class="s-logo"></span><span class="s-title">小王 · Studio</span></div>
        <div class="s-thread" style="justify-content:flex-end">
          <div class="s-agent">配表里的 <code class="s-mono">drop_rate</code> 程序是当百分比读还是小数？我去问一下。</div>
          <div class="s-pr" data-k="open" data-off>工具调用 · <span class="code">relay_session_open · 发给 老李</span></div>
          <div class="s-pr" data-k="wait" data-off>工具调用 · <span class="code">relay_session_wait</span></div>
          <div class="s-pr ok" data-k="got" data-off>收到老李的回复</div>
          <div class="s-agent" data-k="go" data-off>按小数改好了 12 行配表。</div>
        </div>
      </div>
      <div class="sc-wire"><span class="lab">AMO 中转</span><span class="sc-packet" data-k="p1"></span><span class="sc-packet" data-k="p2"></span></div>
      <div class="sc-pane">
        <div class="s-titlebar"><span class="s-logo"></span><span class="s-title">老李 · AMO 中转</span></div>
        <div class="s-thread" style="justify-content:flex-start">
          <div class="sc-ask" data-k="ask" data-off><span class="from">小王 的 AI</span>
            <div>配表的 <code class="s-mono">drop_rate</code> 是百分比还是小数？</div>
            <span class="s-field" data-k="reply" data-ph="直接用话回答就行"></span>
            <span class="s-row" data-k="sendRow" style="margin-top:6px;justify-content:flex-end"><span class="s-btn pri" data-k="send">回复并返回给 小王 的 AI</span></span>
            <div class="s-ok" data-k="sentNote" style="margin-top:6px" data-off>✓ 已返回给 小王 的 AI</div></div>
        </div>
      </div>
    </div>`,
    steps: [
      { hold: 650, do: [["show", "open"], ["on", "p1", "l2r"]] },
      { hold: 300, do: [["show", "ask"], ["show", "wait"]] },
      { hold: 200, do: [["click", "reply"], ["type", "reply", "小数，0 到 1"], ["click", "send"]] },
      { hold: 650, do: [["hide", "sendRow"], ["show", "sentNote"], ["on", "p2", "r2l"]] },
      { hold: 1400, do: [["show", "got"], ["show", "go"]] },
    ],
  });
})();
