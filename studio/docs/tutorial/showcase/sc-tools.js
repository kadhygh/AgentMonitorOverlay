// 展示第 ③ 屏：工具 · Reviewer + 便签（2026-10-30 用户：两个都和审阅有关；Reviewer 是程序最近评价最高的）。翻页，四章：
//   1 AI 标出要你看的几处：AI 改完调 view_open，把文件放进查看包，标出几处「重点」、每处一句为什么；上面一排重点清单，
//     Tab 一处处看（host features/viewpacks、ui viewpacks/FileItemView.tsx）
//   2 行内批注，一键复制回对话：在那一行写批注（批注小窗），「复制并关闭」，贴回对话，AI 照着改（gitreview/comments）
//   3 HTML 报告也能点位置批注：查看器里的 HTML，右键「在这里批注」（viewer/RenderedReview.tsx）
//   4 便签：快捷键呼出（默认 Ctrl+Shift+F12），边看边记，「复制这一页并隐藏（Ctrl+Enter）」贴回对话，AI 照着改（scratchpad/）。
//     停在 AI 改完的回复上（11-04：以前停在空的 Reviewer 上，像没播完）
// 只播一遍。代码、批注、报告、便签内容是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const S = T.studioParts;
  const { flip, cap } = S;

  const CODE = [
    [20, "public Item Roll(DropTable table, Random rng)"],
    [21, "{"],
    [22, "    var total = table.Entries.Sum(e => e.Weight);"],
    [23, "    var hit = rng.NextDouble() * total;"],
    [24, "    var acc = 0.0;"],
    [25, "    foreach (var e in table.Entries)"],
    [26, "    {"],
    [27, "        acc += e.Weight;"],
    [28, "        if (hit < acc) return e.Item;"],
    [29, "    }"],
    [30, "    return table.Fallback;"],
    [31, "}"],
  ];
  // AI 标的重点（view_open 的 highlights：行、到哪行、一句说明）。查看包里：上面一排重点清单，代码里那几行着色，
  // 说明写在最后一行下面；Tab / Shift+Tab 一处处走（viewpacks/FileItemView.tsx）。11-04 用户：AI 能指明要看哪、为什么，
  // 比「点一下跳到那一行」更友善，这一章要演出来。
  const MARKS = [
    [22, 23, "先把权重加起来，随机数落在 0 到总和之间"],
    [25, 28, "按顺序累加：随机数落在哪一段，就掉哪件"],
    [30, 30, "都没落到时给保底（比如权重全是 0）"],
  ];
  const line = ([n, t]) => `<div class="rv-line" data-k="ln${n}"><span class="no">${n}</span><span class="plus">+</span><code>${t.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></div>`;
  const code = (() => {
    let out = "";
    let i = 0;
    while (i < CODE.length) {
      const m = MARKS.findIndex(([from]) => from === CODE[i][0]);
      if (m < 0) {
        out += line(CODE[i]);
        i++;
        continue;
      }
      const [from, to, note] = MARKS[m];
      const rows = CODE.filter(([n]) => n >= from && n <= to);
      // 第 28 行下面写批注：批注小窗浮在下面几行上，不把它们挤下去（2026-10-31 起的样子，gitreview/DiffView.tsx FloatDraft）。
      const float = '<div class="rv-anchor"><div class="rv-float" data-k="cbox" data-off><div class="rv-fhead">批注第 28 行<span class="s-sp"></span>✕</div><div class="rv-ctext" data-k="ctext"></div><div class="rv-cacts"><span class="s-btn pri" data-k="save">保存</span></div></div></div>';
      out += `<div class="rv-hl" data-k="h${m}">${rows.map((r) => line(r) + (r[0] === 28 ? float : "")).join("")}<div class="rv-note"><b>重点</b>${note}</div></div>`;
      if (from <= 28 && to >= 28) out += '<div class="rv-comment" data-k="saved" data-off><b>批注</b>权重为 0 的条目也要跳过，别让它占着一段</div>';
      i += rows.length;
    }
    return out;
  })();
  const marks = MARKS.map(([from, to, note], m) => `<span class="rv-mark" data-k="m${m}"><b>${from === to ? from : `${from}–${to}`}</b>${note}</span>`).join("");
  /** 重点清单上按下第 m 处，代码里那一段亮起来。 */
  const goMark = (m) => [...MARKS.flatMap((_, j) => [["off", `m${j}`, "on"], ["off", `h${j}`, "cur"]]), ["on", `m${m}`, "on"], ["on", `h${m}`, "cur"]];
  const bars = [
    ["白", 62],
    ["绿", 24],
    ["蓝", 9],
    ["紫", 4.6],
    ["橙", 0.4],
  ];

  T.uses("AMO Reviewer", "查看包", "重点", "改动预览", "保存", "草稿批注", "复制注释", "复制并关闭", "已复制", "查看器", "在这里批注", "批注", "便签内容", "复制这一页并隐藏（Ctrl+Enter）", "工具调用", "下一处", "上一处");
  T.scene({
    id: "sc-tools",
    title: "工具：AMO Reviewer 和便签",
    height: 660,
    narrowHeight: 230,
    once: true,
    world: [1280, 800],
    chapters: [
      [0, "AI 标出要你看的几处", "tutorial.html#ch4-pack"],
      [4, "行内批注，一键复制回对话", "tutorial.html#ch4-comment"],
      [7, "HTML 报告也能点位置批注", "tutorial.html#ch4-viewer"],
      [10, "便签：快捷键呼出，边看边记", "tutorial.html#ch7"],
    ],
    html: `<div class="ic-cam"><div class="pgs">
      <section class="pg pg-split2 cur" data-k="p0">
        <div class="ch">
          <div class="ch-head"><span class="iw-logo small"></span><b>掉落权重改成累加</b><span class="s-faint">AMO Studio</span></div>
          <div class="ch-body">
            <div class="tk-user">掉落权重改成累加，改完带我看关键的地方</div>
            <p>改好了。要你看的三处我放进查看包了，每处写了为什么。</p>
            <div class="ch-tool" data-k="tool" data-off><span class="ch-tn">工具调用</span><code>view_open</code><span class="s-faint">查看包：Drop.cs 3 处重点、Drop.xlsx 改动预览</span></div>
            <div class="tk-user" data-k="pasted" data-off><span class="s-faint">批注 · Drop.cs:28</span><br>权重为 0 的条目也要跳过，别让它占着一段</div>
            <p data-k="fixed" data-off>好，权重为 0 的条目先跳过了，补了一条测试，6/6 通过。</p>
          </div>
          <div class="ch-input" data-k="input"></div>
        </div>
        <div class="rv" data-k="rv" data-off>
          <div class="rv-bar"><span class="iw-logo small"></span><b>AMO Reviewer</b><span class="s-faint">查看包 · 掉落权重改成累加</span><span class="s-sp"></span><span class="s-faint">─ ✕</span></div>
          <div class="rv-body">
            <div class="rv-list"><div class="rv-item cur"><b>Drop.cs</b><span class="rv-tag">3 处重点</span></div><div class="rv-item"><b>Drop.xlsx</b><span class="rv-tag dim">改动预览</span></div></div>
            <div class="rv-main"><div class="rv-marks">${marks}</div>
              <div class="rv-code">${code}</div>
              <div class="rv-ruler">${MARKS.map((_, m) => `<i class="r${m}"></i>`).join("")}</div></div>
          </div>
          <div class="key rv-key" data-k="tab" data-off><kbd>Tab</kbd></div>
          <div class="rv-foot"><span data-k="drafts">草稿批注 0</span><span class="s-faint"><kbd>Tab</kbd> 下一处 · <kbd>Shift Tab</kbd> 上一处</span><span class="s-sp"></span><span class="rv-copied" data-k="copied" data-off>已复制</span><span class="s-btn ghost">复制注释</span><span class="s-btn pri" data-k="copyClose">复制并关闭</span></div>
        </div>
      </section>

      <section class="pg pg-viewer" data-k="p1">
        <div class="rv vw">
          <div class="rv-bar"><span class="iw-logo small"></span><b>查看器</b><span class="s-faint">掉落概率报告.html</span><span class="s-sp"></span><span class="s-faint">─ ✕</span></div>
          <div class="vw-page">
            <h3>3.2 掉落概率报告</h3><p class="s-faint">Boss_03 · 按新权重模拟 10 万次</p>
            <div class="vw-chart">${bars.map(([q, v], i) => `<div class="vw-bar" data-k="bar${i}"><span class="v">${v}%</span><i style="height:${Math.max(4, v * 4)}px"></i><span class="q">${q}</span></div>`).join("")}</div>
            <div class="vw-menu" data-k="menu" data-off><span data-k="here">在这里批注</span><span class="s-faint">复制选中的文字</span></div>
            <span class="vw-pin" data-k="pin" data-off>1</span>
            <div class="vw-cbubble" data-k="pinNote" data-off><b>批注</b><span data-k="pinText"></span></div>
          </div>
          <div class="rv-foot"><span data-k="vdrafts">草稿批注 0</span><span class="s-sp"></span><span class="s-btn ghost" data-k="vcopy">复制注释</span><span class="s-btn pri">复制并关闭</span></div>
        </div>
      </section>

      <section class="pg pg-desk2" data-k="p2">
        <div class="rv dimwin"><div class="rv-bar"><span class="iw-logo small"></span><b>AMO Reviewer</b><span class="s-faint">背包界面 · 工作区改动</span></div>
          <div class="dk-lines">${Array.from({ length: 14 }, (_, i) => `<i style="width:${40 + ((i * 37) % 50)}%"></i>`).join("")}</div></div>
        <div class="key" data-k="key" data-off><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F12</kbd></div>
        <div class="pad" data-k="pad" data-off>
          <div class="pad-head"><b>便签</b><span class="pad-tabs"><i class="on">1</i><i>2</i><i>3</i></span><span class="s-sp"></span><span class="s-faint">Esc</span></div>
          <div class="pad-text" data-k="padText"></div>
          <div class="pad-foot"><span class="s-faint">Alt+1…9 换页</span><span class="s-sp"></span><span class="s-btn pri" data-k="padCopy">复制这一页并隐藏 · Ctrl+Enter</span></div>
        </div>
        <div class="toast" data-k="toast" data-off>已复制，贴回对话就行</div>
        <div class="ch pad-chat" data-k="padChat" data-off>
          <div class="ch-head"><span class="iw-logo small"></span><b>背包界面</b><span class="s-faint">AMO Studio</span></div>
          <div class="ch-body">
            <div class="tk-user" data-k="padPasted" data-off>· 背包格子间距太挤，改成 8px<br>· 紫装图标和蓝装分不清<br>· 整理按钮放到右上</div>
            <p data-k="padFixed" data-off>三处都改了：格子间距 8px，紫装加了描边，整理按钮挪到右上。截图放进查看包了。</p>
          </div>
        </div>
      </section>
    </div>${S.capBox}</div>`,
    steps: [
      // 1 AI 标出要你看的几处，每处一句为什么；Tab 一处处看
      { hold: 600, do: [...cap("AI 标出要你看的几处", "改完把文件放进查看包，每处写一句为什么"), ["wait", 400], ["show", "tool"]] },
      { hold: 2600, do: [["show", "rv"], ["on", "rv", "pop"], ...goMark(0)] },
      { hold: 2200, do: [...cap("按 Tab，一处处看下去", "不用自己翻 diff 找：看哪、为什么，都写在旁边"), ["show", "tab"], ["wait", 350], ...goMark(1), ["wait", 1500], ["hide", "tab"], ["wait", 300], ["show", "tab"], ["wait", 350], ...goMark(2), ["wait", 900], ["hide", "tab"]] },
      { hold: 1600, do: [...cap("上面一排是重点清单", "点哪处，到哪处"), ["click", "m1"], ...goMark(1)] },
      // 2 写批注、复制回对话
      { hold: 200, do: [...cap("行内批注，一键复制回对话"), ["move", "ln28", 0.06, 0.5], ["on", "ln28", "hover"], ["click", "ln28"], ["show", "cbox"], ["type", "ctext", "权重为 0 的条目也要跳过，别让它占着一段"], ["click", "save"], ["hide", "cbox"], ["show", "saved"], ["text", "drafts", "草稿批注 1"]] },
      { hold: 300, do: [["click", "copyClose"], ["show", "copied"], ["wait", 450], ["hide", "rv"]] },
      { hold: 1300, do: [["show", "pasted"], ["wait", 900], ["show", "fixed"]] },
      // 3 HTML 报告：位置批注
      { hold: 300, do: [["hide", "cap"], ...flip("p0", "p1"), ["wait", 550], ...cap("HTML 报告也能点位置批注", "右键图上的那一处，写下你的意见")] },
      { hold: 200, do: [["move", "bar3", 0.5, 0.55], ["wait", 200], ["show", "menu"], ["click", "here"], ["hide", "menu"], ["show", "pin"], ["show", "pinNote"], ["type", "pinText", "紫装这一档偏高，按 3% 再调"], ["text", "vdrafts", "草稿批注 1"]] },
      { hold: 1300, do: [["click", "vcopy"], ...cap("HTML 报告也能点位置批注", "批注带着位置，复制回对话，AI 知道你说的是哪")] },
      // 4 便签
      { hold: 300, do: [["hide", "cap"], ...flip("p1", "p2"), ["wait", 550], ...cap("便签：快捷键呼出，边看边记"), ["show", "key"], ["wait", 500], ["show", "pad"], ["hide", "key"]] },
      { hold: 300, do: [["type", "padText", "· 背包格子间距太挤，改成 8px\n· 紫装图标和蓝装分不清\n· 整理按钮放到右上"]] },
      { hold: 2200, do: [["click", "padCopy"], ["hide", "pad"], ["show", "toast"], ...cap("便签：快捷键呼出，边看边记", "Ctrl+Enter 复制这一页并隐藏，贴回给 AI"), ["wait", 900], ["hide", "toast"], ["show", "padChat"], ["wait", 300], ["show", "padPasted"], ["wait", 1100], ["show", "padFixed"]] },
    ],
  });
})();
