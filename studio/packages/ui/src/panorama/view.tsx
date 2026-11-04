import { useMemo, useState } from "react";
import type { CanvasDoc, CanvasItem, TopicDoc } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { LOOSE_TITLE, LOOSE_TOPIC } from "./datalayer.js";
import { PanoramaPage } from "./PanoramaPage.js";
import { THEMES } from "./themes.js";
import type { ViewDef } from "../shell/views.js";
import { readStored, writeStored } from "../lib/stored.js";

/**
 * 全景 (设置 → 测试功能, 2026-11-01). 11-04 (plans/userlayer/framework.md 第 0 步): every live topic a block, and the
 * tasks in no topic one more; opened from the left column (「全景」 under 全部任务, the user's call), not a tab. Only
 * while the person has turned it on; the deck.gl map inside loads on first use.
 */
export const panoramaView: ViewDef<"panorama"> = {
  kind: "panorama",
  experimental: "panorama",
  render: (_view, { link, state, data, setView }) => {
    const liveTopics = state.topics.filter((t) => !t.archivedAt);
    const loose = state.tasks.some((t) => !t.topicId && !t.archivedAt);
    if (!liveTopics.length && !loose) return <div className="placeholder">还没有专题，也还没有任务。全景画的是每个专题和它的任务。</div>;
    // With `topics` given, `topic` only names the map's context; with no topic at all, the loose block does.
    const topic = liveTopics[0] ?? { id: LOOSE_TOPIC, title: LOOSE_TITLE, workspaceIds: [], createdAt: "", updatedAt: "", archivedAt: null };
    return (
      <PanoramaTopics
        link={link}
        topicIds={liveTopics.map((t) => t.id)}
        render={({ dependencies, docs, reviews }, look) => (
          <PanoramaPage
            key={look.id}
            topic={topic}
            topics={liveTopics}
            loose
            tasks={state.tasks}
            sessions={state.sessions}
            profiles={state.profiles}
            checklist={data.checklist}
            workspaces={state.workspaces}
            dependencies={dependencies}
            docs={docs}
            reviews={reviews}
            theme={THEMES[look.id]}
            looks={LOOKS}
            onLook={look.set}
            onOpenTask={(taskId, sessionId) => setView({ kind: "task", taskId, ...(sessionId ? { sessionId } : {}), back: { kind: "panorama" } })}
          />
        )}
      />
    );
  },
};

/** The two looks Studio offers (11-03's world looks), remembered on this machine; 地形岛 unless picked. */
const LOOKS = [
  { id: "terrain", label: "地形岛" },
  { id: "metro", label: "地铁" },
] as const;
type LookId = (typeof LOOKS)[number]["id"];
const LOOK_KEY = "amo.panorama.look";
function readLook(): LookId {
  const v = readStored(LOOK_KEY);
  return LOOKS.some((l) => l.id === v) ? (v as LookId) : "terrain";
}

type Review = Pick<CanvasItem, "id" | "num" | "title" | "status" | "sessionId"> & { topicId: string; updatedAt?: string };
interface TopicExtras {
  dependencies: readonly { from: string; to: string }[];
  docs: readonly (Pick<TopicDoc, "id" | "topicId" | "title" | "updatedAt"> & { body?: string })[];
  reviews: readonly Review[];
}
type FromCanvas = Pick<TopicExtras, "dependencies" | "reviews">;

/** What a topic's canvas gives 全景, read only: its dependencies (arcs) and review items (the points on its board). */
function fromCanvas(doc: CanvasDoc): FromCanvas {
  return {
    dependencies: doc.edges.map((e) => ({ from: e.from, to: e.to })),
    reviews: doc.nodes.filter((n): n is CanvasItem => n.kind === "item").map((n) => ({ id: n.id, num: n.num, title: n.title, status: n.status, sessionId: n.sessionId, topicId: doc.id, updatedAt: doc.updatedAt })),
  };
}

type Loaded = { canvases: ReadonlyMap<string, FromCanvas>; docs: ReadonlyMap<string, TopicExtras["docs"]> };
const NOTHING: Loaded = { canvases: new Map(), docs: new Map() };

/**
 * Every live topic's canvas and documents (全景 never changes them), kept current from the Host's events and read again
 * after a reconnect (host/live.ts). A topic whose canvas or documents cannot be read is drawn without them.
 */
function PanoramaTopics({ link, topicIds, render }: { link: HostLink; topicIds: readonly string[]; render(extras: TopicExtras, look: { id: LookId; set(id: string): void }): React.ReactNode }) {
  const ids = topicIds.join(",");
  const mine = new Set(topicIds);
  const [look, setLook] = useState<LookId>(readLook);
  const [{ canvases, docs }] = useLiveResource<Loaded>(
    {
      load: async () => {
        const canvases = new Map<string, FromCanvas>();
        const docs = new Map<string, TopicExtras["docs"]>();
        await Promise.all(
          (ids ? ids.split(",") : []).map(async (id) => {
            const [canvas, list] = await Promise.all([
              call(link, "GET /api/topics/:id/canvas", { id }).catch(() => undefined),
              call(link, "GET /api/topics/:id/docs", { id }).catch(() => undefined),
            ]);
            if (canvas) canvases.set(id, fromCanvas(canvas));
            if (list) docs.set(id, list);
          }),
        );
        return { canvases, docs };
      },
      initial: NOTHING,
      onEvent: (cur, e) => {
        if (e.type === "canvas.updated" && mine.has(e.canvas.id)) return { ...cur, canvases: new Map(cur.canvases).set(e.canvas.id, fromCanvas(e.canvas)) };
        if (e.type === "topicdoc.upserted" && mine.has(e.doc.topicId)) return { ...cur, docs: new Map(cur.docs).set(e.doc.topicId, [...(cur.docs.get(e.doc.topicId) ?? []).filter((d) => d.id !== e.doc.id), e.doc]) };
        if (e.type === "topicdoc.removed" && cur.docs.has(e.topicId)) return { ...cur, docs: new Map(cur.docs).set(e.topicId, cur.docs.get(e.topicId)!.filter((d) => d.id !== e.docId)) };
        return cur;
      },
    },
    [link, ids],
  );
  // One object per change, so the page's datalayer runs again only when something it reads changed.
  const extras = useMemo<TopicExtras>(() => {
    const c = [...canvases.values()];
    return { dependencies: c.flatMap((x) => x.dependencies), reviews: c.flatMap((x) => x.reviews), docs: [...docs.values()].flat() };
  }, [canvases, docs]);
  const set = (id: string) => {
    if (!LOOKS.some((l) => l.id === id)) return;
    setLook(id as LookId);
    writeStored(LOOK_KEY, id);
  };
  return <>{render(extras, { id: look, set })}</>;
}
