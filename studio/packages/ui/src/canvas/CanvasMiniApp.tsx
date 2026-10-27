import { useEffect, useState } from "react";
import { useHostState } from "../host/useHostState.js";
import { CanvasPage } from "./CanvasPage.js";
import { useWaitingQuestions } from "./useCallouts.js";

// 画布小窗 (2026-10-27, 画布审阅 stage 3): a topic's canvas in a small window that stays on top, so the person sees the
// questions and how a review goes while working elsewhere. The cards, their bubbles and the question window work as
// on the workbench's canvas; opening a task or a session goes to the workbench.

const topicOf = () => new URLSearchParams(location.hash.split("?")[1] ?? "").get("topic");

export function CanvasMiniApp() {
  const host = useHostState();
  const [asked, setAsked] = useState(topicOf);
  const [onTop, setOnTop] = useState(true);
  useEffect(() => {
    const onHash = () => setAsked(topicOf());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => void window.amo?.canvasMiniTop?.().then(setOnTop), []);
  const asking = useWaitingQuestions(host.kind === "ready" ? host.link : { url: "", token: "" });
  const live = host.kind === "ready" ? host.state.topics.filter((t) => !t.archivedAt) : [];
  const topic = live.find((t) => t.id === asked) ?? live[0];
  useTitle(topic ? `画布小窗 · ${topic.title}` : "画布小窗");

  if (host.kind !== "ready") return <div className="placeholder">{host.kind === "connecting" ? "正在连接 Host…" : `未连接：${host.reason}`}</div>;
  const { link, state } = host;
  if (!topic) return <div className="placeholder">还没有专题。</div>;
  const open = (target: { taskId?: string; sessionId?: string; topicId?: string }) => void window.amo?.openInWorkbench?.(target);
  return (
    <div className="canvas-mini" data-testid="canvas-mini">
      <div className="canvas-mini-bar">
        <select aria-label="专题" value={topic.id} onChange={(e) => (location.hash = `#canvas-mini?topic=${e.target.value}`)} data-testid="canvas-mini-topic">
          {live.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
              {asking[t.id] ? `（? ${asking[t.id]}）` : ""}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button type="button" className="btn-ghost small" onClick={() => open({ topicId: topic.id })} title="在工作台打开这张画布（有侧栏和全部操作）" data-testid="canvas-mini-open-main">
          主窗口打开
        </button>
        <button
          type="button"
          className={onTop ? "btn-ghost small is-on" : "btn-ghost small"}
          aria-pressed={onTop}
          onClick={() => void window.amo?.canvasMiniTop?.(!onTop).then(setOnTop)}
          title={onTop ? "现在在其他窗口上面；点一下取消置顶" : "点一下让小窗留在其他窗口上面"}
          data-testid="canvas-mini-top"
        >
          {onTop ? "✓ 置顶" : "置顶"}
        </button>
      </div>
      <CanvasPage
        key={topic.id}
        compact
        link={link}
        topic={topic}
        tasks={state.tasks.filter((t) => t.topicId === topic.id && !t.archivedAt)}
        allTasks={state.tasks}
        topics={state.topics}
        sessions={state.sessions}
        workspaces={state.workspaces}
        profiles={state.profiles}
        onOpenTask={(taskId, sessionId) => open({ taskId, ...(sessionId ? { sessionId } : {}) })}
      />
    </div>
  );
}

/** The window's title follows the topic shown. */
function useTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
