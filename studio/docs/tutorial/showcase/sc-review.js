// 展示第 5 屏：AI 改完代码调 review_open，把人带到那个文件的那几行（一个文件放进查看包，AI 标的「重点」行着色、
// 带一句说明）；人点 + 写一条批注，「复制并关闭」，粘回对话（host gitreview/mcp.ts、ui/src/viewpacks/、
// gitreview/comments.tsx）。代码和批注只是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const P = T.parts;
  const line = (no, kind, code, extra = "") => `<div class="g-line ${kind}"><span class="no">${no}</span><span>${extra}</span><span>${kind.includes("add") ? "+ " : "  "}${code}</span></div>`;
  T.scene({
    id: "sc-review",
    title: "AI 把你带到要看的那几行",
    height: 420,
    narrowHeight: 470,
    poster: 3,
    loopGap: 1100,
    ui: ["查看包", "重点", "工具调用", "编辑", "保存", "草稿批注", "复制注释", "复制并关闭", "已复制"],
    html: P.studio({
      nav: P.nav({ projects: [["MyGame", 1]], all: 1 }),
      scope: "MyGame",
      main: `<div class="s-task">${P.taskHead()}
        <div class="s-thread" style="justify-content:flex-end">
          <div class="s-user">${P.ask}</div>
          <div class="s-pr ok">编辑 · <span class="code">importer/fetch.py</span></div>
          <div class="s-pr" data-k="call" data-off>工具调用 · <span class="code">review_open · importer/fetch.py:20–24</span></div>
          <div class="s-agent" data-k="say" data-off>重试在第 20–24 行，帮我看一下间隔。</div>
          <div class="s-user" data-k="sent" data-off><span class="s-mono">importer/fetch.py:24</span> 改成 1 秒，每次翻倍</div>
        </div>
        ${P.composer()}</div>
        <div class="s-win float" data-k="win" data-off>
          <div class="s-titlebar"><span class="s-logo"></span><span class="s-title">importer/fetch.py · 查看包</span><span class="s-sp"></span><span class="s-wbtn">─ ☐ ✕</span></div>
          <div class="g-head"><span class="s-faint">重点</span><span class="g-seg"><span class="sel">第 20–24 行 · 重试</span></span></div>
          <div class="g-diff" style="flex:1">
            ${line(19, "", "def fetch(url):")}
            ${line(20, "add hl", "for attempt in range(3):")}
            ${line(21, "add hl", "    try:")}
            ${line(22, "add hl", "        return session.get(url)")}
            ${line(23, "add hl", "    except ConnectionError:")}
            ${line(24, "add hl", "        time.sleep(0.1)", '<span class="g-plus" data-k="plus">+</span>')}
            <div class="g-note sc-mark">重试：最多 3 次，间隔先写了 0.1 秒</div>
            <div class="g-note" data-k="edit" data-off><span class="s-field" data-k="text" data-ph="对这一行的意见或问题（Ctrl+Enter 保存）"></span>
              <span class="s-row" style="margin-top:5px;justify-content:flex-end"><span class="s-btn pri" data-k="save">保存</span></span></div>
            <div class="g-note" data-k="note" data-off>改成 1 秒，每次翻倍</div>
          </div>
          <div class="g-foot"><span data-k="count">草稿批注 0 条</span><span class="s-sp"></span><span class="s-btn ghost g-hide-narrow">复制注释</span><span class="s-btn pri" data-k="copy">复制并关闭</span></div>
        </div>
        <div class="s-toast" data-k="toast" data-off>已复制 1 条批注，可以粘贴给需要的对话或工具。</div>`,
    }),
    steps: [
      { hold: 300, do: [["show", "call"], ["show", "say"]] },
      { hold: 500, do: [["show", "win"]] },
      { hold: 100, do: [["click", "plus"], ["show", "edit"], ["type", "text", "改成 1 秒，每次翻倍"]] },
      { hold: 500, do: [["click", "save"], ["hide", "edit"], ["show", "note"], ["text", "count", "草稿批注 1 条"]] },
      { hold: 400, do: [["click", "copy"], ["hide", "win"], ["show", "toast"]] },
      { hold: 1000, do: [["hide", "toast"], ["show", "sent"]] },
    ],
  });
})();
