// 展示第 ② 屏：架构，对比着讲（2026-10-30 用户）。翻页，五章：
//   1 常规：项目 › 会话。照常见 AI 编程客户端的侧栏画（2026-11-04 用户：照 Codex App 的「Projects」那一列，配色和样子
//     尽量一致，深浅各一套）：项目是文件夹，会话直接挂在下面、按时间排；一件事散成几段，「继续推进」是哪件事的看不出来
//   2 AMO：项目定位，任务干活。同样几段会话收进任务；右边一层层讲：项目只定位文件夹，任务是干活的单位（状态、说明、
//     进度、交接，在看板上走），任务里开多个会话（新会话、分支、子会话），最后讲为什么这么分。
//     11-04 用户：旧版的会话一条条跳出来，字幕没留够时间看——这两章界面一次画好，每一步停 3 秒上下给人读
//   3 任务：强模型带弱模型。主会话（Claude Opus）定方案，用 session_start 把细活交给 DeepSeek 子会话，结果自动回到主会话，
//     它再审（host features/sessions/mcp.ts：model 可以是更便宜的，report 时每轮结果回到主会话）
//   4 专题：一个 git 仓库开三个 worktree，各当一个项目；一个专题管几条线，各在自己的 worktree 里改、分别验证
//   5 画布：跟主控说一句，它用「画布建组 / 画布归组 / 画布连依赖」排好（canvas/mcp.ts，每次都要人批准；组可以绑到项目），
//     之后谁在做、谁在等一眼看清
// 只播一遍。任务名、项目名、对话内容、批准卡片上的说明文字是示意；常规那一侧的客户端是示意，不是哪个产品的截图。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const S = T.studioParts;
  const { chip, studio, flip, cap } = S;
  const TOPIC = "3.2 版本";

  // 1 常规：客户端的侧栏（项目 › 会话）
  const FOLDER = '<svg class="cdx-fd" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.6l1.8 1.9H16a1.5 1.5 0 0 1 1.5 1.5v7.1A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z"/></svg>';
  const proj = (k, name, { hov = false, label = "" } = {}) => `<div class="cdx-row pj${hov ? " hov" : ""}" data-k="${k}">${FOLDER}<span class="cdx-t">${name}</span>${hov ? '<span class="cdx-acts">···&nbsp;&nbsp;✎</span>' : ""}${label}</div>`;
  const conv = (k, name, label = "") => `<div class="cdx-row cdx-cv" data-k="${k}"><span class="cdx-t">${name}</span>${label}</div>`;
  const lab = (k, text) => `<span class="cdx-lab" data-k="${k}" data-off>${text}</span>`;
  /** 右边的说明卡：一步一张，前面的变淡留着。 */
  const note = (k, head, lines) => `<div class="ex-card" data-k="${k}" data-off><b>${head}</b>${lines.map((l) => `<p>${l}</p>`).join("")}</div>`;

  // 2 AMO：同样几段会话收进任务
  const asess = (icon, kind, name, model) => `<div class="am-sess"><span class="am-si">${icon}</span><em>${kind}</em><span class="am-sn">${name}</span>${chip(model)}</div>`;
  const atask = (k, title, word, tone, rows = []) => `
    <div class="am-task" data-k="${k}"><div class="am-th"><b>任务</b><span class="am-tt">${title}</span><span class="am-st"><span class="s-dot ${tone}"></span>${word}</span></div>${rows.join("")}</div>`;
  const layer = (k, tag, head, lines) => `<div class="ex-card ly" data-k="${k}" data-off><b><i>${tag}</i>${head}</b>${lines.map((l) => `<p>${l}</p>`).join("")}</div>`;
  /** 说明卡一张张亮：当前这张亮，前面的变淡。 */
  const focusCard = (k, before) => [...before.map((b) => ["on", b, "past"]), ["show", k]];

  // 3 任务页
  const tsess = (k, icon, name, tag, model, { cur = false, hidden = false, sub = false } = {}) => `
    <div class="tp-sess${cur ? " cur" : ""}${sub ? " sub" : ""}" data-k="${k}"${hidden ? " data-off" : ""}><span class="ic-s">${icon}</span>
      <span class="tp-sn"><b>${name}</b><span>${chip(model)}${tag ? `<em>${tag}</em>` : ""}</span></span></div>`;
  const nav = `
    <div class="iw-nrow">全部任务<span class="n">6</span></div>
    <div class="iw-nhead">专题</div>
    <div class="iw-nrow cur">▢ ${TOPIC}<span class="n">4</span></div>
    <div class="iw-nhead">项目</div>
    <div class="iw-nrow">▭ MyGame<span class="n">2</span></div>
    <div class="iw-nrow">▭ MyGame-drop<span class="n">1</span></div>
    <div class="iw-nrow">▭ MyGame-ui<span class="n">1</span></div>`;

  // 3 worktree → 项目 → 专题里的任务
  const WT = [
    ["MyGame", "main", "合并验证"],
    ["MyGame-drop", "drop", "掉落表改版"],
    ["MyGame-ui", "ui", "背包界面"],
  ];

  // 4 画布小窗里的卡片
  const ccard = (k, title, project, model, x, y) => `
    <div class="cv-card cm-card" data-k="${k}" style="left:${x}px;top:${y}px"><b>${title}</b>
      <div class="iw-st"><span class="s-dot" data-k="${k}-dot"></span><span data-k="${k}-st">未开始</span><span class="s-faint">· ${project}</span></div>
      <div class="iw-cm">${chip(model)}</div><span class="h-run" data-k="${k}-run" data-off></span></div>`;
  const state = (k, word, tone) => [["text", `${k}-st`, word], ["off", `${k}-dot`, "run"], ["off", `${k}-dot`, "att"], ...(tone ? [["on", `${k}-dot`, tone]] : []), [tone === "run" ? "show" : "hide", `${k}-run`]];
  const move = (k, x, y) => [["style", k, "left", `${x}px`], ["style", k, "top", `${y}px`]];

  T.uses("全部任务", "专题", "项目", "会话", "新会话", "分支", "子会话", "Review", "书签", "归档", "开会话", "画布建组", "画布归组", "画布连依赖", "批准", "运行中", "未开始", "完成", "待办", "进行中", "待审阅", "画布", "主控", "看板");
  T.scene({
    id: "sc-topic",
    title: "专题 › 任务 › 会话：和常规的项目 › 会话对比",
    height: 660,
    narrowHeight: 230,
    once: true,
    world: [1280, 800],
    chapters: [
      [0, "常规：项目 › 会话", "tutorial.html#ch6-compare"],
      [3, "AMO：项目定位，任务干活", "tutorial.html#ch6-why"],
      [8, "任务：强模型带弱模型", "tutorial.html#ch6-sub"],
      [11, "专题：一个仓库，几条线", "tutorial.html#ch6-topic"],
      [14, "画布：跟 AI 说一句，排成图", "tutorial.html#ch6-ask"],
    ],
    html: `<div class="ic-cam"><div class="pgs">
      <section class="pg cur pg-cdx" data-k="p0">
        <div class="cdx-cap"><b>常规的 AI 编程客户端</b><span>项目 › 会话</span></div>
        <div class="cdx">
          <div class="cdx-side">
            <div class="cdx-row cdx-tool"><span class="cdx-ic">✎</span>新对话</div>
            <div class="cdx-row cdx-tool"><span class="cdx-ic">⌕</span>搜索</div>
            <div class="cdx-h">Projects<span>⌄</span></div>
            ${proj("cToolKit", "ToolKit")}
            ${proj("cServer", "MyGame-server", { hov: true })}
            ${proj("cMyGame", "MyGame", { label: lab("lbProj", "← 项目：一个文件夹") })}
            ${conv("c0", "改掉落表，拆成基础权重和活动加成")}
            ${conv("c1", "查背包界面错位")}
            ${conv("c2", "继续推进", lab("lbSess", "← 会话：直接挂在项目下，按时间排") + lab("lbWhich", "← 继续推进……哪件事的？"))}
            ${conv("c3", "掉落表：换个模型再试一遍", lab("lbSame", "← 这三段都是「掉落表改版」"))}
            ${conv("c4", "读取检查点，继续改掉落表")}
            <div class="cdx-row cdx-more">Show more</div>
            ${proj("cDaily", "DailyTools")}
            ${proj("cFake", "FakeClient")}
            ${conv("c5", "查找配置导出功能")}
          </div>
          <div class="cdx-main"><div class="cdx-hello">在 MyGame 里做点什么？</div><div class="cdx-input">问点什么，或者交代一件事</div></div>
        </div>
        <div class="ex">
          ${note("n1", "项目 = 一个文件夹", ["先选项目，再在它下面开会话。", "会话一条条挂在项目下面，按最近的时间排。"])}
          ${note("n2", "一件事，散成好几段", ["上下文满了、想换个模型，就得新开一段；", "新的一段和前面的没有关联，只能靠标题对上。"])}
          ${note("n3", "进度没有地方放", ["会话只是一段对话，不知道自己属于哪件事。", "做到哪了、谁在跑、要不要你看，只能一条条点进去翻；几个项目一起推进的大事，更没处放。"])}
        </div>
      </section>

      <section class="pg pg-amo" data-k="p1">
        <div class="am-tree">
          <div class="am-cap"><b>AMO Studio</b><span>项目 › 任务 › 会话</span></div>
          <div class="am-proj" data-k="aProj"><div class="am-ph">${FOLDER}<b>项目</b><span class="am-pn">MyGame</span><code>G:\\Games\\MyGame</code></div>
            ${atask("aT1", "掉落表改版", "进行中", "run", [
              asess("▢", "主会话", "拆成基础权重和活动加成", "claude"),
              asess("▢", "新会话", "读取检查点，继续改", "claude"),
              asess("⑂", "分支", "换个模型再试一遍", "gpt"),
              asess("↳", "子会话", "改 12 张表的字段", "ds"),
            ])}
            ${atask("aT2", "背包界面错位", "待审阅", "att", [asess("▢", "主会话", "查背包界面错位", "gpt")])}
            ${atask("aT3", "合并前检查", "待办", "", [])}
          </div>
        </div>
        <div class="ex">
          ${layer("L1", "项目", "只定位文件夹", ["告诉 AI 代码在哪、在哪干活。", "一个项目下有很多任务；一个仓库的几个 worktree 可以各当一个项目。"])}
          ${layer("L2", "任务", "干活的单位：一件事一个", ["有状态、说明、进度和交接，在看板上从待办走到完成。", "要你批准、等你审阅时，标在任务上。"])}
          ${layer("L3", "会话", "任务里的一段对话，可以开好几个", ["上下文满了，开新会话接着做；想对照，换个模型开分支；", "重复的细活，派给便宜模型的子会话。都归在这件事下面。"])}
          <div class="ex-card why" data-k="L4" data-off><b>为什么这么分</b>
            <p>你要跟进的是一件事，不是一段对话。</p>
            <p>会话会满、会换模型、会几段一起跑；任务把它们收在一起，状态挂在任务上，看板上一眼就知道。</p>
            <p>再往上，几个任务（可以跨项目）归成一个专题。</p></div>
        </div>
      </section>

      <section class="pg pg-app" data-k="p2">
        ${studio(
          `<div class="tk-head"><div><div class="tk-title">掉落表改版</div>
              <div class="tk-meta"><span class="s-dot run"></span>进行中 · ▭ MyGame-drop · ▢ ${TOPIC}</div></div>
            <span class="s-sp"></span><span class="s-btn ghost">新会话</span><span class="s-btn ghost">Review</span><span class="s-btn ghost">书签</span><span class="s-btn ghost">归档</span></div>
          <div class="tp-list"><div class="tp-lh">会话 <span data-k="sessN">1</span></div>
            ${tsess("s1", "▢", "定方案、审结果", "主会话", "claude", { cur: true })}
            ${tsess("s2", "↳", "改 12 张表的字段", "子会话 · 结果回到主会话", "ds", { hidden: true, sub: true })}
          </div>
          <div class="tp-thread">
            <div class="tk-user">掉落表要拆成「基础权重」和「活动加成」，12 张表都要改</div>
            <p>先定方案：每张表加「活动加成」一列，默认 0；读表按两列相加。改表是重复的细活，交给 DeepSeek 子会话做，我来审。</p>
            <div class="ch-tool" data-k="tool" data-off><span class="ch-tn">开会话</span><code>session_start</code><span class="s-sp"></span>${chip("ds")}<span class="s-faint">改 12 张表的字段</span></div>
            <div class="ch-back" data-k="back" data-off><b>↩ 子会话「改 12 张表的字段」</b>改完 12 张，校验 12/12 通过。</div>
            <p data-k="review" data-off>看了改动：第 7 张表的列名写成了「活动加层」，已经让子会话改掉。其余没问题。</p>
          </div>`,
          { nav, usage: false, view: false },
        )}
      </section>

      <section class="pg pg-arch" data-k="p3">
        <div class="wt">
          <div class="wt-col"><div class="ar-h">一个 git 仓库<span>三个 worktree</span></div>
            ${WT.map(([n, br], i) => `<div class="wt-row" data-k="w${i}"><span class="wt-ic">⎇</span><b>${n}</b><span class="s-faint">分支 ${br}</span></div>`).join("")}</div>
          <div class="wt-arrow">→</div>
          <div class="wt-col"><div class="ar-h">Studio 里<span>各当一个项目</span></div>
            ${WT.map(([n], i) => `<div class="wt-row pj" data-k="pj${i}" data-off><span class="wt-ic">▭</span><b>${n}</b></div>`).join("")}</div>
          <div class="wt-arrow">→</div>
          <div class="wt-col"><div class="ar-h">一个专题<span>几条线一起推进</span></div>
            <div class="ar-topic wt-topic" data-k="wTopic" data-off><div class="ar-tt"><b>专题</b>${TOPIC}</div>
              ${WT.map(([n, , t], i) => `<div class="wt-task" data-k="t${i}" data-off><b>${t}</b><span class="ar-pj">▭ ${n}</span></div>`).join("")}</div></div>
        </div>
      </section>

      <section class="pg pg-split" data-k="p4">
        <div class="ch">
          <div class="ch-head"><span class="iw-logo small"></span><b>${TOPIC} · 主控</b><span class="lead-badge">主控</span></div>
          <div class="ch-body">
            <div class="tk-user" data-k="ask" data-off>把 3.2 的任务按 worktree 分组排到画布上，标出谁等谁</div>
            <div class="ch-tool" data-k="ct1" data-off><span class="ch-tn">画布建组</span><span class="s-faint">MyGame-drop、MyGame-ui、MyGame，各绑一个项目</span></div>
            <div class="ch-tool" data-k="ct2" data-off><span class="ch-tn">画布归组</span><span class="s-faint">三个任务放进各自项目的组</span></div>
            <div class="ch-tool" data-k="ct3" data-off><span class="ch-tn">画布连依赖</span><span class="s-faint">掉落表改版、背包界面 → 合并验证</span></div>
            <div class="ch-appr" data-k="appr" data-off><b>要改画布：建 3 个组、归组、连 2 条依赖</b><span class="s-sp"></span><span class="s-btn att" data-k="ok">批准</span></div>
            <p data-k="done" data-off>排好了。合并验证要等另外两个做完；掉落表改版已经完成，背包界面还在跑。</p>
          </div>
          <div class="ch-input" data-k="input"></div>
        </div>
        <div class="cm">
          <div class="cm-head"><b>画布</b><span class="s-faint">${TOPIC}</span><span class="s-sp"></span><span class="s-faint">小窗</span></div>
          <div class="cm-area">
            <div class="cv-group cm-g" data-k="g1" data-off style="left:16px;top:24px;width:262px;height:170px"><span class="gt">▭ MyGame-drop</span></div>
            <div class="cv-group cm-g" data-k="g2" data-off style="left:16px;top:236px;width:262px;height:170px"><span class="gt">▭ MyGame-ui</span></div>
            <div class="cv-group cm-g" data-k="g3" data-off style="left:318px;top:130px;width:262px;height:170px"><span class="gt">▭ MyGame</span></div>
            <svg class="cv-lines" viewBox="0 0 600 640" width="600" height="640" aria-hidden="true">
              <defs><marker id="cv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="cv-ah" d="M0 0L10 5L0 10z"/></marker><marker id="cv-arrow-go" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="cv-ah go" d="M0 0L10 5L0 10z"/></marker></defs>
              <path class="cv-line cm-line" data-k="l1" pathLength="1" d="M254 108 C290 108 290 206 334 206"/>
              <path class="cv-line cm-line" data-k="l2" pathLength="1" d="M254 320 C290 320 290 226 334 226"/>
            </svg>
            ${ccard("A", "掉落表改版", "MyGame-drop", "claude", 300, 40)}
            ${ccard("B", "背包界面", "MyGame-ui", "gpt", 60, 300)}
            ${ccard("C", "合并验证", "MyGame", "claude", 330, 420)}
          </div>
        </div>
      </section>
    </div>${S.capBox}</div>`,
    steps: [
      // 1 常规：项目 › 会话（界面一次画好，只换高亮和右边的说明）
      { hold: 3000, do: [...cap("常规：项目 › 会话"), ["wait", 300], ["on", "cMyGame", "hot"], ["show", "lbProj"], ["show", "n1"], ["wait", 900], ["on", "c0", "soft"], ["on", "c1", "soft"], ["on", "c2", "soft"], ["on", "c3", "soft"], ["on", "c4", "soft"], ["show", "lbSess"]] },
      { hold: 3200, do: [["off", "cMyGame", "hot"], ["hide", "lbProj"], ["hide", "lbSess"], ...["c0", "c1", "c2", "c3", "c4"].map((k) => ["off", k, "soft"]), ...cap("一件事，散成好几段会话"), ...focusCard("n2", ["n1"]), ["wait", 300], ["on", "c0", "hot"], ["wait", 250], ["on", "c3", "hot"], ["wait", 250], ["on", "c4", "hot"], ["show", "lbSame"]] },
      { hold: 3400, do: [["hide", "lbSame"], ...["c0", "c3", "c4"].map((k) => ["off", k, "hot"]), ...cap("做到哪、谁在跑，只能点进去翻"), ...focusCard("n3", ["n1", "n2"]), ["wait", 300], ["on", "c2", "which"], ["show", "lbWhich"]] },
      // 2 AMO：同样几段会话收进任务，一层层讲
      { hold: 2600, do: [["hide", "cap"], ...flip("p0", "p1"), ["wait", 600], ...cap("AMO：同样几段会话，收进任务", "一件事一个任务，它的几段会话都在里面")] },
      { hold: 3000, do: [...cap("项目只做定位"), ["on", "aProj", "lit-p"], ["show", "L1"]] },
      { hold: 3200, do: [["off", "aProj", "lit-p"], ...cap("任务才是干活的单位"), ["on", "aProj", "lit-t"], ...focusCard("L2", ["L1"])] },
      { hold: 3400, do: [["off", "aProj", "lit-t"], ...cap("一个任务里，开多个会话"), ["on", "aProj", "lit-s"], ...focusCard("L3", ["L1", "L2"])] },
      { hold: 3800, do: [["off", "aProj", "lit-s"], ...cap("为什么：你跟进的是事，不是对话"), ...focusCard("L4", ["L1", "L2", "L3"])] },
      // 3 任务：强模型带弱模型
      { hold: 400, do: [["hide", "cap"], ...flip("p1", "p2"), ["wait", 550], ...cap("任务：强模型带弱模型", "主模型定方案、审结果，细活交给便宜的模型当子会话")] },
      { hold: 900, do: [["show", "tool"], ["wait", 350], ["show", "s2"], ["text", "sessN", "2"]] },
      { hold: 1700, do: [["show", "back"], ["wait", 700], ["show", "review"]] },
      // 4 专题：一个仓库几条线
      { hold: 300, do: [["hide", "cap"], ...flip("p2", "p3"), ["wait", 550], ...cap("一个仓库开三个 worktree，各当一个项目"), ...[0, 1, 2].flatMap((i) => [["on", `w${i}`, "lit"], ["show", `pj${i}`], ["wait", 300]])] },
      { hold: 300, do: [["wait", 600], ...cap("专题管几条线：各在自己的 worktree 里改", "互不干扰，分别验证，最后合到一起"), ["show", "wTopic"], ...[0, 1, 2].flatMap((i) => [["on", `pj${i}`, "lit"], ["show", `t${i}`], ["wait", 300]])] },
      { hold: 1500, do: [] },
      // 5 画布：跟主控说一句，它排好
      { hold: 300, do: [["hide", "cap"], ...flip("p3", "p4"), ["wait", 550], ...cap("画布：跟 AI 说一句，它排成图", "", "br"), ["type", "input", "把 3.2 的任务按 worktree 分组排到画布上，标出谁等谁"], ["wait", 250], ["text", "input", ""], ["show", "ask"]] },
      { hold: 300, do: [["show", "ct1"], ["wait", 260], ["show", "ct2"], ["wait", 260], ["show", "ct3"], ["wait", 260], ["show", "appr"]] },
      { hold: 400, do: [["click", "ok"], ["hide", "appr"], ["show", "g1"], ["show", "g2"], ["show", "g3"], ["wait", 200], ...move("A", 40, 64), ...move("B", 40, 276), ...move("C", 342, 170), ["wait", 750], ["on", "l1", "drawn"], ["on", "l2", "drawn"]] },
      { hold: 1800, do: [...cap("画布：跟 AI 说一句，它排成图", "你点批准；之后谁在做、谁在等，一眼看清", "br"), ["show", "done"], ...state("A", "完成", ""), ["on", "A", "done"], ["on", "l1", "go"], ...state("B", "运行中", "run"), ...state("C", "等前面做完", "")] },
    ],
  });
})();
