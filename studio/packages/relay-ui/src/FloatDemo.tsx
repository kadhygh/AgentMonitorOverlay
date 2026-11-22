import { FloatArea, FloatTabs, FloatWindow, useFloats } from "./Floats.js";

// Sample floating windows on the 协作 page (features.ts floatDemo, for the layout e2e) until step 3 puts the real 子会话
// and 白板 there. Each has a box to type in, to show a folded window keeps what was typed.

const SAMPLES = [
  { id: "demo:s1", title: "子会话：射速曲线", status: "进行中" },
  { id: "demo:s2", title: "子会话：枪管过热的颜色", status: "等你回复" },
  { id: "demo:board", title: "白板", status: "3 张卡" },
];

function Buttons() {
  const f = useFloats();
  return (
    <div className="float-demo-buttons">
      {SAMPLES.map((s) => (
        <button key={s.id} type="button" onClick={() => f.open(s)}>
          打开「{s.title}」
        </button>
      ))}
    </div>
  );
}

export function FloatDemo() {
  return (
    <FloatArea className="float-demo">
      <div className="placeholder">
        <h2>弹窗示例</h2>
        <p>协作里的子会话和白板会这样浮在页面上：拖标题栏移动、拖右下角改大小、点一下到最前、双击标题栏最大化，收起后在下面成一排标签。</p>
      </div>
      <div className="float-demo-dock">
        <Buttons />
        <FloatTabs />
        <div className="dock composer">
          <textarea rows={2} placeholder="群聊的输入框" />
        </div>
      </div>
      {SAMPLES.map((s) => (
        <FloatWindow key={s.id} id={s.id}>
          <div className="float-demo-body">
            <p>{s.title} 的内容。</p>
            <textarea rows={3} placeholder="在这里写的字，收起再展开还在" aria-label={`${s.title} 的输入框`} />
          </div>
        </FloatWindow>
      ))}
    </FloatArea>
  );
}
