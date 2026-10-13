import { CanvasPage } from "./CanvasPage.js";
import type { ViewDef } from "../shell/views.js";

/** The canvas of the topic in scope, else of the first live topic (each topic has its own canvas). */
export const canvasView: ViewDef<"canvas"> = {
  kind: "canvas",
  tab: { label: "画布", open: () => ({ kind: "canvas" }) },
  render: (_view, { link, state, scope, setView }) => {
    const liveTopics = state.topics.filter((t) => !t.archivedAt);
    const topic = (scope.kind === "topic" ? liveTopics.find((t) => t.id === scope.id) : undefined) ?? liveTopics[0];
    if (!topic) return <div className="placeholder">还没有专题。在左栏建一个专题，每个专题有一张自己的画布。</div>;
    return (
      <CanvasPage
        key={topic.id}
        link={link}
        topic={topic}
        tasks={state.tasks.filter((t) => t.topicId === topic.id && !t.archivedAt)}
        sessions={state.sessions}
        workspaces={state.workspaces}
        profiles={state.profiles}
        onOpenTask={(taskId, sessionId) => setView({ kind: "task", taskId, ...(sessionId ? { sessionId } : {}), back: { kind: "canvas" } })}
        onNewTask={() => setView({ kind: "new", topicId: topic.id, back: { kind: "canvas" } })}
      />
    );
  },
};
