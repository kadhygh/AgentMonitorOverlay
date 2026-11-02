// A snapshot of one topic for 全景's preview (P1, 2026-11-02): reads the running Host (GET only, it changes nothing)
// and writes panorama-snapshot.json next to this file. Only structure and titles go in — ids, columns, statuses,
// times, who started whom, checklist ticks, canvas dependencies. No conversation, no descriptions, no checklist text,
// no paths, no credentials (the Host's token is read to ask, never written).
//
//   cd studio && node plans/userlayer/panorama-snapshot.mjs [topic title or id, default AMO迭代] [data dir, default .data]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const want = process.argv[2] || "AMO迭代";
const dataDir = process.argv[3] || process.env.AMO_STUDIO_DATA_DIR || join(here, "..", "..", ".data");
const { url } = JSON.parse(readFileSync(join(dataDir, "host.json"), "utf8"));
const token = readFileSync(join(dataDir, "host-token"), "utf8").trim();

async function get(path) {
  const r = await fetch(url + path, { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

const state = await get("/api/state");
const topic = state.topics.find((t) => t.id === want || t.title === want);
if (!topic) throw new Error(`no topic ${want}; there are: ${state.topics.map((t) => t.title).join(", ")}`);
const tasks = state.tasks.filter((t) => t.topicId === topic.id);
const ids = new Set(tasks.map((t) => t.id));
const sessions = state.sessions.filter((s) => s.taskId && ids.has(s.taskId));
const checklist = (await get("/api/checklist")).filter((c) => ids.has(c.taskId));
const canvas = await get(`/api/topics/${encodeURIComponent(topic.id)}/canvas`);

const snap = {
  takenAt: new Date().toISOString(),
  topic: { id: topic.id, title: topic.title, workspaceIds: [], createdAt: topic.createdAt, updatedAt: topic.updatedAt, archivedAt: topic.archivedAt },
  tasks: tasks.map((t) => ({ id: t.id, title: t.title, workspaceId: "", topicId: t.topicId, column: t.column, createdAt: t.createdAt, updatedAt: t.updatedAt, archivedAt: t.archivedAt })),
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
  dependencies: canvas.edges.filter((e) => e.kind === "depends").map((e) => ({ from: e.from, to: e.to })),
};
const out = join(here, "panorama-snapshot.json");
writeFileSync(out, JSON.stringify(snap, null, 1));
console.log(`${topic.title}: ${snap.tasks.length} tasks, ${snap.sessions.length} sessions, ${snap.checklist.length} checklist steps, ${snap.dependencies.length} dependencies → ${out}`);
