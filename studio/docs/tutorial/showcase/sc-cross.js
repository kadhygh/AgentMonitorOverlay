// 展示第 ④ 屏：测试中 · 中转 + 远程，着重讲远程的安全（2026-10-30 用户）。翻页，四章：
//   1 中转：策划的 AI 拿不准，用 relay_session_open 问程序；程序在中转客户端里「回复并返回给 … 的 AI」；AI 用
//     relay_session_wait 拿到回复接着改（packages/relay/src/mcp.ts、relay-ui）
//   2 远程配对：笔记本上「配对一台设备」列出同账号在线的设备，发起配对；台式机「收到的配对请求」里允许（remote/PairDialog）
//   3 授权一个任务：台式机上 授权给… 笔记本；笔记本看板上出现它，「在 台式机 上运行」（task/GrantDialog.tsx 的提醒原话）。
//     然后一页两边同步干活（11-05 用户：授权后要演一段同步干活的界面）：笔记本上发话，两边同时出现；AI 要跑命令，
//     笔记本上批准，命令在台式机上跑，结果和回复两边都看得到
//   4 安全：远程设置里同账号「直接开跑」、别的账号「先等我确认」（默认，protocol remote.ts DEFAULT_REMOTE_SECURITY）；
//     别的账号建任务先在 Focus 等你「同意并开始」；授权随时「收回」
// 11-04：远程也有了手机端（studio/mobile，Android 版测试中），页面上的说法从「电脑」改成「设备」，画出来的界面文字照旧
// （远程设置里写的还是「你自己的其他电脑」）。
// 只播一遍。人名、设备名、对话内容是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const S = T.studioParts;
  const { flip, cap } = S;
  const win = (k, title, sub, body, extra = "") => `<div class="cx-win ${extra}" data-k="${k}"><div class="cx-bar"><span class="iw-logo small"></span><b>${title}</b><span class="s-faint">${sub}</span></div><div class="cx-body">${body}</div></div>`;

  T.uses("AMO 中转", "工具调用", "回复并返回给", "已返回给", "远程", "配对一台设备", "收到的配对请求", "已配对的设备", "授权给别的设备的", "在别的设备上跑的", "收回", "远程设置", "同账号的设备", "别的账号的设备", "直接开跑", "先等我确认", "同意并开始", "请求执行命令", "等待你的确认", "批准", "上运行");
  T.scene({
    id: "sc-cross",
    title: "测试中：中转和远程",
    height: 660,
    narrowHeight: 230,
    once: true,
    world: [1280, 800],
    chapters: [
      [0, "中转：AI 卡住了直接问人", "tutorial.html#ch8"],
      [3, "远程：只配对你自己的设备", "tutorial.html#ch9-pair"],
      [5, "授权一个任务，换台设备接着用", "tutorial.html#ch9-grant"],
      [10, "! 安全：别的账号先等你同意，随时收回", "tutorial.html#ch9-safety"],
    ],
    html: `<div class="ic-cam"><div class="pgs">
      <section class="pg pg-two cur" data-k="p0">
        ${win(
          "wA",
          "小王 · 策划",
          "AMO Studio · 掉落配表",
          `<div class="tk-user">把 3.2 的掉落配表按新规则改一遍</div>
           <p>配表里的 <code>drop_rate</code> 程序是当百分比读还是小数？我拿不准，去问一下负责的程序。</p>
           <div class="ch-tool" data-k="ask" data-off><span class="ch-tn">工具调用</span><code>relay_session_open</code><span class="s-faint">发给 老李</span></div>
           <div class="ch-tool" data-k="wait" data-off><span class="ch-tn">工具调用</span><code>relay_session_wait</code><span class="s-faint" data-k="waitSt">等回复…</span></div>
           <p data-k="go" data-off>老李说是小数（0 到 1）。按小数改好了 12 行，校验通过。</p>`,
        )}
        <div class="cx-wire"><span class="lab">AMO 中转</span><i class="cx-dot" data-k="dot1"></i><i class="cx-dot back" data-k="dot2"></i></div>
        ${win(
          "wB",
          "老李 · 程序",
          "AMO 中转",
          `<div class="cx-ask" data-k="q" data-off><span class="s-faint">小王 的 AI 问</span><b>配表的 drop_rate 是百分比还是小数？</b>
             <div class="cx-input" data-k="reply"></div>
             <div class="cx-acts"><span class="s-btn pri" data-k="send">回复并返回给 小王 的 AI</span></div>
             <div class="cx-ok" data-k="sent" data-off>✓ 已返回给 小王 的 AI</div></div>`,
        )}
      </section>

      <section class="pg pg-two" data-k="p1">
        ${win(
          "nb",
          "笔记本",
          "AMO Studio · 远程",
          `<div class="cx-h">配对一台设备</div><p class="s-faint">同一个账号、现在在线的设备：</p>
           <div class="cx-dev"><b>台式机</b><span class="s-faint">在线</span><span class="s-sp"></span><span class="s-btn pri" data-k="pair">发起配对</span></div>
           <div class="cx-note" data-k="pairWait" data-off>等 台式机 允许…</div>
           <div class="cx-ok" data-k="paired1" data-off>✓ 已配对：台式机</div>`,
        )}
        <div class="cx-wire lan"><span class="lab">局域网</span><i class="cx-dot" data-k="dot3"></i></div>
        ${win(
          "dt",
          "台式机",
          "AMO Studio · 远程",
          `<div class="cx-h">收到的配对请求</div>
           <div class="cx-dev" data-k="req" data-off><b>笔记本</b><span class="s-faint">同一个账号</span><span class="s-sp"></span><span class="s-btn ghost">拒绝</span><span class="s-btn pri" data-k="allow">允许</span></div>
           <div class="cx-h" style="margin-top:22px">已配对的设备</div><div class="cx-dev" data-k="paired2" data-off><b>笔记本</b><span class="s-faint">刚刚</span></div>`,
        )}
      </section>

      <section class="pg pg-two" data-k="p2">
        ${win(
          "dt2",
          "台式机",
          "AMO Studio · 任务「掉落表改版」",
          `<div class="cx-h">把「掉落表改版」授权给…</div>
           <div class="cx-dev"><b>笔记本</b><span class="s-sp"></span><span class="s-btn pri" data-k="grant">授权</span></div>
           <ul class="cx-warn"><li>会话还在这台电脑上跑：命令以这台电脑上你的用户身份运行，用的是这台电脑的模型账号。只授权给你自己的其他设备。</li></ul>`,
        )}
        <div class="cx-wire lan"><span class="lab">局域网</span><i class="cx-dot" data-k="dot4"></i></div>
        ${win(
          "nb2",
          "笔记本",
          "AMO Studio · 看板",
          `<div class="cx-card" data-k="gcard" data-off><span class="cx-badge">远程</span><b>掉落表改版</b><span class="s-faint">在 台式机 上运行</span></div>`,
        )}
      </section>

      <section class="pg pg-two" data-k="p2b">
        ${win(
          "dt3",
          "台式机",
          "任务「掉落表改版」· 运行中",
          `<div class="tk-user" data-k="dMsg" data-off><span class="s-faint">来自 笔记本</span><br>再跑一遍掉落的测试，顺便核一下 Boss_03</div>
           <p data-k="dAi1" data-off>好，先跑一遍掉落的测试。</p>
           <div class="cx-pend" data-k="dWait" data-off>请求执行命令 · 等 笔记本 确认</div>
           <div class="cx-run" data-k="dRun" data-off>▸ 运行命令 · <code>python -m pytest tests/test_drop.py</code><span class="s-faint"> · 在这台电脑上</span><div class="cx-out">6 passed in 1.42s</div></div>
           <p data-k="dAi2" data-off>6 个都过了。Boss_03 的权重也核了：紫装 4.6%，和表里一致。</p>`,
        )}
        <div class="cx-wire lan"><span class="lab">同步</span><i class="cx-dot back" data-k="dot5"></i><i class="cx-dot" data-k="dot6"></i></div>
        ${win(
          "nb3",
          "笔记本",
          "任务「掉落表改版」",
          `<div class="cx-rb"><span class="cx-badge">远程</span>在 台式机 上运行</div>
           <div class="tk-user" data-k="nbMsg" data-off>再跑一遍掉落的测试，顺便核一下 Boss_03</div>
           <p data-k="nbAi1" data-off>好，先跑一遍掉落的测试。</p>
           <div class="cx-appr" data-k="nbAppr" data-off><div><b>请求执行命令</b><span class="cx-w">等待你的确认</span></div><code>python -m pytest tests/test_drop.py</code><span class="s-btn att" data-k="nbOk">批准</span></div>
           <div class="cx-run" data-k="nbRun" data-off>▸ 运行命令 · <code>python -m pytest tests/test_drop.py</code><span class="s-faint"> · 在 台式机 上</span><div class="cx-out">6 passed in 1.42s</div></div>
           <p data-k="nbAi2" data-off>6 个都过了。Boss_03 的权重也核了：紫装 4.6%，和表里一致。</p>
           <div class="cx-in" data-k="nbIn"></div>`,
        )}
      </section>

      <section class="pg pg-safe" data-k="p3">
        <div class="cx-win sf">
          <div class="cx-bar"><span class="iw-logo small"></span><b>远程设置</b><span class="s-faint">台式机</span></div>
          <div class="cx-body">
            <div class="cx-h">安全：别的设备在这台电脑上建的任务</div>
            <div class="sf-row"><span><b>同账号的设备</b><span class="s-faint">你自己的其他电脑</span></span><span class="sf-sel">直接开跑（默认）</span></div>
            <div class="sf-row hl" data-k="other"><span><b>别的账号的设备</b><span class="s-faint">用其他账号登录的</span></span><span class="sf-sel">先等我确认（默认）</span></div>
            <p class="sf-red">! 别的账号的设备建的任务会直接用这台电脑的模型账号跑，命令以你的身份运行。Claude、ChatGPT 的个人订阅不能给别人用。</p>
            <div class="cx-h" style="margin-top:18px">授权给别的设备的</div>
            <div class="cx-dev" data-k="grantRow"><b>掉落表改版</b><span class="s-faint">→ 笔记本</span><span class="s-sp"></span><span class="s-btn ghost danger" data-k="revoke">收回</span></div>
            <div class="cx-ok" data-k="revoked" data-off>✓ 已收回：笔记本 不能再操作这个任务</div>
          </div>
        </div>
        <div class="fw sf-focus" data-k="fq" data-off>
          <div class="fw-head"><span class="iw-logo small"></span><b>Focus</b><span class="s-sp"></span><span class="fw-sum">1 件事要你处理</span></div>
          <div class="fw-row att open"><div class="fw-line"><span class="fw-w">! 请求</span><span class="fw-text"><b>测试账号的设备想在这台电脑上建任务</b><span class="fw-sub">项目 MyGame · Claude Opus 5.5 · 「整理一下日志」</span></span></div>
            <div class="fw-detail"><div class="fw-acts"><span class="s-btn att" data-k="agree">同意并开始</span><span class="s-btn ghost">拒绝</span></div></div></div>
        </div>
      </section>
    </div>${S.capBox}</div>`,
    steps: [
      // 1 中转
      { hold: 300, do: [...cap("中转：AI 卡住了直接问人", "策划的 AI 拿不准的事，发给负责的程序"), ["wait", 300], ["show", "ask"], ["on", "dot1", "go"], ["wait", 650], ["show", "q"]] },
      { hold: 200, do: [["type", "reply", "小数，0 到 1"], ["click", "send"], ["show", "sent"], ["on", "dot2", "go"], ["show", "wait"]] },
      { hold: 1500, do: [["wait", 600], ["text", "waitSt", "收到 老李 的回复"], ["show", "go"], ...cap("中转：AI 卡住了直接问人", "人回一句，AI 自己接着做，不用你在中间传话")] },
      // 2 配对
      { hold: 300, do: [["hide", "cap"], ...flip("p0", "p1"), ["wait", 550], ...cap("远程：只配对你自己的设备", "同一个账号、同一个局域网里的电脑，手机也行")] },
      { hold: 1400, do: [["click", "pair"], ["show", "pairWait"], ["on", "dot3", "go"], ["wait", 650], ["show", "req"], ["click", "allow"], ["hide", "req"], ["show", "paired2"], ["hide", "pairWait"], ["show", "paired1"]] },
      // 3 授权一个任务
      { hold: 2400, do: [["hide", "cap"], ...flip("p1", "p2"), ["wait", 550], ...cap("授权一个任务，换台设备接着用", "笔记本、手机都行；会话还在原来那台跑，命令和模型账号都是那台的"), ["click", "grant"], ["on", "dot4", "go"], ["wait", 650], ["show", "gcard"]] },
      // 两边同步干活
      { hold: 900, do: [["hide", "cap"], ...flip("p2", "p2b"), ["wait", 550], ...cap("两边同步：笔记本上发话，台式机上跑", "对话、批准、结果，两边同时看得到"), ["type", "nbIn", "再跑一遍掉落的测试，顺便核一下 Boss_03"], ["wait", 250], ["text", "nbIn", ""], ["show", "nbMsg"], ["on", "dot5", "go"], ["wait", 650], ["show", "dMsg"]] },
      { hold: 1600, do: [["show", "dAi1"], ["show", "nbAi1"], ["wait", 700], ["show", "dWait"], ["show", "nbAppr"]] },
      { hold: 2400, do: [...cap("在笔记本上批准，命令在台式机上跑", "以台式机上你的身份运行，用台式机的模型账号"), ["click", "nbOk"], ["hide", "nbAppr"], ["off", "dot5", "go"], ["wait", 30], ["on", "dot5", "go"], ["wait", 650], ["hide", "dWait"], ["show", "dRun"], ["wait", 900], ["on", "dot6", "go"], ["wait", 650], ["show", "nbRun"]] },
      { hold: 2800, do: [["show", "dAi2"], ["wait", 400], ["show", "nbAi2"]] },
      // 4 安全
      { hold: 900, do: [["hide", "cap"], ...flip("p2b", "p3"), ["wait", 550], ...cap("! 安全：别的账号先等你同意", "只在局域网里用，只配对你自己的设备"), ["on", "cap", "warn"]] },
      { hold: 300, do: [["show", "fq"], ["wait", 900], ["click", "agree"], ["hide", "fq"]] },
      { hold: 1800, do: [...cap("! 安全：授权随时收回", "收回后那边只剩已经同步的记录，不能再操作"), ["on", "cap", "warn"], ["click", "revoke"], ["hide", "grantRow"], ["show", "revoked"]] },
    ],
  });
})();
