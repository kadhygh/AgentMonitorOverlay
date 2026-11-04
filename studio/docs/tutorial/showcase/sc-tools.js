// 展示第 ③ 屏：工具 · Reviewer + 便签（2026-10-30 用户：两个都和审阅有关；Reviewer 是程序最近评价最高的）。翻页，四章：
//   1 AI 直接带你到关键几行：AI 改完调 view_open，把文件放进查看包、标出「重点」行和一句说明（host features/gitreview、viewpacks）
//   2 行内批注，一键复制回对话：在那一行写批注，「复制并关闭」，贴回对话，AI 照着改（gitreview/comments）
//   3 HTML 报告也能点位置批注：查看器里的 HTML，右键「在这里批注」（viewer/RenderedReview.tsx）
//   4 便签：快捷键呼出（默认 Ctrl+Shift+F12），边看边记，「复制这一页并隐藏（Ctrl+Enter）」贴回给 AI（scratchpad/）
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
  const code = CODE.map(([n, t]) => `<div class="rv-line${n >= 24 && n <= 30 ? " hl" : ""}" data-k="ln${n}"><span class="no">${n}</span><span class="plus">+</span><code>${t.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></div>`).join("");
  const bars = [
    ["白", 62],
    ["绿", 24],
    ["蓝", 9],
    ["紫", 4.6],
    ["橙", 0.4],
  ];

  T.uses("AMO Reviewer", "查看包", "重点", "改动预览", "保存", "草稿批注", "复制注释", "复制并关闭", "已复制", "查看器", "在这里批注", "批注", "便签内容", "复制这一页并隐藏（Ctrl+Enter）", "工具调用");
  T.scene({
    id: "sc-tools",
    title: "工具：AMO Reviewer 和便签",
    height: 660,
    narrowHeight: 230,
    once: true,
    world: [1280, 800],
    chapters: [
      [0, "AI 直接带你到关键几行", "tutorial.html#ch4-pack"],
      [2, "行内批注，一键复制回对话", "tutorial.html#ch4-comment"],
      [5, "HTML 报告也能点位置批注", "tutorial.html#ch4-viewer"],
      [8, "便签：快捷键呼出，边看边记", "tutorial.html#ch7"],
    ],
    html: `<div class="ic-cam"><div class="pgs">
      <section class="pg pg-split2 cur" data-k="p0">
        <div class="ch">
          <div class="ch-head"><span class="iw-logo small"></span><b>掉落权重改成累加</b><span class="s-faint">AMO Studio</span></div>
          <div class="ch-body">
            <div class="tk-user">掉落权重改成累加，改完带我看关键的地方</div>
            <p>改好了。关键在 <code>Drop.cs</code> 的累加和边界，我放进查看包了，标了重点。</p>
            <div class="ch-tool" data-k="tool" data-off><span class="ch-tn">工具调用</span><code>view_open</code><span class="s-faint">查看包：Drop.cs 24–30（重点）、Drop.xlsx（改动预览）</span></div>
            <div class="tk-user" data-k="pasted" data-off><span class="s-faint">批注 · Drop.cs:28</span><br>权重为 0 的条目也要跳过，别让它占着一段</div>
            <p data-k="fixed" data-off>好，权重为 0 的条目先跳过了，补了一条测试，6/6 通过。</p>
          </div>
          <div class="ch-input" data-k="input"></div>
        </div>
        <div class="rv" data-k="rv" data-off>
          <div class="rv-bar"><span class="iw-logo small"></span><b>AMO Reviewer</b><span class="s-faint">查看包 · 掉落权重改成累加</span><span class="s-sp"></span><span class="s-faint">─ ✕</span></div>
          <div class="rv-body">
            <div class="rv-list"><div class="rv-item cur"><b>Drop.cs</b><span class="rv-tag">重点 24–30</span></div><div class="rv-item"><b>Drop.xlsx</b><span class="rv-tag dim">改动预览</span></div></div>
            <div class="rv-code">${code}
              <div class="rv-note" data-k="note"><b>重点</b>权重按顺序累加，随机数落在哪一段就掉哪件；都没落到时给保底。</div>
              <div class="rv-cbox" data-k="cbox" data-off><div class="rv-ctext" data-k="ctext"></div><div class="rv-cacts"><span class="s-btn pri" data-k="save">保存</span></div></div>
              <div class="rv-comment" data-k="saved" data-off><b>批注</b>权重为 0 的条目也要跳过，别让它占着一段</div>
            </div>
          </div>
          <div class="rv-foot"><span data-k="drafts">草稿批注 0</span><span class="s-sp"></span><span class="rv-copied" data-k="copied" data-off>已复制</span><span class="s-btn ghost">复制注释</span><span class="s-btn pri" data-k="copyClose">复制并关闭</span></div>
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
      </section>
    </div>${S.capBox}</div>`,
    steps: [
      // 1 AI 带你到关键几行
      { hold: 300, do: [...cap("AI 直接带你到关键几行", "改完把文件放进查看包，标好重点和一句说明"), ["wait", 400], ["show", "tool"]] },
      { hold: 1500, do: [["show", "rv"], ["on", "rv", "pop"]] },
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
      { hold: 1600, do: [["click", "padCopy"], ["hide", "pad"], ["show", "toast"], ...cap("便签：快捷键呼出，边看边记", "Ctrl+Enter 复制这一页并隐藏，贴回给 AI")] },
    ],
  });
})();
