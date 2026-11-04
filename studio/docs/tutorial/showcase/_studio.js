// 展示页几段翻页动画共用的 Studio 主窗口（按 1280×800 画，showcase.css 的 iw-* 样式）：顶栏、左栏（可带额度）、
// 视图栏、看板的列和卡片、模型的标记。照 shell/TopBar（2026-10-31 起没有「置顶」，开了远程有「远程」）、board/ScopeNav、board/Board、board/UsageFooter 画，只留名字和位置。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const S = (T.studioParts = {});

  S.MODELS = {
    claude: ["C", "Claude Opus 5.5", "Claude Code"],
    gpt: ["G", "GPT-5.6", "Codex"],
    ds: ["D", "DeepSeek V4", "DeepSeek"],
    api: ["API", "中转 Claude", "第三方渠道"],
  };
  S.mk = (id) => `<i class="h-mk ${id}">${S.MODELS[id][0]}</i>`;
  S.chip = (id) => `<span class="iw-chip">${S.mk(id)}${S.MODELS[id][1]}</span>`;

  /** 看板上的一张卡片。model：卡片下面画上模型（示意，真卡片不显示）。 */
  S.card = (k, where, title, { model, word = "运行中", tone = "run", hidden = true, running = true } = {}) => `
    <div class="iw-card" data-k="${k}"${hidden ? " data-off" : ""}><div class="iw-where">${where}</div><b>${title}</b>
      <div class="iw-st"><span class="s-dot ${tone}" data-k="${k}-dot"></span><span data-k="${k}-st">${word}</span></div>
      ${model ? `<div class="iw-cm">${S.chip(model)}</div>` : ""}${running ? '<span class="h-run"></span>' : ""}</div>`;
  S.col = (id, name, n, body) => `<div class="iw-col"><div class="iw-col-head">${name}<span class="n" data-k="n-${id}">${n}</span></div>${body}</div>`;
  const acct = (k, name, sub, left, used) => `
    <div class="h-acct" data-k="u-${k}"><div class="h-acct-line"><b>${name}</b><span class="h-acct-sub">${sub}</span><span class="h-left" data-k="u-${k}-left">${left}</span></div>
      ${used === undefined ? "" : `<div class="h-bar"><span data-k="u-${k}-bar" style="--w:${used}%"></span></div>`}</div>`;
  S.usage = `
    <div class="h-usage iw-usage" data-k="usage">
      <div class="h-usage-head">额度</div>
      ${acct("claude", "Claude", "订阅 · 5h", "剩 82%", 18)}
      ${acct("gpt", "GPT", "订阅 · 5h", "剩 68%", 32)}
      ${acct("ds", "DeepSeek", "余额", "¥88.10")}
      ${acct("api", "中转 Claude", "第三方", "$126.40")}
      <div class="h-host"><span class="s-dot run"></span>Host 运行中</div>
    </div>`;
  /** 左栏的默认内容：一个专题、两个项目。 */
  S.nav = (all = 2) => `
    <div class="iw-nrow cur">全部任务<span class="n" data-k="n-all">${all}</span></div>
    <div class="iw-nhead">专题</div>
    <div class="iw-nrow">▢ 掉落表重构<span class="n">2</span></div>
    <div class="iw-nhead">项目</div>
    <div class="iw-nrow">▭ MyGame<span class="n">3</span></div>
    <div class="iw-nrow">▭ ToolKit<span class="n">1</span></div>`;

  /** Studio 主窗口。main：右边的内容；nav：左栏上半；usage：左栏底下画额度；view：画视图栏（canvas：画布那页亮着）。 */
  S.studio = (main, { nav = S.nav(), usage = true, view = true, canvas = false } = {}) => `
    <div class="iw-top"><span class="iw-logo"></span><b class="iw-brand">AMO Studio</b><span class="s-sp"></span>
      <span class="iw-tb">书签</span><span class="iw-tb">远程</span><span class="iw-tb">便签</span><span class="iw-tb">Focus<i></i></span><span class="iw-wb">─ ☐ ✕</span></div>
    <div class="iw-nav">${nav}${usage ? S.usage : '<div class="iw-host"><span class="s-dot run"></span> Host 运行中</div>'}<div class="iw-set">⚙ 设置</div></div>
    ${view ? `<div class="iw-view"><span class="s-tab${canvas ? "" : " on"}" data-k="tabBoard">看板</span><span class="s-tab${canvas ? " on" : ""}" data-k="tabCanvas">画布</span><span class="s-sp"></span><span class="iw-search">搜索任务或会话</span><span class="s-btn pri iw-new-btn" data-k="newBtn">+ 新任务</span></div>` : ""}
    ${main}`;

  // 翻页动画共用的动作。
  S.flip = (a, b) => [["off", a, "cur"], ["on", a, "past"], ["on", b, "cur"]];
  /** 字幕。pos：true 或 "top" 放上面，"br" 放右下角（别处空着的时候），默认放下面正中。 */
  S.cap = (main, sub = "", pos = false) => {
    const at = pos === true ? "top" : pos || "";
    return [["text", "capMain", main], ["text", "capSub", sub], ["off", "cap", "top"], ["off", "cap", "br"], ...(at ? [["on", "cap", at]] : []), ["show", "cap"]];
  };
  S.spot = (x, y, w, h) => [["style", "spot", "--sx", `${x}px`], ["style", "spot", "--sy", `${y}px`], ["style", "spot", "--sw", `${w}px`], ["style", "spot", "--sh", `${h}px`], ["on", "spot", "on"]];
  S.capBox = '<div class="ic" data-k="cap" data-off><b data-k="capMain"></b><span data-k="capSub"></span></div>';
})();
