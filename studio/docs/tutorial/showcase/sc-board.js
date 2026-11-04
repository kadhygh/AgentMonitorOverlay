// 展示第 1 屏（2026-10-30 用户重定）：一句话 + 选一个模型 = 看板上的一个任务。连开三个，Claude、Codex、第三方 API
// 各一个，同时在跑；左下角的额度跟着动（board/UsageFooter.tsx：订阅剩多少、渠道余额）。只播一遍（def.once）。
// 卡片上的模型名是示意：真卡片不显示模型。任务名、额度数字也是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  // 模型方块（chat/pickers.tsx 的 ModelTile：标记 + 型号 + 账号名）。
  const MODELS = {
    claude: ["C", "Claude Opus 5.5", "Claude Code"],
    gpt: ["G", "GPT-5.6", "Codex"],
    ds: ["D", "DeepSeek V4", "DeepSeek"],
    api: ["API", "中转 Claude", "第三方渠道"],
  };
  const tile = (id) => {
    const [mark, name, sub] = MODELS[id];
    return `<span class="h-tile ${id}" data-k="m-${id}"><i class="h-mk ${id}">${mark}</i><span class="h-tn">${name}</span><small>${sub}</small></span>`;
  };
  const chip = (id) => `<span class="h-chip"><i class="h-mk ${id}">${MODELS[id][0]}</i>${MODELS[id][1]}</span>`;
  const card = (k, where, title, model, { word = "运行中", tone = "run", hidden = true, running = true } = {}) => `
    <div class="s-card h-card" data-k="${k}"${hidden ? " data-off" : ""}><div class="s-card-where">${where}</div><b>${title}</b>
      <div class="s-card-st"><span class="s-dot ${tone}" data-k="${k}-dot"></span><span data-k="${k}-st"${tone === "att" ? ' class="s-att"' : ""}>${word}</span></div>
      <div class="h-card-model">${chip(model)}</div>${running ? `<span class="h-run" data-k="${k}-run"></span>` : ""}</div>`;
  const col = (id, name, n, body, cls = "") =>
    `<div class="s-col ${cls}"><div class="s-col-head">${name}<span class="n" data-k="n-${id}">${n}</span></div>${body}</div>`;
  // 额度：订阅显示剩多少 + 一条用量，渠道显示余额。
  const acct = (k, name, sub, left, used) => `
    <div class="h-acct" data-k="u-${k}"><div class="h-acct-line"><b>${name}</b><span class="h-acct-sub">${sub}</span><span class="h-left" data-k="u-${k}-left">${left}</span></div>
      ${used === undefined ? "" : `<div class="h-bar"><span data-k="u-${k}-bar" style="--w:${used}%"></span></div>`}</div>`;

  T.uses("AMO Studio", "书签", "便签", "Focus", "全部任务", "专题", "项目", "看板", "画布", "+ 新任务", "Host 运行中", "要推进什么？", "放进待办", "开始", "待办", "进行中", "待审阅", "完成", "待批准", "运行中", "空闲");
  T.scene({
    id: "sc-board",
    title: "一句话加一个模型，就是看板上的一个任务",
    height: 470,
    narrowHeight: 500,
    once: true,
    html: `<div class="h-app">
      <div class="h-top"><span class="s-logo"></span><b class="h-brand">AMO Studio</b><span class="s-sp"></span><span class="h-tb">书签</span><span class="h-tb">便签</span><span class="h-tb">Focus</span></div>
      <div class="h-nav">
        <div class="s-nav-row cur">全部任务<span class="n" data-k="n-all">1</span></div>
        <div class="s-nav-head">专题</div>
        <div class="s-nav-row">▢ 掉落表重构</div>
        <div class="s-nav-head">项目</div>
        <div class="s-nav-row">▭ MyGame</div>
        <div class="s-nav-row">▭ ToolKit</div>
        <div class="h-usage" data-k="usage">
          <div class="h-usage-head">额度</div>
          ${acct("claude", "Claude", "订阅 · 5h", "剩 82%", 18)}
          ${acct("gpt", "GPT", "订阅 · 5h", "剩 68%", 32)}
          ${acct("ds", "DeepSeek", "余额", "¥88.10")}
          ${acct("api", "中转 Claude", "第三方", "$126.40")}
          <div class="h-host"><span class="s-dot run"></span>Host 运行中</div>
        </div>
      </div>
      <div class="h-viewbar"><span class="s-tab on">看板</span><span class="s-tab">画布</span><span class="s-sp"></span><span class="s-btn pri" data-k="newBtn">+ 新任务</span></div>
      <div class="h-main">
        <div class="s-board h-board">
          ${col("todo", "待办", 0, '<div class="s-col-empty">空</div>', "h-side")}
          ${col("doing", "进行中", 0, '<div class="s-col-empty" data-k="emptyDoing">空</div>' + card("c1", "掉落表重构 › MyGame", "掉落表校验报错，查原因", "claude") + card("c2", "掉落表重构 › ToolKit", "写一个打表工具", "gpt") + card("c3", "未归专题 › MyGame", "整理资源加载的资料", "api"))}
          ${col("review", "待审阅", 0, '<div class="s-col-empty" data-k="emptyReview">空</div>' + card("c1b", "掉落表重构 › MyGame", "掉落表校验报错，查原因", "claude", { word: "空闲", tone: "", running: false }))}
          ${col("done", "完成", 1, card("c0", "未归专题 › MyGame", "登录页文案改成新版", "ds", { word: "完成", tone: "", hidden: false, running: false }), "h-side")}
        </div>
        <div class="h-new" data-k="composer" data-off>
          <div class="h-new-q">要推进什么？</div>
          <div class="h-new-text" data-k="prompt"></div>
          <div class="h-models">${tile("claude")}${tile("gpt")}${tile("ds")}${tile("api")}</div>
          <div class="h-new-foot"><span class="s-sp"></span><span class="s-btn ghost">放进待办</span><span class="s-btn pri" data-k="start">开始</span></div>
        </div>
      </div>
    </div>`,
    steps: [
      // 第一个：Claude
      { hold: 150, do: [["click", "newBtn"], ["show", "composer"]] },
      { hold: 150, do: [["type", "prompt", "掉落表校验报错，查原因"], ["click", "m-claude"], ["on", "m-claude", "sel"]] },
      { hold: 150, do: [["click", "start"], ["on", "composer", "h-fly"], ["wait", 380]] },
      { hold: 300, do: [["hide", "composer"], ["off", "composer", "h-fly"], ["off", "m-claude", "sel"], ["text", "prompt", ""], ["hide", "emptyDoing"], ["show", "c1"], ["on", "c1", "h-land"], ["text", "n-doing", "1"], ["text", "n-all", "2"]] },
      // 第二个：Codex
      { hold: 150, do: [["click", "newBtn"], ["show", "composer"], ["type", "prompt", "写一个打表工具"], ["click", "m-gpt"], ["on", "m-gpt", "sel"]] },
      { hold: 150, do: [["click", "start"], ["on", "composer", "h-fly"], ["wait", 380]] },
      { hold: 300, do: [["hide", "composer"], ["off", "composer", "h-fly"], ["off", "m-gpt", "sel"], ["text", "prompt", ""], ["show", "c2"], ["on", "c2", "h-land"], ["text", "n-doing", "2"], ["text", "n-all", "3"]] },
      // 第三个：第三方 API 的渠道
      { hold: 150, do: [["click", "newBtn"], ["show", "composer"], ["type", "prompt", "整理资源加载的资料"], ["click", "m-api"], ["on", "m-api", "sel"]] },
      { hold: 150, do: [["click", "start"], ["on", "composer", "h-fly"], ["wait", 380]] },
      { hold: 500, do: [["hide", "composer"], ["off", "composer", "h-fly"], ["text", "prompt", ""], ["show", "c3"], ["on", "c3", "h-land"], ["text", "n-doing", "3"], ["text", "n-all", "4"]] },
      // 三个同时在跑：左下角的额度跟着动
      { hold: 700, do: [["move", "usage", 0.55, 0.42], ["on", "usage", "h-glow"], ["text", "u-claude-left", "剩 79%"], ["style", "u-claude-bar", "--w", "21%"], ["on", "u-claude", "h-tick"], ["text", "u-gpt-left", "剩 63%"], ["style", "u-gpt-bar", "--w", "37%"], ["on", "u-gpt", "h-tick"], ["text", "u-api-left", "$125.82"], ["on", "u-api", "h-tick"]] },
      { hold: 900, do: [["off", "u-claude", "h-tick"], ["off", "u-gpt", "h-tick"], ["off", "u-api", "h-tick"], ["text", "c2-st", "待批准"], ["off", "c2-dot", "run"], ["on", "c2-dot", "att"], ["on", "c2-st", "s-att"], ["hide", "c2-run"]] },
      { hold: 400, do: [["text", "c1-st", "空闲"], ["off", "c1-dot", "run"], ["hide", "c1-run"], ["text", "u-claude-left", "剩 77%"], ["style", "u-claude-bar", "--w", "23%"], ["on", "u-claude", "h-tick"], ["text", "u-api-left", "$125.31"], ["on", "u-api", "h-tick"]] },
      { hold: 600, do: [["hide", "c1"], ["hide", "emptyReview"], ["show", "c1b"], ["text", "n-doing", "2"], ["text", "n-review", "1"], ["off", "usage", "h-glow"]] },
    ],
  });
})();
