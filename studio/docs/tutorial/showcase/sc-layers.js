// 展示第 3 屏：专题 → 任务 → 会话 三层逐级展开（protocol/src/entities.ts 的 Topic / Task / Session：
// 专题可以跨项目，任务属于一个项目，一个任务有几段会话、分支和子会话）。名字只是示意。
(function () {
  const T = globalThis.AMO_TUTORIAL;
  const node = (k, name, sub, cls = "") => `<div class="sc-node ${cls}" data-k="${k}" data-off><b>${name}</b><span>${sub}</span></div>`;
  T.scene({
    id: "sc-layers",
    title: "专题、任务、会话三层",
    height: 400,
    narrowHeight: 460,
    ui: ["专题", "任务", "会话", "分支", "子会话", "公共目录"],
    html: `<div class="sc-layers">
      <div class="sc-col"><span class="lab">专题</span>${node("topic", "3.2 版本", "一组相关的任务", "topic")}</div>
      <div class="sc-col tasks" data-k="tasks" style="--t:42px;--b:30px"><span class="lab">任务</span>
        ${node("t1", "掉落表重构", '<span class="sc-tag">client</span>')}
        ${node("t2", "结算改版", '<span class="sc-tag">server</span>')}
        ${node("t3", "发版说明", '<span class="sc-tag">公共目录</span>')}
      </div>
      <div class="sc-col sessions" data-k="sessions" style="--t:42px;--b:30px"><span class="lab">会话</span>
        ${node("s1", "Claude · 主会话", "改掉落逻辑")}
        ${node("s2", "分支 · 换 Codex 再试", "同一个问题另一种写法")}
        ${node("s3", "子会话", "查哪些配表引用了它")}
      </div>
    </div>`,
    steps: [
      { hold: 500, do: [["show", "topic"]] },
      { hold: 220, do: [["show", "t1"], ["on", "tasks", "lit"]] },
      { hold: 220, do: [["show", "t2"]] },
      { hold: 600, do: [["show", "t3"]] },
      { hold: 300, do: [["on", "t1", "on"]] },
      { hold: 220, do: [["show", "s1"], ["on", "sessions", "lit"]] },
      { hold: 220, do: [["show", "s2"]] },
      { hold: 1800, do: [["show", "s3"]] },
    ],
  });
})();
