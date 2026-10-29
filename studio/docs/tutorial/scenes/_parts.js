// 几个演示共用的简化界面：Studio 主窗口的外壳（顶栏、视图栏、左栏）、看板、平台窗口的外壳。
// 照 packages/ui/src/shell/TopBar.tsx、board/ScopeNav.tsx、board/Board.tsx、platform/PlatformApp.tsx 画，只留名字和位置。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const P = (T.parts = {});

  T.uses("AMO Studio", "书签", "远程", "便签", "Focus", "置顶", "需要你", "看板", "画布", "搜索任务或会话", "+ 新任务", "全部任务", "专题", "项目", "Host 运行中", "设置", "+ 新专题", "+ 添加项目");
  /** Studio 主窗口。nav / main 是里面的内容；needs: 顶栏的「需要你」先显示出来。 */
  P.studio = ({ nav, main, needs = false, scope = "", withNav = false }) => `
    <div class="s-app${withNav ? " with-nav" : ""}" data-k="app">
      <div class="s-top">
        <span class="s-brand"><span class="s-logo"></span><span class="s-name">AMO Studio</span><span class="s-scope" data-k="scope">${scope}</span></span>
        <span class="s-sp"></span>
        <span class="s-needs" data-k="needs"${needs ? "" : " data-off"}>● 需要你 1</span>
        <span class="s-tb" data-k="tbMarks">书签</span>
        <span class="s-tb" data-k="tbRemote">远程</span>
        <span class="s-tb" data-k="tbNotes">便签</span>
        <span class="s-tb" data-k="tbFocus">Focus<i></i></span>
        <span class="s-tb s-wide" data-k="tbPin">置顶<i></i></span>
        <span class="s-wbtn s-wide">─ ☐ ✕</span>
      </div>
      <div class="s-nav">${nav}
        <div class="s-nav-foot"><span class="s-dim"><span class="s-dot run"></span> Host 运行中</span><span data-k="settings">⚙ 设置</span></div>
      </div>
      <div class="s-viewbar">
        <span class="s-tab on" data-k="tabBoard">看板</span><span class="s-tab" data-k="tabCanvas">画布</span>
        <span class="s-sp"></span><span class="s-search">搜索任务或会话</span>
        <span class="s-btn pri" data-k="newBtn">+ 新任务</span>
      </div>
      <div class="s-main">${main}</div>
    </div>`;

  /** 左栏。projects: [[名字, 任务数]]；空的时候显示「+ 添加项目」。extra: 插在项目下面的东西（登记表单）。 */
  P.nav = ({ projects = [], all = 0, extra = "" } = {}) => `
    <div class="s-nav-row cur" data-k="navAll">全部任务<span class="n">${all}</span></div>
    <div class="s-nav-head">专题 0<span class="plus">+</span></div>
    <div class="s-nav-add">+ 新专题</div>
    <div class="s-nav-head" data-k="navProjects">项目 <span data-k="navProjectCount">${projects.length}</span><span class="plus" data-k="navAddPlus">+</span></div>
    ${projects.map(([name, n]) => `<div class="s-nav-row" data-k="proj-${name}">▭ ${name}<span class="n">${n}</span></div>`).join("")}
    ${projects.length ? "" : '<div class="s-nav-add" data-k="addProject">+ 添加项目</div>'}
    ${extra}`;

  T.uses("待办", "进行中", "待审阅", "完成", "空");
  /** 看板：四列，cards 是 { todo|doing|review|done: 卡片的 HTML 数组 }。 */
  P.board = (cards = {}) => `
    <div class="s-board">${[
      ["todo", "待办"],
      ["doing", "进行中"],
      ["review", "待审阅"],
      ["done", "完成"],
    ]
      .map(
        ([id, name]) => `<div class="s-col" data-k="col-${id}"><div class="s-col-head">${name}<span class="n">${(cards[id] || []).length}</span></div>
          ${(cards[id] || []).join("") || '<div class="s-col-empty">空</div>'}</div>`,
      )
      .join("")}</div>`;

  /** 看板上的一张任务卡片。 */
  P.card = ({ k, where, title, status, tone = "", sessions = "1 个会话" }) => `
    <div class="s-card" data-k="${k}"><div class="s-card-where">${where}</div><b>${title}</b>
      <div class="s-card-st"><span class="s-dot ${tone}"></span><span class="${tone === "att" ? "s-att" : ""}">${status}</span></div>
      <div class="s-faint">${sessions}</div></div>`;

  /** 第 1 章例子里的那句话（任务没起名字时，标题就是第一句话）。 */
  P.ask = "导入器遇到网络错误直接崩，给 fetch 加上失败重试，最多 3 次。";

  T.uses("新会话", "Review", "书签", "归档");
  /** 任务页的头（task/TaskPage.tsx + TaskHead.tsx）：标题，下面一行 状态 · 项目 · 分支 · 专题，右边的按钮。 */
  P.taskHead = ({ status = "进行中", tone = "run" } = {}) => `
    <div class="s-task-head">
      <div style="min-width:0;flex:1">
        <div class="s-task-title">${P.ask}</div>
        <div class="s-meta"><span class="st" data-k="status"><span class="s-dot ${tone}" data-k="statusDot"></span><span data-k="statusText">${status}</span></span>
          <span class="sep">·</span>▭ MyGame<span class="sep">·</span><span class="s-mono">main</span><span class="sep s-hide-narrow">·</span><span class="s-hide-narrow">—</span></div>
      </div>
      <div class="s-head-btns"><span class="s-btn ghost s-hide-narrow">新会话</span><span class="s-btn ghost" data-k="review">Review</span><span class="s-btn ghost s-hide-narrow">书签</span><span class="s-btn ghost s-hide-narrow">归档</span><span class="s-btn ghost">⋯</span></div>
    </div>`;

  T.uses("继续推进这个会话，回车发送，Shift+回车换行，输入 / 看命令", "每次询问");
  /** 会话的输入框（task/ThreadParts.tsx 的占位文字）。 */
  P.composer = (k = "input") => `
    <div class="s-input"><div class="s-text" data-k="${k}" data-ph="继续推进这个会话，回车发送，Shift+回车换行，输入 / 看命令"></div>
      <div class="s-cbar"><span class="s-faint">⌀</span><span class="s-tile"><i></i>Claude</span><span class="s-perm"><span class="sel">每次询问</span></span><span class="s-sp"></span><span class="s-btn ghost" data-k="${k}Send">↑</span></div></div>`;

  T.uses("AMO 平台", "工具", "环境", "目录", "账号");
  /** 平台窗口。page 是右边的内容；cur: 左边亮哪一页。 */
  P.platform = ({ page, cur = "tools", online = true }) => `
    <div class="s-win">
      <div class="s-titlebar"><span class="s-logo"></span><span class="s-title">AMO 平台</span>
        <span class="s-ok s-wide" data-k="conn"${online ? "" : " data-off"}>● 服务器在线 · 172.16.8.85:47120</span>
        <span class="s-sp"></span><span class="s-wbtn">─ ✕</span></div>
      <div class="p-body">
        <div class="p-nav">
          ${[
            ["tools", "工具"],
            ["environment", "环境"],
            ["dirs", "目录"],
            ["settings", "设置"],
          ]
            .map(([id, name]) => `<span data-k="nav-${id}"${id === cur ? ' class="cur"' : ""}>${name}</span>`)
            .join("")}
          <span class="p-me"><span class="p-face">小</span><span>小王<br><span class="s-faint">账号</span></span></span>
        </div>
        <div class="p-page">${page}</div>
      </div>
    </div>`;
})();
