// 第 1 章第 4 步：对话里的审批卡片（chat/Transcript.tsx 的 ApprovalCard，批过以后是 ProcessRows.tsx 的一行），
// 顶栏的「需要你」，任务在 进行中 → 待审阅 之间自己挪（host 的 TasksFeature.watchColumns）。命令和回复只是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const P = T.parts;
  const ask = P.ask;
  const cmd = "python -m pytest tests/test_fetch.py";
  T.scene({
    id: "studio-approve",
    title: "在对话里批准命令",
    height: 380,
    narrowHeight: 420,
    ui: ["已思考", "读取", "编辑", "请求执行命令", "等待你的确认", "批准", "拒绝", "已批准", "运行命令", "待审阅"],
    html: P.studio({
      nav: P.nav({ projects: [["MyGame", 1]], all: 1 }),
      scope: "MyGame",
      main: `<div class="s-task">${P.taskHead()}
        <div class="s-thread" style="justify-content:flex-end">
          <div class="s-user">${ask}</div>
          <div class="s-pr" data-k="pr0" data-off>已思考</div>
          <div class="s-pr" data-k="pr1" data-off>读取 · <span class="code">importer/fetch.py</span></div>
          <div class="s-pr" data-k="pr2" data-off>编辑 · <span class="code">importer/fetch.py</span></div>
          <div class="s-approval" data-k="approval" data-off>
            <div class="s-approval-head">▣ 请求执行命令<span class="w">等待你的确认</span></div>
            <code>${cmd}</code>
            <span class="s-row"><span class="s-btn att" data-k="accept">批准</span><span class="s-btn att-o">拒绝</span></span>
          </div>
          <div class="s-pr ok" data-k="done" data-off>已批准执行命令 · <span class="code">${cmd}</span></div>
          <div class="s-pr" data-k="run" data-off>运行命令 · <span class="code">${cmd}</span></div>
          <div class="s-agent" data-k="reply" data-off>改好了：<code class="s-mono">fetch()</code> 遇到网络错误时最多重试 3 次，每次之间等 0.1 秒。新加的测试都通过了。</div>
        </div>
        ${P.composer()}</div>`,
    }),
    steps: [
      { say: "会话开始后，AI 想了什么、读了哪些文件、改了什么，都一行一行列在对话里。", do: [["show", "pr0"], ["wait", 350], ["show", "pr1"], ["wait", 350], ["show", "pr2"]] },
      { say: "AI 要跑命令时，对话里出现 [[请求执行命令]] 卡片，写着 [[等待你的确认]]；顶栏亮起 [[需要你]]。", do: [["show", "approval"], ["show", "needs"], ["hl", "needs"], ["wait", 600], ["unhl", "needs"], ["hl", "approval"]] },
      { say: "看清是什么命令，点 [[批准]]。不想让它跑就点 [[拒绝]]。", do: [["unhl", "approval"], ["click", "accept"], ["hide", "approval"], ["show", "done"], ["hide", "needs"], ["wait", 300], ["show", "run"]] },
      { say: "命令跑完，AI 接着干，最后写一段回复。回复写完，这段会话就停下来等你。", do: [["show", "reply"]] },
      { say: "没有会话在跑了，几秒后任务自己从 [[进行中]] 换到 [[待审阅]]：轮到你看结果。", do: [["wait", 500], ["text", "statusText", "待审阅"], ["off", "statusDot", "run"], ["on", "statusDot", "att"], ["hl", "status"], ["move", "status"]] },
    ],
  });
})();
