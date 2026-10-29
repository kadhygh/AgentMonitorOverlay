// 展示第 7 屏：台式机上的会话，在笔记本上接着用：笔记本上是这个任务的副本（「远程」「在 台式机 上运行」），
// 发的话、批的命令都在台式机上执行（task/TaskPage.tsx 的远程横条，features/remote/）。设备名和内容只是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const thread = (p) => `
    <div class="s-thread" style="justify-content:flex-end">
      <div class="s-agent">掉落表改好了，测试都通过。</div>
      <div class="s-user" data-k="${p}msg" data-off>结算那边也按小数改一下</div>
      <div class="s-approval" data-k="${p}ap" data-off>
        <div class="s-approval-head">请求执行命令<span class="w">等待你的确认</span></div>
        <code>python -m pytest tests/test_settle.py</code>
        ${p === "b" ? '<span class="s-row"><span class="s-btn att" data-k="bok">批准</span><span class="s-btn att-o">拒绝</span></span>' : ""}
      </div>
      <div class="s-pr ok" data-k="${p}done" data-off>已批准执行命令 · <span class="code">python -m pytest tests/test_settle.py</span></div>
    </div>`;
  T.scene({
    id: "sc-remote",
    title: "在另一台电脑上接着用同一个会话",
    height: 400,
    narrowHeight: 640,
    poster: 2,
    ui: ["远程", "上运行", "请求执行命令", "等待你的确认", "批准", "拒绝"],
    html: `<div class="sc-two">
      <div class="sc-pane">
        <div class="s-titlebar"><span class="s-logo"></span><span class="s-title">台式机</span><span class="s-faint">会话在这里跑</span></div>
        ${thread("a")}
      </div>
      <div class="sc-wire"><span class="lab">局域网</span><span class="sc-packet" data-k="p1"></span><span class="sc-packet" data-k="p2"></span></div>
      <div class="sc-pane">
        <div class="s-titlebar"><span class="s-logo"></span><span class="s-title">笔记本</span></div>
        <div class="sc-banner"><span class="sc-badge">远程</span>在 台式机 上运行</div>
        ${thread("b")}
        <div class="s-input" style="margin:0 10px 8px"><div class="s-text" data-k="input" data-ph="继续推进这个会话，回车发送"></div></div>
      </div>
    </div>`,
    steps: [
      { hold: 150, do: [["click", "input"], ["type", "input", "结算那边也按小数改一下"]] },
      { hold: 650, do: [["text", "input", ""], ["show", "bmsg"], ["on", "p1", "r2l"]] },
      { hold: 300, do: [["show", "amsg"], ["wait", 500], ["show", "aap"], ["show", "bap"]] },
      { hold: 650, do: [["click", "bok"], ["hide", "bap"], ["show", "bdone"], ["on", "p2", "r2l"]] },
      { hold: 1400, do: [["hide", "aap"], ["show", "adone"]] },
    ],
  });
})();
