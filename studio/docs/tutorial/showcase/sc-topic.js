// 展示第 ② 屏：架构，对比着讲（2026-10-30 用户）。翻页，四章：
//   1 常规 vs AMO：常规的 IDE / harness 先选项目、在项目下开会话，会话越堆越多；AMO 把会话包进任务，任务归进专题
//   2 任务：强模型带弱模型。主会话（Claude Opus）定方案，用 session_start 把细活交给 DeepSeek 子会话，结果自动回到主会话，
//     它再审（host features/sessions/mcp.ts：model 可以是更便宜的，report 时每轮结果回到主会话）
//   3 专题：一个 git 仓库开三个 worktree，各当一个项目；一个专题管几条线，各在自己的 worktree 里改、分别验证
//   4 画布：跟主控说一句，它用「画布建组 / 画布归组 / 画布连依赖」排好（canvas/mcp.ts，每次都要人批准；组可以绑到项目），
//     之后谁在做、谁在等一眼看清
// 只播一遍。任务名、项目名、对话内容、批准卡片上的说明文字是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const S = T.studioParts;
  const { chip, studio, flip, cap } = S;
  const TOPIC = "3.2 版本";

  // 1 对比
  const flat = ["改掉落表", "改掉落表（续）", "查校验报错", "换个模型再试", "背包界面", "背包界面（二）", "合并前检查", "……"];
  const atask = (k, title, project, sessions) => `
    <div class="ar-task" data-k="${k}" data-off><div class="ar-th"><b>任务</b>${title}<span class="ar-pj">▭ ${project}</span></div>
      ${sessions.map(([name, model, sub]) => `<div class="ar-sess${sub ? " sub" : ""}">▢ ${name}<span class="s-sp"></span>${chip(model)}</div>`).join("")}</div>`;

  // 2 任务页
  const sess = (k, icon, name, tag, model, { cur = false, hidden = false, sub = false } = {}) => `
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

  T.uses("全部任务", "专题", "项目", "会话", "新会话", "Review", "书签", "归档", "开会话", "画布建组", "画布归组", "画布连依赖", "批准", "运行中", "未开始", "完成", "画布", "主控");
  T.scene({
    id: "sc-topic",
    title: "专题 › 任务 › 会话：和常规的项目 › 会话对比",
    height: 660,
    narrowHeight: 230,
    once: true,
    world: [1280, 800],
    chapters: [
      [0, "常规 vs AMO：多包了两层", "tutorial.html#ch6-compare"],
      [2, "任务：强模型带弱模型", "tutorial.html#ch6-sub"],
      [5, "专题：一个仓库，几条线", "tutorial.html#ch6-topic"],
      [8, "画布：跟 AI 说一句，排成图", "tutorial.html#ch6-ask"],
    ],
    html: `<div class="ic-cam"><div class="pgs">
      <section class="pg cur pg-arch" data-k="p0">
        <div class="ar-col" data-k="colA"><div class="ar-h">常规的 IDE / CLI<span>项目 › 会话</span></div>
          <div class="ar-proj"><div class="ar-ph">▭ MyGame</div>
            ${flat.map((n, i) => `<div class="ar-flat" data-k="f${i}" data-off>▢ ${n}</div>`).join("")}
            <div class="ar-warn" data-k="fWarn" data-off>! 会话越堆越多：哪段是哪件事、哪几段该一起看？</div></div></div>
        <div class="ar-col amo" data-k="colB"><div class="ar-h">AMO Studio<span>专题 › 任务 › 会话</span></div>
          <div class="ar-topic" data-k="topic" data-off><div class="ar-tt"><b>专题</b>${TOPIC}</div>
            ${atask("k1", "掉落表改版", "MyGame-drop", [["主会话：定方案、审结果", "claude"], ["子会话：改 12 张表", "ds", true]])}
            ${atask("k2", "背包界面", "MyGame-ui", [["主会话", "gpt"], ["分支：换个模型再试", "claude", true]])}
            ${atask("k3", "合并验证", "MyGame", [["主会话", "claude"]])}
          </div></div>
      </section>

      <section class="pg pg-app" data-k="p1">
        ${studio(
          `<div class="tk-head"><div><div class="tk-title">掉落表改版</div>
              <div class="tk-meta"><span class="s-dot run"></span>进行中 · ▭ MyGame-drop · ▢ ${TOPIC}</div></div>
            <span class="s-sp"></span><span class="s-btn ghost">新会话</span><span class="s-btn ghost">Review</span><span class="s-btn ghost">书签</span><span class="s-btn ghost">归档</span></div>
          <div class="tp-list"><div class="tp-lh">会话 <span data-k="sessN">1</span></div>
            ${sess("s1", "▢", "定方案、审结果", "主会话", "claude", { cur: true })}
            ${sess("s2", "↳", "改 12 张表的字段", "子会话 · 结果回到主会话", "ds", { hidden: true, sub: true })}
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

      <section class="pg pg-arch" data-k="p2">
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

      <section class="pg pg-split" data-k="p3">
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
      // 1 常规：会话一条条堆在项目下
      { hold: 300, do: [...cap("常规：先选项目，在项目下开会话"), ...flat.flatMap((_, i) => [["show", `f${i}`], ["wait", 170]]), ["show", "fWarn"]] },
      // AMO：会话包进任务，任务归进专题
      { hold: 2000, do: [["on", "colA", "dim"], ...cap("AMO：会话包进任务，任务归进专题", "一件事的几段会话放在一起；几件事归到一个大目标下"), ["show", "topic"], ["wait", 250], ["show", "k1"], ["wait", 250], ["show", "k2"], ["wait", 250], ["show", "k3"]] },
      // 2 任务：强模型带弱模型
      { hold: 400, do: [["hide", "cap"], ...flip("p0", "p1"), ["wait", 550], ...cap("任务：强模型带弱模型", "主模型定方案、审结果，细活交给便宜的模型当子会话")] },
      { hold: 900, do: [["show", "tool"], ["wait", 350], ["show", "s2"], ["text", "sessN", "2"]] },
      { hold: 1700, do: [["show", "back"], ["wait", 700], ["show", "review"]] },
      // 3 专题：一个仓库几条线
      { hold: 300, do: [["hide", "cap"], ...flip("p1", "p2"), ["wait", 550], ...cap("一个仓库开三个 worktree，各当一个项目"), ...[0, 1, 2].flatMap((i) => [["on", `w${i}`, "lit"], ["show", `pj${i}`], ["wait", 300]])] },
      { hold: 300, do: [["wait", 600], ...cap("专题管几条线：各在自己的 worktree 里改", "互不干扰，分别验证，最后合到一起"), ["show", "wTopic"], ...[0, 1, 2].flatMap((i) => [["on", `pj${i}`, "lit"], ["show", `t${i}`], ["wait", 300]])] },
      { hold: 1500, do: [] },
      // 4 画布：跟主控说一句，它排好
      { hold: 300, do: [["hide", "cap"], ...flip("p2", "p3"), ["wait", 550], ...cap("画布：跟 AI 说一句，它排成图", "", "br"), ["type", "input", "把 3.2 的任务按 worktree 分组排到画布上，标出谁等谁"], ["wait", 250], ["text", "input", ""], ["show", "ask"]] },
      { hold: 300, do: [["show", "ct1"], ["wait", 260], ["show", "ct2"], ["wait", 260], ["show", "ct3"], ["wait", 260], ["show", "appr"]] },
      { hold: 400, do: [["click", "ok"], ["hide", "appr"], ["show", "g1"], ["show", "g2"], ["show", "g3"], ["wait", 200], ...move("A", 40, 64), ...move("B", 40, 276), ...move("C", 342, 170), ["wait", 750], ["on", "l1", "drawn"], ["on", "l2", "drawn"]] },
      { hold: 1800, do: [...cap("画布：跟 AI 说一句，它排成图", "你点批准；之后谁在做、谁在等，一眼看清", "br"), ["show", "done"], ...state("A", "完成", ""), ["on", "A", "done"], ["on", "l1", "go"], ...state("B", "运行中", "run"), ...state("C", "等前面做完", "")] },
    ],
  });
})();
