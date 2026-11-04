// A snapshot for 全景's preview (P1, 2026-11-02): reads the running Host (GET only, it changes nothing) and writes a
// JSON file next to this one. Only structure and titles go in — ids, columns, statuses, times, who started whom,
// checklist ticks, canvas dependencies, the titles of topic documents and review items, project names. No
// conversation, no descriptions, no document or review text, no checklist text, no paths, no credentials (the Host's
// token is read to ask, never written).
//
//   cd studio && node plans/userlayer/panorama-snapshot.mjs [topic title or id, default AMO迭代] [data dir, default .data]
//     → panorama-snapshot.json, one topic as P1 drew it
//   cd studio && node plans/userlayer/panorama-snapshot.mjs --all [data dir]
//     → panorama-snapshot-all.json, as Studio's 全景 draws it since 11-04: every live topic, and the tasks in no topic
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const all = process.argv[2] === "--all";
const want = all ? null : process.argv[2] || "AMO迭代";
const dataDir = process.argv[3] || process.env.AMO_STUDIO_DATA_DIR || join(here, "..", "..", ".data");
const { url } = JSON.parse(readFileSync(join(dataDir, "host.json"), "utf8"));
const token = readFileSync(join(dataDir, "host-token"), "utf8").trim();

async function get(path) {
  const r = await fetch(url + path, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

const state = await get("/api/state");
const topics = all ? state.topics.filter((t) => !t.archivedAt) : state.topics.filter((t) => t.id === want || t.title === want);
if (!topics.length) throw new Error(`no topic ${want}; there are: ${state.topics.map((t) => t.title).join(", ")}`);
const topicIds = new Set(topics.map((t) => t.id));
const tasks = state.tasks.filter((t) => (t.topicId ? topicIds.has(t.topicId) : all));
const ids = new Set(tasks.map((t) => t.id));
// A task's sessions; with --all also the topics' own (the 主控 spine).
const sessions = state.sessions.filter((s) => (s.taskId ? ids.has(s.taskId) : all && s.topicId && topicIds.has(s.topicId)));
const checklist = (await get("/api/checklist")).filter((c) => ids.has(c.taskId));
const canvases = await Promise.all(topics.map((t) => get(`/api/topics/${encodeURIComponent(t.id)}/canvas`)));
const docs = all ? (await Promise.all(topics.map((t) => get(`/api/topics/${encodeURIComponent(t.id)}/docs`)))).flat() : [];
const wsIds = new Set([...tasks.map((t) => t.workspaceId), ...topics.flatMap((t) => t.workspaceIds)]);

const topicOut = (t) => ({ id: t.id, title: t.title, workspaceIds: all ? t.workspaceIds : [], createdAt: t.createdAt, updatedAt: t.updatedAt, archivedAt: t.archivedAt });
const snap = {
  takenAt: new Date().toISOString(),
  topic: topicOut(topics[0]),
  ...(all ? { topics: topics.map(topicOut), loose: true } : {}),
  tasks: tasks.map((t) => ({ id: t.id, title: t.title, workspaceId: all ? t.workspaceId : "", topicId: t.topicId, column: t.column, createdAt: t.createdAt, updatedAt: t.updatedAt, archivedAt: t.archivedAt })),
  sessions: sessions.map((s) => ({
    id: s.id,
    taskId: s.taskId,
    topicId: s.topicId,
    parentId: s.parentId,
    kind: s.kind,
    ...(s.startedBy ? { startedBy: s.startedBy } : {}),
    runtime: s.runtime,
    profileId: s.profileId,
    workspaceId: "",
    title: s.title,
    status: s.status,
    writer: s.writer,
    runtimeRef: null,
    options: s.options?.model ? { model: s.options.model } : {},
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    archivedAt: s.archivedAt,
  })),
  profiles: state.profiles.map((p) => ({ id: p.id, label: p.label, runtime: p.runtime, provider: null, model: null })),
  checklist: checklist.map((c) => ({ id: c.id, taskId: c.taskId, position: c.position, text: "", done: c.done, doneBySessionId: null, doneAt: c.doneAt, source: "" })),
  dependencies: canvases.flatMap((c) => c.edges.filter((e) => e.kind === "depends").map((e) => ({ from: e.from, to: e.to }))),
  ...(all
    ? {
        // Names only: a project's path stays out.
        workspaces: state.workspaces.filter((w) => wsIds.has(w.id)).map((w) => ({ id: w.id, name: w.name })),
        docs: docs.map((d) => ({ id: d.id, topicId: d.topicId, title: d.title, updatedAt: d.updatedAt })),
        reviews: canvases.flatMap((c) => c.nodes.filter((n) => n.kind === "item").map((n) => ({ id: n.id, topicId: c.id, num: n.num, title: n.title, status: n.status, sessionId: n.sessionId, updatedAt: c.updatedAt }))),
      }
    : {}),
};
const out = join(here, all ? "panorama-snapshot-all.json" : "panorama-snapshot.json");
writeFileSync(out, JSON.stringify(snap, null, 1));
console.log(
  `${topics.map((t) => t.title).join(", ")}: ${snap.tasks.length} tasks (${snap.tasks.filter((t) => !t.topicId).length} in no topic), ${snap.sessions.length} sessions, ${snap.checklist.length} checklist steps, ${snap.dependencies.length} dependencies${all ? `, ${snap.docs.length} documents, ${snap.reviews.length} review items, ${snap.workspaces.length} projects` : ""} → ${out}`,
);
