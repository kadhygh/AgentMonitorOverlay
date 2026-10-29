// 第 1 章第 3 步：登记项目（board/ScopeNav.tsx 的「+ 添加项目」表单），新任务页（newtask/NewTaskPage.tsx），开始。
// 模型名只是示意：真实的名字看 设置 → 模型 里有哪些渠道。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const P = T.parts;
  const form = `
    <div class="s-nav-form" data-k="form" data-off>
      <span class="s-btn ghost" data-k="pickDir">选择文件夹…</span>
      <span class="s-faint">或输入路径</span>
      <span class="s-field" data-k="pathField" data-ph="D:\\Projects\\MyGame"></span>
      <span class="s-row"><span class="s-btn pri">登记</span><span class="s-btn ghost">取消</span></span>
    </div>
    <div class="s-nav-row" data-k="newProject" data-off>▭ MyGame<span class="n">0</span></div>`;
  const draft = `
    <div class="s-draft" data-k="draft" data-off>
      <div class="s-crumb"><span class="s-btn ghost">‹ 看板</span>/ 新任务<span class="s-sp"></span><span class="s-hide-narrow">草稿自动保存，离开也不会丢</span></div>
      <div class="s-ask">要推进什么？</div>
      <div class="s-pick"><span class="l">专题</span><span class="s-row"><span class="s-chip sel">不选</span></span></div>
      <div class="s-pick"><span class="l">项目</span><span class="s-row"><span class="s-chip">不选</span><span class="s-chip sel" data-k="chipProject">MyGame</span><span class="s-chip add s-hide-narrow">+ 添加项目</span></span></div>
      <div class="s-composer">
        <div class="s-text" data-k="text" data-ph="比如：导入器遇到网络错误直接崩，给 fetch 加上失败重试，最多 3 次。打 @ 引用项目、任务或文件。"></div>
        <div class="s-cbar" data-k="models"><span class="s-faint">⌀</span>
          <span class="s-tile sel" data-k="tile1"><i></i>Claude</span><span class="s-tile"><i></i>Codex</span><span class="s-tile s-hide-narrow"><i></i>DeepSeek</span>
          <span class="s-link s-hide-narrow">全部型号</span></div>
        <div class="s-cbar"><span class="s-eff s-hide-narrow" data-k="effort"><i style="height:5px"></i><i style="height:9px"></i><i style="height:13px"></i></span><span class="s-hide-narrow">高</span>
          <span class="s-perm" data-k="perm"><span class="sel">每次询问</span><span>帮我审批</span><span class="s-hide-narrow">自动接受编辑</span></span>
          <span class="s-sp"></span>
          <span class="s-btn ghost s-hide-narrow" data-k="file">放进待办 <kbd>Ctrl ↵</kbd></span>
          <span class="s-btn pri" data-k="start">开始 <kbd>↵</kbd></span></div>
      </div>
      <div class="s-faint" style="margin-top:6px;text-align:right">在 MyGame 里运行</div>
    </div>
    <div class="s-cover" data-k="cover" data-off>正在启动 Claude…</div>`;
  T.scene({
    id: "studio-first-task",
    title: "登记项目，新建任务",
    height: 380,
    narrowHeight: 430,
    ui: ["选择文件夹…", "或输入路径", "登记", "取消", "‹ 看板|看板", "/ 新任务|新任务", "草稿自动保存，离开也不会丢", "要推进什么？", "不选", "全部型号", "每次询问", "帮我审批", "自动接受编辑", "放进待办", "开始", "正在启动", "高", "在 MyGame 里运行|里运行"],
    html: P.studio({
      withNav: true,
      nav: P.nav({ projects: [], extra: form }),
      main: `<div data-k="board">${P.board()}</div>${draft}`,
    }),
    steps: [
      { say: "新的 Studio 看板是空的。第一步在左栏登记项目：点 [[项目]] 下面的 [[+ 添加项目]]。", do: [["hl", "addProject"], ["click", "addProject"], ["unhl", "addProject"], ["hide", "addProject"], ["show", "form"]] },
      { say: "点 [[选择文件夹…]]，选项目所在的文件夹（也可以把路径粘进 [[或输入路径]] 下面的框，再点 [[登记]]）。", do: [["click", "pickDir"], ["wait", 400], ["hide", "form"], ["show", "newProject"], ["text", "navProjectCount", "1"], ["off", "navAll", "cur"], ["on", "newProject", "cur"], ["text", "scope", "MyGame"]] },
      { say: "登记好就进到这个项目的看板。点右上角的 [[+ 新任务]]。", do: [["click", "newBtn"], ["off", "app", "with-nav"], ["hide", "board"], ["show", "draft"]] },
      { say: "主区域变成一页草稿：[[要推进什么？]] 从项目里点的，[[项目]] 已经选好；[[专题]] 可以 [[不选]]。写下第一句话：", do: [["hl", "chipProject"], ["move", "text", 0.1, 0.4], ["unhl", "chipProject"], ["type", "text", "导入器遇到网络错误直接崩，给 fetch 加上失败重试，最多 3 次。"]] },
      { say: "下面一排是常用的模型，点一下就换（名字看你在 [[设置]] → [[模型]] 里有哪些渠道）。权限先用默认的 [[每次询问]]：每条命令都先问你。", do: [["hl", "models"], ["move", "tile1"], ["unhl", "models"], ["hl", "perm"], ["move", "perm", 0.2, 0.5]] },
      { say: "点 [[开始]]（或直接回车），第一段会话就开起来了。只想先记下这件事，就点 [[放进待办]]。", do: [["unhl", "perm"], ["click", "start"], ["show", "cover"]] },
    ],
  });
})();
