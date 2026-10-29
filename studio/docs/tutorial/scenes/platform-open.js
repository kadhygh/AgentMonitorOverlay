// 第 1 章第 2 步：没设 Studio 数据目录时点「打开」会被带到「目录」页（PlatformApp.tsx 的 needStudioDir、DirsPage；
// 提示的原话在 platform/src/launch.ts）。路径只是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const P = T.parts;
  const page = `
    <div data-k="tools">
      <div class="p-h1">工具</div>
      <div class="p-hint">团队服务器上稳定通道里的工具，各自安装、各自更新。</div>
      <div class="p-card">
        <div class="p-card-head"><span class="p-mark">S</span>
          <div><div class="p-name">AMO Studio</div><div class="p-status s-ok">✓ 0.9.10 · 已是最新</div>
            <div class="p-hint" data-k="hostLine" data-off>✓ 后台在运行 · 没有会话在跑</div></div>
          <span class="p-actions"><span class="s-btn" data-k="open">打开</span><span class="s-btn">⋯</span></span></div>
      </div>
    </div>
    <div data-k="dirs" data-off>
      <div class="p-h1">目录</div>
      <div class="p-hint s-hide-narrow">改了以后，下次打开对应的工具时生效。</div>
      <div class="p-card" data-k="dirCard">
        <div class="p-alert" data-k="alert">! 先设好 Studio 数据目录，再打开 Studio。</div>
        <div class="s-row"><span class="p-name">Studio 数据目录</span><span class="s-sp"></span>
          <span class="s-btn" data-k="pick">选择文件夹…</span><span class="s-link" data-k="openDir" data-off>打开</span></div>
        <span class="p-path unset" data-k="path">还没设</span>
        <div class="p-hint" style="margin-top:6px">会话、项目、设置都存在这里，升级不会碰它。选你现在用的数据目录（源码启动时是 studio\\.data），就能接着用原来的会话和项目。</div>
      </div>
    </div>`;
  T.scene({
    id: "platform-open",
    title: "设 Studio 数据目录，打开 Studio",
    height: 330,
    narrowHeight: 400,
    ui: ["先设好 Studio 数据目录，再打开 Studio。", "Studio 数据目录", "选择文件夹…", "更改…", "还没设", "后台在运行", "没有会话在跑"],
    html: P.platform({ page }),
    steps: [
      { say: "装好后在 Studio 的卡片上点 [[打开]]。", do: [["click", "open"]] },
      { say: "第一次打开会被带到 [[目录]] 页：Studio 还没有数据目录，提示 [[先设好 Studio 数据目录，再打开 Studio。]]", do: [["off", "nav-tools", "cur"], ["on", "nav-dirs", "cur"], ["hide", "tools"], ["show", "dirs"], ["hl", "alert"]] },
      { say: "点 [[选择文件夹…]]，选一个放 Studio 数据的文件夹。以前从源码用过 Studio 的，选原来的 `studio\\.data`。", do: [["unhl", "alert"], ["click", "pick"], ["wait", 500], ["hide", "alert"], ["off", "path", "unset"], ["text", "path", "D:\\AMO\\studio-data"], ["text", "pick", "更改…"], ["show", "openDir"]] },
      { say: "回到 [[工具]] 页，再点一次 [[打开]]，Studio 的窗口就出来了。卡片下面会写后台（Host）在不在运行、有几个会话在跑。", do: [["click", "nav-tools"], ["off", "nav-dirs", "cur"], ["on", "nav-tools", "cur"], ["hide", "dirs"], ["show", "tools"], ["click", "open"], ["show", "hostLine"]] },
    ],
  });
})();
