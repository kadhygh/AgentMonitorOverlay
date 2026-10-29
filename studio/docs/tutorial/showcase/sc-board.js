// 展示第 1 屏：看板上三个任务各开一个会话，同时在跑，状态在变；停下的自己挪到「待审阅」
// （host TasksFeature.watchColumns）。任务名和模型只是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const P = T.parts;
  const card = (k, title, model, word, tone, hidden = false) => `
    <div class="s-card" data-k="${k}"${hidden ? " data-off" : ""}><div class="s-card-where">未归专题 › MyGame</div><b>${title}</b>
      <div class="s-card-st"><span class="s-dot ${tone}" data-k="${k}-dot"></span><span data-k="${k}-st">${word}</span><span class="s-sp"></span><span class="sc-model">${model}</span></div></div>`;
  // "todo s-hide-narrow": the column's id, then classes (手机宽度只留 进行中 和 待审阅).
  const col = (id, name, n, cards) => {
    const [key, ...cls] = id.split(" ");
    return `<div class="s-col ${cls.join(" ")}"><div class="s-col-head">${name}<span class="n" data-k="n-${key}">${n}</span></div>${cards}</div>`;
  };
  T.scene({
    id: "sc-board",
    title: "看板上几个会话同时在跑",
    height: 400,
    narrowHeight: 470,
    poster: 0,
    ui: ["运行中", "待批准", "空闲"],
    html: P.studio({
      nav: P.nav({ projects: [["MyGame", 3]], all: 3 }),
      scope: "MyGame",
      main: `<div class="s-board sc-board">
        ${col("todo s-hide-narrow", "待办", 0, '<div class="s-col-empty">空</div>')}
        ${col("doing", "进行中", 3, card("a", "掉落表校验报错", "Claude", "运行中", "run") + card("b", "写打表工具", "Codex", "运行中", "run") + card("c", "查资源加载的资料", "DeepSeek", "运行中", "run"))}
        ${col("review", "待审阅", 0, card("a2", "掉落表校验报错", "Claude", "空闲", "", true) + card("c2", "查资源加载的资料", "DeepSeek", "空闲", "", true) + '<div class="s-col-empty" data-k="emptyReview">空</div>')}
        ${col("done s-hide-narrow", "完成", 0, '<div class="s-col-empty">空</div>')}
      </div>`,
    }),
    steps: [
      { hold: 1000, do: [["text", "b-st", "待批准"], ["off", "b-dot", "run"], ["on", "b-dot", "att"], ["on", "b-st", "s-att"], ["show", "needs"]] },
      { hold: 900, do: [["text", "b-st", "运行中"], ["off", "b-dot", "att"], ["on", "b-dot", "run"], ["off", "b-st", "s-att"], ["hide", "needs"], ["text", "a-st", "空闲"], ["off", "a-dot", "run"]] },
      { hold: 900, do: [["hide", "a"], ["hide", "emptyReview"], ["show", "a2"], ["text", "n-doing", "2"], ["text", "n-review", "1"]] },
      { hold: 400, do: [["text", "c-st", "空闲"], ["off", "c-dot", "run"]] },
      { hold: 1200, do: [["hide", "c"], ["show", "c2"], ["text", "n-doing", "1"], ["text", "n-review", "2"]] },
    ],
  });
})();
