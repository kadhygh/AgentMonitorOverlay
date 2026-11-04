// 第 6 章：自己在画布上摆。工具栏、建组、把卡片拖进组、从卡片边上的圆点拖出依赖线、单击看详情（canvas/CanvasView、
// 详情框）。卡片和组的名字是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const P = T.parts;
  const card = (k, title, project, x, y) => `
    <div class="s-cvc" data-k="${k}" style="left:${x}%;top:${y}%"><b>${title}</b><span><span class="s-dot"></span>未开始 · ${project}</span><i class="s-cvdot r" data-k="${k}-dot"></i><i class="s-cvdot l"></i></div>`;
  T.scene({
    id: "canvas-manual",
    title: "自己摆：建组、拖进组、拉依赖线、看详情",
    height: 400,
    narrowHeight: 460,
    ui: ["+ 在专题里新建任务", "+ 分组", "引用任务", "+ 便签", "小窗", "侧栏", "打开任务", "从画布上拿掉（任务不变）", "前置任务", "拖空白处移动视角", "从卡片边上的圆点拖出连线", "单击看详情", "右键看更多操作", "双击打开任务"],
    // 画布那一页：视图栏亮「画布」。
    html: P.studio({
      nav: `<div class="s-nav-row">全部任务<span class="n">2</span></div><div class="s-nav-head">专题 1</div><div class="s-nav-row cur">▢ 3.2 版本<span class="n">2</span></div>
        <div class="s-nav-head">项目 2</div><div class="s-nav-row">▭ MyGame</div><div class="s-nav-row">▭ MyGame-drop</div>`,
      scope: "3.2 版本",
      main: `<div class="s-cvpage">
        <div class="s-cvbar" data-k="bar"><span class="s-btn pri">+ 在专题里新建任务</span><span class="s-btn ghost" data-k="addGroup">+ 分组</span><span class="s-btn ghost">引用任务</span><span class="s-btn ghost">+ 便签</span><span class="s-btn ghost">小窗</span><span class="s-sp"></span><span class="s-btn ghost">侧栏</span></div>
        <div class="s-cv">
          <div class="s-cvg" data-k="g" data-off style="left:3%;top:10%;width:44%;height:62%"><span>数据改动</span></div>
          <svg class="s-cvl" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path data-k="l" pathLength="1" d="M46 40 L60 40"/></svg>
          ${card("X", "掉落表改版", "MyGame-drop", 30, 58)}${card("Y", "合并验证", "MyGame", 60, 28)}
          <span class="s-cvdrop" data-k="drop" style="left:20%;top:38%"></span>
          <div class="s-cvd" data-k="detail" data-off><b>合并验证</b><span class="s-faint">待办 · 未开始 · MyGame</span>
            <span class="s-btn ghost">打开任务</span><span class="s-btn ghost">从画布上拿掉（任务不变）</span>
            <span class="s-faint">前置任务</span><span>掉落表改版</span></div>
        </div>
        <div class="s-cvhint">拖空白处移动视角 · 滚轮缩放 · 从卡片边上的圆点拖出连线 · 单击看详情 · 右键看更多操作 · 双击打开任务</div>
      </div>`,
    }).replace('<span class="s-tab on" data-k="tabBoard">看板</span><span class="s-tab" data-k="tabCanvas">画布</span>', '<span class="s-tab" data-k="tabBoard">看板</span><span class="s-tab on" data-k="tabCanvas">画布</span>'),
    steps: [
      { say: "专题的 [[画布]] 上面是工具栏：[[+ 在专题里新建任务]]、[[+ 分组]]、[[引用任务]]（放别的专题的任务）、[[+ 便签]]、[[小窗]]。", do: [["hl", "bar"]] },
      { say: "点 [[+ 分组]] 建一个组，再把卡片拖进去。组可以按项目、按阶段，随你分。", do: [["unhl", "bar"], ["click", "addGroup"], ["show", "g"], ["move", "X"], ["style", "X", "left", "6%"], ["style", "X", "top", "28%"], ["move", "drop"]] },
      { say: "从卡片边上的圆点拖出一条线，连到另一张卡片，就是依赖：箭头指着的任务要等前一个做完。", do: [["move", "X-dot"], ["on", "l", "drawn"], ["move", "Y", 0.05, 0.5]] },
      { say: "单击卡片看详情：[[打开任务]]、[[从画布上拿掉（任务不变）]]，下面列着它的 [[前置任务]]。右键还有标颜色等操作，双击直接打开任务。", do: [["click", "Y"], ["show", "detail"]] },
    ],
  });
})();
