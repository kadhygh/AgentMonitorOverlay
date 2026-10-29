// 第 1 章第 1 步：登录平台，装 Studio（platform/PlatformApp.tsx 的 LoginPage、ToolsPage、ToolRow）。
// 版本号和下载量只是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const P = T.parts;
  const tools = `
    <div class="p-h1">工具</div>
    <div class="p-hint">团队服务器上稳定通道里的工具，各自安装、各自更新。</div>
    <div class="p-card" data-k="studioCard">
      <div class="p-card-head">
        <span class="p-mark">S</span>
        <div><div class="p-name">AMO Studio</div><div class="p-hint">工作台：看板、任务、和模型的会话。自带 AMO 便签和 Reviewer。</div>
          <div class="p-status" data-k="studioStatus">○ 没装 · 服务器上是 0.9.10</div></div>
        <span class="p-actions"><span class="s-btn" data-k="install">安装</span><span class="s-btn" data-k="open" data-off>打开</span><span class="s-btn" data-k="more" data-off>⋯</span></span>
      </div>
      <div class="p-progress" data-k="progress" data-off><div class="s-bar"><i data-k="fill"></i></div><span class="p-hint" data-k="progressText">正在读取清单…</span></div>
      <div class="p-result" data-k="result" data-off>✓ 已装好 0.9.10</div>
    </div>
    <div class="p-card">
      <div class="p-card-head"><span class="p-mark">中</span>
        <div><div class="p-name">AMO 中转</div><div class="p-status">○ 没装 · 服务器上是 0.9.4</div></div>
        <span class="p-actions"><span class="s-btn">安装</span></span></div>
    </div>`;
  T.scene({
    id: "platform-install",
    title: "登录平台，装上 Studio",
    height: 350,
    narrowHeight: 380,
    ui: ["登录 AMO 平台", "服务器地址", "名字", "密码", "登录", "没有账号？注册一个", "安装", "打开", "已装好", "已是最新", "没装", "正在下载", "AMO 中转", "工作台：看板、任务、和模型的会话。自带 AMO 便签和 Reviewer。"],
    html: `
      <div class="s-win" data-k="login">
        <div class="s-titlebar"><span class="s-logo"></span><span class="s-title">AMO 平台</span><span class="s-sp"></span><span class="s-wbtn">─ ✕</span></div>
        <div class="p-login"><div class="p-login-card">
          <div class="p-h1">登录 AMO 平台</div>
          <div class="p-hint">用团队服务器（AMO 中转）的账号登录。</div>
          <span class="s-label">服务器地址</span><span class="s-field" data-k="server" data-ph="例如 172.16.8.85:47120"></span>
          <span class="s-label">名字</span><span class="s-field" data-k="name"></span>
          <span class="s-label">密码</span><span class="s-field" data-k="pw"></span>
          <span class="s-btn pri" data-k="loginBtn">登录</span>
          <div style="text-align:center;margin-top:8px"><span class="s-link" data-k="register">没有账号？注册一个</span></div>
        </div></div>
      </div>
      <div data-k="main" data-off>${P.platform({ page: tools })}</div>`,
    steps: [
      { say: "打开 AMO 平台，先登录。[[服务器地址]] 填团队服务器的地址。", do: [["click", "server"], ["type", "server", "172.16.8.85:47120"]] },
      { say: "再填 [[名字]] 和 [[密码]]，点 [[登录]]。还没有账号就点下面的 [[没有账号？注册一个]]。", do: [["click", "name"], ["type", "name", "小王"], ["click", "pw"], ["type", "pw", "••••••"], ["click", "loginBtn"]] },
      { say: "登录后进到 [[工具]] 页：团队服务器上的工具，每个一张卡片，各自安装、各自更新。", do: [["hide", "login"], ["show", "main"], ["move", "studioCard", 0.3, 0.3]] },
      { say: "在 AMO Studio 那张卡片上点 [[安装]]。下面的进度条走到头就装好了。", do: [["click", "install"], ["show", "progress"], ["wait", 300], ["text", "progressText", "正在下载 · 41 MB / 118 MB"], ["on", "fill", "half"], ["wait", 1300]] },
      { say: "装好了：卡片上写着 [[已装好]]，状态是 [[已是最新]]，按钮变成 [[打开]]。", do: [["hide", "progress"], ["show", "result"], ["text", "studioStatus", "✓ 0.9.10 · 已是最新"], ["hide", "install"], ["show", "open"], ["show", "more"], ["hl", "open"], ["move", "open"]] },
    ],
  });
})();
