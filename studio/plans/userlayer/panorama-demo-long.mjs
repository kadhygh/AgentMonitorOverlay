// 全景 preview: a made-up variant of the demo snapshot with two long tasks (2026-11-02), to look at folding and the fixed
// footprint, which the real data (at most 6 rounds a task) never shows: 「长任务演示」 with 40 rounds of which only 4
// opened something or wait on the person, and 「百轮演示」 with 100 rounds of which 3 do. Writes
// panorama-snapshot-long.json next to this file; run from studio/: node plans/userlayer/panorama-demo-long.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(join(here, "panorama-snapshot-demo.json"), "utf8"));
const topicId = snap.topic.id;
const now = Date.parse(snap.takenAt);

// A stable "random" 0–1 per string, so the file is the same every run.
const rnd = (s) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967296;
};
const iso = (t) => new Date(t).toISOString();
const WORK = ["整理接口", "补测试", "改布局", "查卡顿", "修小问题", "对一下文档", "跑一遍 e2e", "收尾"];

function longTask(id, title, rounds, special) {
  const end = now - 20 * 60_000;
  const step = Math.min(3 * 3_600_000, (end - (now - 30 * 86_400_000)) / rounds);
  const start = end - rounds * step;
  snap.tasks.push({ id, title, workspaceId: "", topicId, column: "doing", createdAt: iso(start), updatedAt: iso(end), archivedAt: null });
  for (let i = 1; i <= rounds; i++) {
    const sid = `${id}-r${i}`;
    const at = start + (i - 1) * step + rnd(sid) * step * 0.3;
    const minutes = 8 + rnd(sid + "m") ** 2 * 300;
    const what = special[i];
    const last = i === rounds;
    const status = last ? "running" : what === "need" ? "awaiting-answer" : "idle";
    snap.sessions.push({ id: sid, taskId: id, topicId: null, parentId: null, kind: "main", runtime: "claude", profileId: "claude-subscription", workspaceId: "", title: `第 ${i} 轮：${WORK[i % WORK.length]}`, status, writer: "workbench", runtimeRef: null, options: { model: "opus" }, createdAt: iso(at), updatedAt: iso(last ? now : at + minutes * 60_000), archivedAt: null });
    // A round that opened something: two sessions it started, or a branch session off it.
    if (what === "start" || what === "fork")
      for (let k = 0; k < (what === "start" ? 2 : 1); k++) {
        const bid = `${sid}-b${k}`;
        const bat = at + (k + 1) * step * 0.25;
        snap.sessions.push({ id: bid, taskId: id, topicId: null, parentId: what === "fork" ? sid : null, ...(what === "start" ? { startedBy: sid } : {}), kind: what === "fork" ? "fork" : "main", runtime: "claude", profileId: "claude-subscription", workspaceId: "", title: what === "fork" ? "分支：换个做法试试" : `并行：${WORK[(i + k + 3) % WORK.length]}`, status: "completed", writer: "workbench", runtimeRef: null, options: { model: "sonnet" }, createdAt: iso(bat), updatedAt: iso(bat + 40 * 60_000), archivedAt: iso(bat + 50 * 60_000) });
      }
  }
}

longTask("task-demo-long40", "长任务演示", 40, { 9: "start", 17: "fork", 26: "start", 33: "need" });
longTask("task-demo-long100", "百轮演示", 100, { 21: "fork", 58: "start", 77: "need" });
snap.demo = (snap.demo ? snap.demo + "；" : "") + "加了两个虚构的长任务：「长任务演示」40 轮（第 9、17、26 轮开过会话，第 33 轮等你），「百轮演示」100 轮（第 21、58 轮开过会话，第 77 轮等你）";
writeFileSync(join(here, "panorama-snapshot-long.json"), JSON.stringify(snap, null, 1));
console.log("panorama-snapshot-long.json:", snap.tasks.length, "tasks,", snap.sessions.length, "sessions");
