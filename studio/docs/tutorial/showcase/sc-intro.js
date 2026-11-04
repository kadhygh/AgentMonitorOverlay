// 展示页的开场（2026-10-30 用户的分镜，同天改成翻页：推拉镜头看着晕）。五页，每页画面不动，页和页之间横着翻过去，
// 上面一排章节可以点：
//   1 开场：AMO 三个字母 → 长出 Studio、多 AI 协作工作台
//   2 所有 AI：新任务页，字幕里的 Claude / Codex / DeepSeek / 第三方 API 一个个亮起，模型那一排同时长出对应的方块；
//     一句话 + 选 Claude + 开始
//   3 看板：卡片落进「进行中」，再点两下新任务只换模型；聚焦左下角的额度，数字在走
//   4 Focus 悬浮窗：盖在文档上的小窗，任务要批准时喊你，点开直接批；做完了显示「完成待审核」，点「在工作台打开」
//   5 回到对话：任务页停在对话最后，出「按 ↑ 回到本轮回复开始」，点一下回到这一轮回复的开头（task/TurnStartHint.tsx）
// 只播一遍（def.once）。每页按 1280×800 画（def.world），整页缩放放进演示区域。界面照 shell/TopBar、board/*、
// newtask/NewTaskPage、focus/FocusEntry、task/Thread 画；卡片上的模型名、任务名、额度数字、对话内容是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const S = T.studioParts;
  const { MODELS, mk, card, col, studio, flip, cap, spot } = S;
  const ORDER = ["claude", "gpt", "ds", "api"];
  const WORDS = ["Claude", "Codex", "DeepSeek", "第三方 API"];

  /** Focus 的一行；detail：点开后的内容和按钮。 */
  const frow = (k, title, model, detail) => `
    <div class="fw-row" data-k="${k}"><div class="fw-line" data-k="${k}-line"><span class="fw-w" data-k="${k}-w">◐ 运行</span>
      <span class="fw-text"><b>${title}</b><span class="fw-sub"><span data-k="${k}-sub">运行中</span> · ${MODELS[model][1]}</span></span></div>
      <div class="fw-detail">${detail}</div></div>`;

  const frowState = (k, word, sub, tone) => [["text", `${k}-w`, word], ["text", `${k}-sub`, sub], ["off", k, "att"], ["off", k, "done"], ...(tone ? [["on", k, tone]] : [])];
  const tiles = ORDER.flatMap((_, n) => [["on", `cw${n + 1}`, "lit"], ["off", `t${n + 1}`, "pend"], ["on", `t${n + 1}`, "pop"], ["wait", 280]]);

  T.uses("AMO Studio", "书签", "便签", "Focus", "远程", "看板", "画布", "搜索任务或会话", "+ 新任务", "全部任务", "专题", "项目", "Host 运行中", "设置", "要推进什么？", "放进待办", "开始", "待办", "进行中", "待审阅", "完成", "运行中", "待批准", "完成待审核", "批准", "在工作台打开", "我知道了", "回到本轮回复开始", "新会话", "Review", "归档");
  T.scene({
    id: "sc-intro",
    title: "AMO Studio：所有 AI，一个工作台",
    height: 660,
    narrowHeight: 230,
    once: true,
    world: [1280, 800],
    // 章节名写这一段要强调的（10-30 用户：保留章节，让想看某一点的人直接点到）。
    chapters: [
      [0, "多 AI 协作工作台", "tutorial.html#ch0"],
      [2, "所有 AI，一个工作台", "tutorial.html#ch3-board"],
      [5, "多任务并行，额度一眼看到", "tutorial.html#ch3-usage"],
      [8, "Focus 悬浮窗：需要时喊你", "tutorial.html#ch3-focus"],
      [12, "一点回到对话开头", "tutorial.html#ch3-jump"],
    ],
    html: `<div class="ic-cam"><div class="pgs">
      <section class="pg cur pg-title" data-k="p0">
        <div class="iw-glow"></div>
        <div class="iw-big" data-k="big"><span class="iw-l">A</span><span class="iw-l">M</span><span class="iw-l">O</span><span class="iw-studio">Studio</span>
          <div class="iw-bigsub" data-k="bigSub" data-off>多 AI 协作工作台</div></div>
      </section>

      <section class="pg pg-new" data-k="p1">
        <div class="nt-crumb">‹ 看板 <span class="s-faint">/ 新任务</span><span class="s-sp"></span><span class="s-faint">草稿自动保存，离开也不会丢</span></div>
        <div class="nt-q">要推进什么？</div>
        <div class="nt-hint">写下第一句话就能开始。项目、模型和思考强度都在下面，点一下就换。</div>
        <div class="nt-row"><span class="lab">专题</span><span class="iw-pill">不选</span><span class="iw-pill on">掉落表重构</span></div>
        <div class="nt-row"><span class="lab">项目</span><span class="iw-pill">不选</span><span class="iw-pill on">MyGame</span><span class="iw-pill">ToolKit</span></div>
        <div class="nt-comp">
          <div class="nt-prompt" data-k="prompt"></div>
          <div class="nt-mrow"><span class="nt-mempty" data-k="mEmpty">模型</span>
            ${ORDER.map((id, n) => `<span class="nt-tile ${id} pend" data-k="t${n + 1}">${mk(id)}<span class="nm">${MODELS[id][1]}</span><small>${MODELS[id][2]}</small></span>`).join("")}</div>
          <div class="nt-foot"><span class="s-sp"></span><span class="s-btn ghost">放进待办</span><span class="s-btn pri" data-k="start">开始</span></div>
        </div>
      </section>

      <section class="pg pg-app" data-k="p2">
        ${studio(`<div class="iw-board">
          ${col("todo", "待办", 1, card("t0", "掉落表重构 › MyGame", "给掉落表加上校验", { word: "空闲", tone: "", hidden: false, running: false }))}
          ${col("doing", "进行中", 0, '<div class="iw-empty" data-k="emptyDoing">空</div>' + card("c1", "掉落表重构 › MyGame", "掉落表校验报错，查一下原因", { model: "claude" }) + card("c2", "掉落表重构 › ToolKit", "写一个打表工具", { model: "gpt" }) + card("c3", "未归专题 › MyGame", "整理资源加载的资料", { model: "api" }))}
          ${col("review", "待审阅", 0, '<div class="iw-empty">空</div>')}
          ${col("done", "完成", 1, card("d0", "未归专题 › MyGame", "登录页文案改成新版", { model: "ds", word: "完成", tone: "", hidden: false, running: false }))}
        </div>`)}
        <div class="iw-spot" data-k="spot"></div>
      </section>

      <section class="pg pg-desk" data-k="p3">
        <div class="dk-doc"><div class="dk-bar"><span class="dk-dot"></span>3.2 版本需求.md</div>
          <div class="dk-body"><h4>掉落规则</h4><p>Boss 必掉一件紫装，其余按掉落表的权重抽。</p><p>同一件装备 24 小时内最多掉 2 次。</p><h4>打表</h4><p>Drop.xlsx 改完跑一遍打表工具，再提交。</p><p class="s-faint">（你在写文档，AI 在后面跑）</p></div></div>
        <div class="fw" data-k="fw">
          <div class="fw-head"><span class="iw-logo small"></span><b>Focus</b><span class="fw-tag">悬浮窗 · 总在最前</span><span class="s-sp"></span><span class="fw-sum" data-k="fwSum">3 个会话在跑</span></div>
          ${frow("f1", "掉落表校验报错，查一下原因", "claude", '<p class="fw-snip">查到原因：Drop.xlsx 第 24 行的权重写成了文本，校验按数字读就报错。已改成数字，测试通过。</p><div class="fw-acts"><span class="s-btn ghost" data-k="f1-open">在工作台打开</span><span class="s-btn ghost">我知道了</span></div>')}
          ${frow("f2", "写一个打表工具", "gpt", '<p class="fw-snip">要运行：<code>python tools/gen_tables.py --all</code></p><div class="fw-acts"><span class="s-btn att" data-k="f2-ok">批准</span><span class="s-btn ghost">在工作台打开</span></div>')}
          ${frow("f3", "整理资源加载的资料", "api", "")}
        </div>
      </section>

      <section class="pg pg-app" data-k="p4">
        ${studio(
          `<div class="tk-head"><div><div class="tk-title">掉落表校验报错，查一下原因</div>
              <div class="tk-meta"><span class="s-dot"></span>待审阅 · ▭ MyGame · <span class="s-mono">main</span> · ▢ 掉落表重构</div></div>
            <span class="s-sp"></span><span class="s-btn ghost">新会话</span><span class="s-btn ghost">Review</span><span class="s-btn ghost">书签</span><span class="s-btn ghost">归档</span></div>
          <div class="tk-thread"><div class="tk-content" data-k="tc" style="--ty:-548px">
            <div class="tk-old"><div class="tk-user">先看一下掉落表的结构</div><p>Drop.xlsx 有三张表：掉落组、权重、保底……</p><p>……</p></div>
            <div class="tk-user tk-start">掉落表校验报错，查一下原因</div>
            <div class="tk-fold" data-k="tFold">▸ 做了 14 步 · 读了 5 个文件 · 跑了 2 个命令</div>
            <div class="tk-answer">
              <p><b>查到原因了。</b>Drop.xlsx 第 24 行（Boss_03 的紫装）权重写成了文本 <code>"30"</code>，校验脚本按数字读，读到文本就报错。</p>
              <p>改动：</p><ul><li>把第 24 行的权重改回数字 30；</li><li>校验脚本遇到文本时报出是哪一行、哪一列，不再只说「类型错误」；</li><li>补了一条测试：权重是文本时给出行号。</li></ul>
              <pre>tests/test_drop.py ......  6 passed</pre>
              <p>改了这几个文件：</p><ul><li><code>Data/Drop.xlsx</code>：第 24 行权重；</li><li><code>tools/check_drop.py</code>：报错带上行号和列名；</li><li><code>tests/test_drop.py</code>：新加一条测试。</li></ul>
              <pre>- raise TypeError("类型错误")
+ raise TypeError(f"第 {row} 行「{col}」应为数字，现在是文本 {value!r}")</pre>
              <p>之前没发现，是因为这一行是上周从策划表直接粘过来的，粘贴时带上了文本格式。以后从别的表粘数据进来，跑一遍校验就能马上看到是哪一行。</p>
              <p>其他表我也扫了一遍，没有同样的问题。</p>
              <p>要我顺手把打表工具的输入也加上同样的检查吗？</p>
            </div>
          </div>
          <div class="tk-hint" data-k="hint" data-off>按 <kbd>↑</kbd> 回到本轮回复开始</div></div>
          <div class="tk-input">继续推进这个会话，回车发送，Shift+回车换行，输入 / 看命令</div>`,
          { view: false, nav: S.nav(5) },
        )}
      </section>
    </div>
      <div class="ic" data-k="capAI" data-off><b>所有 AI，一个工作台</b><span class="ic-words">${WORDS.map((w, n) => `<i data-k="cw${n + 1}">${w}</i>`).join(" · ")}</span></div>
      <div class="ic" data-k="cap" data-off><b data-k="capMain"></b><span data-k="capSub"></span></div>
    </div>`,
    steps: [
      // 1 开场
      { hold: 350, do: [["on", "big", "go"], ["wait", 600], ["show", "bigSub"]] },
      { hold: 1300, do: [["on", "big", "studio"]] },
      // 2 所有 AI：字幕里的名字亮一个，模型那一排就长出一个
      { hold: 350, do: [...flip("p0", "p1"), ["wait", 600], ["show", "capAI"]] },
      { hold: 800, do: [["hide", "mEmpty"], ...tiles] },
      { hold: 150, do: [["hide", "capAI"], ...cap("一句话 + 一个模型 = 一个任务"), ["text", "prompt", "掉落表校验报错，查一下原因"], ["on", "prompt", "pop"], ["click", "t1"], ["on", "t1", "sel"], ["click", "start"]] },
      // 3 看板：落下一张，再开两张只换模型；额度
      { hold: 450, do: [["hide", "cap"], ...flip("p1", "p2"), ["wait", 550], ["hide", "emptyDoing"], ["show", "c1"], ["on", "c1", "land"], ["text", "n-doing", "1"], ["text", "n-all", "3"]] },
      { hold: 500, do: [...cap("换个模型，再开一个"), ["click", "newBtn"], ["show", "c2"], ["on", "c2", "land"], ["text", "n-doing", "2"], ["text", "n-all", "4"], ["wait", 200], ["click", "newBtn"], ["show", "c3"], ["on", "c3", "land"], ["text", "n-doing", "3"], ["text", "n-all", "5"]] },
      { hold: 1300, do: [...spot(6, 520, 220, 232), ...cap("额度和余额，一眼看到"), ["wait", 500], ["text", "u-claude-left", "剩 78%"], ["style", "u-claude-bar", "--w", "22%"], ["on", "u-claude", "h-tick"], ["text", "u-gpt-left", "剩 63%"], ["style", "u-gpt-bar", "--w", "37%"], ["on", "u-gpt", "h-tick"], ["text", "u-api-left", "$125.82"], ["on", "u-api", "h-tick"]] },
      // 4 Focus 悬浮窗
      { hold: 1700, do: [["hide", "cap"], ["off", "spot", "on"], ...flip("p2", "p3"), ["wait", 450], ["on", "fw", "in"], ...cap("Focus：工作状态汇总悬浮窗", "盖在别的窗口上，你写你的，AI 跑 AI 的")] },
      { hold: 500, do: [...cap("需要你的时候，才喊你"), ...frowState("f2", "! 批准", "待批准", "att"), ["text", "fwSum", "1 件事要你处理"], ["on", "fw", "call"]] },
      { hold: 350, do: [["off", "fw", "call"], ["click", "f2-line"], ["on", "f2", "open"], ["wait", 450], ["click", "f2-ok"], ["off", "f2", "open"], ...frowState("f2", "◐ 运行", "运行中"), ["text", "fwSum", "3 个会话在跑"]] },
      { hold: 150, do: [...cap("做完了也告诉你", "点开看结果，或者直接打开任务"), ...frowState("f1", "✓ 完成", "完成待审核", "done"), ["text", "fwSum", "1 个完成待审核"], ["wait", 500], ["click", "f1-line"], ["on", "f1", "open"], ["wait", 600], ["click", "f1-open"]] },
      // 5 回到对话
      // 字幕放下面：放上面会盖住任务标题，而这一章讲的就是「到了这个任务」（11-04）。提示多停一会儿，点了再换字幕。
      { hold: 2400, do: [["hide", "cap"], ...flip("p3", "p4"), ["wait", 650], ["show", "hint"], ...cap("从 Focus 一点就到这个任务", "对话停在最后，底下提示：按 ↑ 回到这一轮回复的开头")] },
      { hold: 2600, do: [["click", "hint"], ["hide", "hint"], ["style", "tc", "--ty", "-220px"], ["wait", 650], ["on", "tFold", "flash"], ...cap("一点，回到这一轮回复的开头", "从头读它做了什么，不用往上翻")] },
    ],
  });
})();
