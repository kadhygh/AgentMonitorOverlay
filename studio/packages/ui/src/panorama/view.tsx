import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { PanoramaPage } from "./PanoramaPage.js";
import type { ViewDef } from "../shell/views.js";

/**
 * 全景 (设置 → 测试功能, 2026-11-01): like the canvas, the topic in scope, else the first live topic. Only while the
 * person has turned it on; the deck.gl map inside loads on first use.
 */
export const panoramaView: ViewDef<"panorama"> = {
  kind: "panorama",
  experimental: "panorama",
  tab: { label: "全景", open: () => ({ kind: "panorama" }) },
  render: (_view, { link, state, scope, data, setView }) => {
    const liveTopics = state.topics.filter((t) => !t.archivedAt);
    const topic = (scope.kind === "topic" ? liveTopics.find((t) => t.id === scope.id) : undefined) ?? liveTopics[0];
    if (!topic) return <div className="placeholder">还没有专题。在左栏建一个专题，全景画的是一个专题里的任务。</div>;
    return (
      <PanoramaTopic
        key={topic.id}
        link={link}
        topicId={topic.id}
        render={(dependencies) => (
          <PanoramaPage
            topic={topic}
            tasks={state.tasks}
            sessions={state.sessions}
            profiles={state.profiles}
            checklist={data.checklist}
            dependencies={dependencies}
            onOpenTask={(taskId, sessionId) => setView({ kind: "task", taskId, ...(sessionId ? { sessionId } : {}), back: { kind: "panorama" } })}
          />
        )}
      />
    );
  },
};

/** The topic canvas's dependencies, read only (P1, 2026-11-02: 全景 draws them as arcs, it never changes the canvas). */
function PanoramaTopic({ link, topicId, render }: { link: HostLink; topicId: string; render(dependencies: readonly { from: string; to: string }[]): React.ReactNode }) {
  const pick = (edges: readonly { from: string; to: string }[]) => edges.map((e) => ({ from: e.from, to: e.to }));
  const [deps] = useLiveResource<readonly { from: string; to: string }[]>(
    {
      load: () => call(link, "GET /api/topics/:id/canvas", { id: topicId }).then((doc) => pick(doc.edges)),
      initial: [],
      onEvent: (cur, e) => (e.type === "canvas.updated" && e.canvas.id === topicId ? pick(e.canvas.edges) : cur),
    },
    [link, topicId],
  );
  return <>{render(deps)}</>;
}
