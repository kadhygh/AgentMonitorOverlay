// 第 1 章第 5 步：任务页的「Review」→ Git Review 窗口（gitreview/ReviewApp.tsx、ReviewHead.tsx、DiffView.tsx、
// comments.tsx 的 复制注释 / 复制并关闭），粘回对话，再用状态菜单（task/TaskHead.tsx 的 StatusMenu）标完成。
// 复制下来的文字照 protocol/src/gitreview.ts 的 composeGitReviewMessage；代码和批注只是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const P = T.parts;
  const line = (no, kind, code, plus = "") => `<div class="g-line ${kind}"><span class="no">${no}</span><span>${plus}</span><span>${kind === "add" ? "+ " : kind === "del" ? "− " : "  "}${code}</span></div>`;
  const review = `
    <div class="s-win float" data-k="gr" data-off>
      <div class="s-titlebar"><span class="s-logo"></span><span class="s-title">Git Review</span><b>MyGame</b><span class="s-mono s-faint">main</span><span class="s-sp"></span><span class="s-wbtn">─ ☐ ✕</span></div>
      <div class="g-head" data-k="grHead"><span class="g-seg"><span class="sel">工作区改动</span><span class="g-hide-narrow">本分支全部</span><span class="g-hide-narrow">已暂存</span></span>
        <span class="g-seg"><span class="sel">只看改动</span><span class="g-hide-narrow">完整文件</span></span><span class="g-seg g-hide-narrow"><span class="sel">单栏</span><span>左右对照</span></span></div>
      <div class="g-body">
        <div class="g-files"><div class="s-faint g-hide-narrow">2 个文件</div>
          <div class="g-file" data-k="f1"><span class="m">M</span><span class="fn">importer/fetch.py</span><span class="c">+5 −1</span></div>
          <div class="g-file"><span class="m" style="background:var(--running)">+</span><span class="fn">tests/test_fetch.py</span><span class="c">+31</span></div></div>
        <div class="g-diff">
          <div class="s-faint" style="padding:6px 10px;font-family:var(--font-ui)" data-k="pickHint">选择左侧的文件查看改动。</div>
          <div data-k="lines" data-off>
            ${line(19, "", "def fetch(url):")}
            ${line(20, "del", "return session.get(url, timeout=10)")}
            ${line(20, "add", "for attempt in range(3):")}
            ${line(21, "add", "    try:")}
            ${line(22, "add", "        return session.get(url, timeout=10)")}
            ${line(23, "add", "    except ConnectionError:")}
            ${line(24, "add", "        time.sleep(0.1)", '<span class="g-plus" data-k="plus">+</span>')}
            <div class="g-note" data-k="noteEdit" data-off><span class="s-field" data-k="noteText" data-ph="对这一行的意见或问题（Ctrl+Enter 保存）"></span>
              <span class="s-row" style="margin-top:5px;justify-content:flex-end"><span class="s-btn pri" data-k="save">保存</span><span class="s-btn ghost">取消</span></span></div>
            <div class="g-note" data-k="note" data-off><span data-k="noteShown"></span><span class="s-row s-faint" style="justify-content:flex-end;font-size:11px">编辑　删除</span></div>
            ${line(25, "add", "raise FetchError(url)")}
          </div>
        </div>
      </div>
      <div class="g-foot"><span data-k="draftCount">草稿批注 0 条</span><span class="s-sp"></span><span class="s-btn ghost" data-k="copy">复制注释</span><span class="s-btn pri" data-k="copyClose">复制并关闭</span></div>
    </div>`;
  const menu = `
    <div class="s-menu" data-k="menu" data-off style="left:12px;top:50px">
      <span><span class="s-dot"></span>待办<kbd>1</kbd></span><span><span class="s-dot run"></span>进行中<kbd>2</kbd></span>
      <span><span class="s-dot att"></span>待审阅<kbd>3</kbd></span><span data-k="menuDone"><span class="s-dot"></span>完成<kbd>4</kbd></span>
    </div>`;
  const note = "重试间隔太短，改成 1 秒，每次翻倍。";
  T.scene({
    id: "studio-review",
    title: "看改动，写批注，标完成",
    height: 430,
    narrowHeight: 500,
    ui: ["Git Review", "工作区改动", "本分支全部", "已暂存", "只看改动", "完整文件", "单栏", "左右对照", "个文件", "选择左侧的文件查看改动。", "对这一行的意见或问题（Ctrl+Enter 保存）", "保存", "取消", "编辑", "删除", "草稿批注", "复制注释", "复制并关闭", "已复制", "条批注，可以粘贴给需要的对话或工具。", "Git Review 批注：我看了"],
    html: P.studio({
      nav: P.nav({ projects: [["MyGame", 1]], all: 1 }),
      scope: "MyGame",
      main: `<div class="s-task">${P.taskHead({ status: "待审阅", tone: "att" })}
        <div class="s-thread" style="justify-content:flex-end">
          <div class="s-user">${P.ask}</div>
          <div class="s-agent">改好了：<code class="s-mono">fetch()</code> 遇到网络错误时最多重试 3 次，每次之间等 0.1 秒。新加的测试都通过了。</div>
          <div class="s-user" data-k="sent" data-off>Git Review 批注：我看了「MyGame」的改动，有 1 条批注。…</div>
        </div>
        ${P.composer()}</div>${menu}${review}
        <div class="s-toast" data-k="toast" data-off>已复制 1 条批注，可以粘贴给需要的对话或工具。</div>`,
    }),
    steps: [
      { say: "任务停在 [[待审阅]]。点任务页右上角的 [[Review]]，打开这个项目的 Git Review 窗口。", do: [["click", "review"], ["show", "gr"]] },
      { say: "上面选看哪些改动，默认是 [[工作区改动]]、[[只看改动]]。左边是改了的文件，点一个看它改了哪几行。", do: [["hl", "grHead"], ["wait", 700], ["unhl", "grHead"], ["click", "f1"], ["on", "f1", "cur"], ["hide", "pickHint"], ["show", "lines"]] },
      { say: "觉得哪一行不对，点那一行旁边的 `+`，写下批注，点 [[保存]]。可以写好几条，都先存成草稿。", do: [["click", "plus"], ["show", "noteEdit"], ["type", "noteText", note], ["click", "save"], ["hide", "noteEdit"], ["text", "noteShown", note], ["show", "note"], ["text", "draftCount", "草稿批注 1 条"], ["text", "copy", "复制注释（1）"]] },
      { say: "写完点 [[复制并关闭]]：批注连同文件、行号和那一行的内容一起复制下来，窗口关掉。", do: [["click", "copyClose"], ["hide", "gr"], ["show", "toast"]] },
      { say: "回到对话，在输入框里粘贴（`Ctrl+V`）、回车，AI 就照着批注改。会话又动起来，任务回到 [[进行中]]。", do: [["hide", "toast"], ["click", "input"], ["text", "input", `Git Review 批注：我看了「MyGame」的改动，有 1 条批注。\n\n### importer/fetch.py\n\nimporter/fetch.py:24\n> time.sleep(0.1)\n${note}`], ["click", "inputSend"], ["text", "input", ""], ["show", "sent"], ["text", "statusText", "进行中"], ["off", "statusDot", "att"], ["on", "statusDot", "run"]] },
      { say: "AI 改完、你也看过了：点标题下面的状态字，在菜单里选 [[完成]]（菜单开着时按 `4` 也行）。", do: [["click", "status"], ["show", "menu"], ["click", "menuDone"], ["hide", "menu"], ["text", "statusText", "完成"], ["off", "statusDot", "run"], ["hl", "status"]] },
    ],
  });
})();
