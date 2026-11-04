// 第 6 章：让主控用画布整理任务。主控任务的对话在左，画布小窗（canvas-window：总在最前）浮在右边；跟主控说一句，
// 它用 画布建组 / 画布归组 / 画布连依赖（host features/canvas/mcp.ts，改画布先问人），点批准后画布按项目分好组、连好依赖。
// 任务名、项目名、对话内容是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const P = T.parts;
  const card = (k, title, project, x, y) => `
    <div class="s-cvc" data-k="${k}" style="left:${x}%;top:${y}%"><b>${title}</b><span><span class="s-dot" data-k="${k}-dot"></span><span data-k="${k}-st">未开始</span> · ${project}</span></div>`;
  const group = (k, title, x, y) => `<div class="s-cvg" data-k="${k}" data-off style="left:${x}%;top:${y}%;width:44%;height:38%"><span>▭ ${title}</span></div>`;
  const ask = "把 3.2 的任务按 worktree 分组排到画布上，标出谁等谁";
  T.scene({
    id: "canvas-lead",
    title: "跟主控说一句，它把任务排到画布上",
    height: 400,
    narrowHeight: 460,
    ui: ["画布建组", "画布归组", "画布连依赖", "批准", "小窗", "未开始", "运行中", "完成", "主控"],
    html: P.studio({
      nav: `<div class="s-nav-row">全部任务<span class="n">4</span></div><div class="s-nav-head">专题 1</div><div class="s-nav-row cur">▢ 3.2 版本<span class="n">4</span></div>
        <div class="s-nav-head">项目 3</div><div class="s-nav-row">▭ MyGame</div><div class="s-nav-row">▭ MyGame-drop</div><div class="s-nav-row">▭ MyGame-ui</div>`,
      scope: "3.2 版本",
      main: `<div class="s-task">
        <div class="s-task-head"><div style="min-width:0;flex:1"><div class="s-task-title"><span class="s-lead">主控</span>3.2 版本 · 协调</div>
          <div class="s-meta"><span class="st"><span class="s-dot run"></span>进行中</span><span class="sep">·</span>▢ 3.2 版本</div></div></div>
        <div class="s-thread s-cv-thread">
          <div class="s-user" data-k="ask" data-off>${ask}</div>
          <div class="s-pr" data-k="t1" data-off>画布建组 · MyGame-drop、MyGame-ui、MyGame（各绑一个项目）</div>
          <div class="s-pr" data-k="t2" data-off>画布归组 · 三个任务放进各自项目的组</div>
          <div class="s-pr" data-k="t3" data-off>画布连依赖 · 掉落表改版、背包界面 → 合并验证</div>
          <div class="s-approval" data-k="appr" data-off><div class="s-approval-head">要改画布：建 3 个组、归组、连 2 条依赖</div>
            <span class="s-row"><span class="s-btn att" data-k="ok">批准</span></span></div>
          <div class="s-agent" data-k="done" data-off>排好了。合并验证要等另外两个做完。</div>
        </div>
        ${P.composer()}</div>
        <div class="s-cvwin" data-k="win"><div class="s-cvwin-head"><b>画布</b><span class="s-faint">3.2 版本 · 小窗</span></div>
          <div class="s-cv">
            ${group("g1", "MyGame-drop", 3, 5)}${group("g2", "MyGame-ui", 3, 53)}${group("g3", "MyGame", 53, 29)}
            <svg class="s-cvl" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
              <path data-k="l1" pathLength="1" d="M44 24 C50 24 50 44 56 44"/><path data-k="l2" pathLength="1" d="M44 72 C50 72 50 52 56 52"/></svg>
            ${card("A", "掉落表改版", "MyGame-drop", 52, 6)}${card("B", "背包界面", "MyGame-ui", 8, 46)}${card("C", "合并验证", "MyGame", 48, 72)}
          </div></div>`,
    }),
    steps: [
      { say: "专题「3.2 版本」里有三个任务，各在一个 worktree 项目里。画布开成 [[小窗]] 浮在旁边，任务还散着。", do: [["hl", "win"]] },
      { say: "在主控任务的对话里跟它说要怎么排。主控不会自己去动画布，要你开口。", do: [["unhl", "win"], ["type", "input", ask], ["wait", 300], ["text", "input", ""], ["show", "ask"]] },
      { say: "它用 [[画布建组]]、[[画布归组]]、[[画布连依赖]] 改画布。改之前先问你。", do: [["show", "t1"], ["wait", 250], ["show", "t2"], ["wait", 250], ["show", "t3"], ["wait", 250], ["show", "appr"], ["hl", "appr"]] },
      { say: "点 [[批准]]：画布上按项目分好组，任务放进各自的组，依赖线连好。", do: [["unhl", "appr"], ["click", "ok"], ["hide", "appr"], ["show", "g1"], ["show", "g2"], ["show", "g3"], ["style", "A", "left", "6%"], ["style", "A", "top", "13%"], ["style", "B", "left", "6%"], ["style", "B", "top", "61%"], ["style", "C", "left", "56%"], ["style", "C", "top", "37%"], ["wait", 700], ["on", "l1", "drawn"], ["on", "l2", "drawn"], ["show", "done"]] },
      { say: "之后卡片上的状态跟着任务变：哪个做完了、哪个在跑、哪个在等前面的，一眼看清。", do: [["text", "A-st", "完成"], ["on", "l1", "go"], ["text", "B-st", "运行中"], ["on", "B-dot", "run"], ["hl", "C"]] },
    ],
  });
})();
