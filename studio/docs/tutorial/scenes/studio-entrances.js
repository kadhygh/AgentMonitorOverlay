// 第 0 章：主窗口上各个窗口和页面的入口（shell/TopBar.tsx 的顶栏和 ViewBar，board/ScopeNav.tsx 的左栏）。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const P = T.parts;
  const card = P.card;
  T.scene({
    id: "studio-entrances",
    title: "主窗口上的入口",
    height: 330,
    narrowHeight: 330,
    intro: "Studio 主窗口：上面一行是顶栏，下面一行是页签和「+ 新任务」，左边是左栏。",
    html: P.studio({
      needs: true,
      withNav: true,
      nav: P.nav({ projects: [["MyGame", 2]], all: 2 }),
      main: P.board({
        doing: [card({ k: "c1", where: "未归专题 › MyGame", title: "给导入器加失败重试", status: "待批准", tone: "att" })],
        review: [card({ k: "c2", where: "未归专题 › MyGame", title: "整理掉落表命名", status: "空闲" })],
      }),
    }),
    steps: [
      { say: "右上角的 [[+ 新任务]]：写一句话开始一件新的事。在任何页面按 `Ctrl+N` 是一行的快速启动条，作用一样。", do: [["hl", "newBtn"], ["move", "newBtn"]] },
      { say: "[[看板]] 和 [[画布]] 两个页签：看板是四列任务卡片；画布是一个专题的全局图。", do: [["unhl", "newBtn"], ["hl", "tabBoard"], ["hl", "tabCanvas"], ["move", "tabCanvas"]] },
      { say: "顶栏的 [[书签]]：打开书签窗口，里面是按专题收着的文件和对话片段（`Ctrl+Shift+M`）。", do: [["unhl", "tabBoard"], ["unhl", "tabCanvas"], ["hl", "tbMarks"], ["move", "tbMarks"]] },
      { say: "[[远程]]：打开远程对话框，在你自己的另一台电脑上接着用这台的会话。只在局域网里、自己的设备之间用。", do: [["unhl", "tbMarks"], ["hl", "tbRemote"], ["move", "tbRemote"]] },
      { say: "[[便签]]：打开便签。它是单独的小程序，平时用它的全局快捷键更快。", do: [["unhl", "tbRemote"], ["hl", "tbNotes"], ["move", "tbNotes"]] },
      { say: "[[Focus]]：点一下，桌面角落出现 Focus 小窗，只列需要你处理的会话；再点一下关上。", do: [["unhl", "tbNotes"], ["click", "tbFocus"], ["on", "tbFocus", "on"], ["hl", "tbFocus"]] },
      { say: "[[需要你]]：有会话在等你批准或回答时才出现，带着数量；点它回到看板，等你的卡片写着「待批准」。", do: [["unhl", "tbFocus"], ["hl", "needs"], ["move", "needs"], ["hl", "c1"]] },
      { say: "左栏：[[全部任务]]，然后是 [[专题]] 和 [[项目]] 两段（各自的 `+` 新建）；左下角 [[设置]] 里有模型、额度、便签、功能等。窄窗口时左栏可以收起。", do: [["unhl", "needs"], ["unhl", "c1"], ["hl", "navProjects"], ["hl", "settings"], ["move", "settings"]] },
    ],
  });
})();
