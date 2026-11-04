import { describe, expect, it } from "vitest";
import type { ChecklistItem, Session, SessionStatus, Task, Topic } from "@amo-studio/protocol";
import { cut, LOOSE_TITLE, LOOSE_TOPIC, needsYou, toPanorama, workOf } from "./datalayer.js";
import { boardLines, foldRuns, goalGap, layoutPanorama, pillarHeight, U } from "./layout.js";
import { LOOKS, lookFrom } from "./themes.js";

const topic: Topic = { id: "tp-1", title: "AMO迭代", workspaceIds: [], description: "这几天的迭代", createdAt: "2026-10-29T12:00:00.000Z", updatedAt: "2026-11-01T02:00:00.000Z", archivedAt: null };

function task(id: string, createdAt: string, extra: Partial<Task> = {}): Task {
  return { id, title: `任务 ${id}`, workspaceId: "ws-1", topicId: topic.id, column: "doing", createdAt, updatedAt: createdAt, archivedAt: null, ...extra };
}

function session(id: string, taskId: string, createdAt: string, status: SessionStatus, extra: Partial<Session> = {}): Session {
  return { id, taskId, topicId: null, parentId: null, kind: "main", runtime: "claude", profileId: "claude", workspaceId: "ws-1", title: `会话 ${id}`, status, writer: "workbench", runtimeRef: null, options: {}, createdAt, updatedAt: createdAt, archivedAt: null, ...extra };
}

const NOW = "2026-11-01T03:00:00.000Z";

function step(id: string, taskId: string, done: boolean): ChecklistItem {
  return { id, taskId, position: 0, text: id, done, doneBySessionId: null, doneAt: done ? NOW : null, source: "person" } as ChecklistItem;
}

describe("全景 datalayer", () => {
  it("makes a lane per live task of the topic, oldest first, and its sessions items in time order", () => {
    const tasks = [
      task("t-b", "2026-10-31T01:00:00.000Z", { title: "开发 android 版 apk" }),
      task("t-a", "2026-10-30T01:00:00.000Z", { title: "" }),
      task("t-gone", "2026-10-30T02:00:00.000Z", { archivedAt: "2026-10-31T00:00:00.000Z" }),
      task("t-other", "2026-10-30T03:00:00.000Z", { topicId: "tp-2" }),
    ];
    const sessions = [
      session("s-2", "t-b", "2026-10-31T05:00:00.000Z", "running"),
      session("s-1", "t-b", "2026-10-31T02:00:00.000Z", "idle"),
      session("s-a", "t-a", "2026-10-30T02:00:00.000Z", "completed"),
      session("s-x", "t-gone", "2026-10-30T02:00:00.000Z", "running"),
    ];
    const d = toPanorama({ topic, tasks, sessions, now: NOW });
    expect(d.spec).toBe("amo.datalayer/0.3");
    expect(d.context).toEqual({ id: "tp-1", title: "AMO迭代", goal: "这几天的迭代", updatedAt: topic.updatedAt });
    expect(d.now).toBe(NOW);
    expect(d.lanes.map((l) => [l.id, l.title, l.status, l.startAt])).toEqual([
      ["t-a", "未命名任务", "waiting", "2026-10-30T01:00:00.000Z"],
      ["t-b", "开发 android 版 apk", "running", "2026-10-31T01:00:00.000Z"],
    ]);
    expect(d.items.map((i) => [i.num, i.id, i.lane, i.status, i.summary])).toEqual([
      [1, "s-a", "t-a", "settled", "已完成"],
      [2, "s-1", "t-b", "settled", "空闲，等下一条消息"],
      [3, "s-2", "t-b", "working", "在跑"],
    ]);
    expect(d.items[2]!.ref).toMatchObject({ taskId: "t-b", sessionId: "s-2", sessionStatus: "running" });
  });

  it("marks the sessions waiting on the person as 等你, owned by the person, and orders them by how long they waited", () => {
    const tasks = [task("t-1", "2026-10-31T01:00:00.000Z")];
    const sessions = [
      session("s-ok", "t-1", "2026-10-31T01:00:00.000Z", "running"),
      session("s-ans", "t-1", "2026-10-31T02:00:00.000Z", "awaiting-answer", { updatedAt: "2026-10-31T09:00:00.000Z" }),
      session("s-app", "t-1", "2026-10-31T03:00:00.000Z", "awaiting-approval", { updatedAt: "2026-10-31T04:00:00.000Z" }),
      session("s-rev", "t-1", "2026-10-31T04:00:00.000Z", "awaiting-review", { updatedAt: "2026-10-31T08:00:00.000Z" }),
      // Archived: history, it waits for nobody any more.
      session("s-old", "t-1", "2026-10-31T05:00:00.000Z", "awaiting-approval", { archivedAt: "2026-10-31T06:00:00.000Z" }),
    ];
    const d = toPanorama({ topic, tasks, sessions, now: NOW });
    const byId = Object.fromEntries(d.items.map((i) => [i.id, i]));
    expect(byId["s-ans"]).toMatchObject({ status: "needs_you", owner: "human", summary: "等你回答" });
    expect(byId["s-app"]).toMatchObject({ status: "needs_you", summary: "等你批准" });
    expect(byId["s-rev"]).toMatchObject({ status: "needs_you", summary: "等你审阅" });
    expect(byId["s-ok"]).toMatchObject({ status: "working", owner: "s-ok" });
    expect(byId["s-old"]).toMatchObject({ status: "settled", summary: "已归档" });
    expect(needsYou(d).map((i) => i.id)).toEqual(["s-app", "s-rev", "s-ans"]);
    expect(d.lanes[0]!.status).toBe("running");
  });

  it("leaves subagents out, keeps branches, and says when a task is done or its session failed", () => {
    const tasks = [task("t-1", "2026-10-31T01:00:00.000Z", { column: "done", updatedAt: "2026-10-31T09:00:00.000Z" })];
    const sessions = [
      session("s-main", "t-1", "2026-10-31T01:00:00.000Z", "error"),
      session("s-fork", "t-1", "2026-10-31T02:00:00.000Z", "interrupted", { kind: "fork", parentId: "s-main", title: "" }),
      session("s-sub", "t-1", "2026-10-31T03:00:00.000Z", "running", { kind: "sub", parentId: "s-main" }),
    ];
    const d = toPanorama({ topic, tasks, sessions, profiles: [{ id: "claude", label: "Claude", runtime: "claude", provider: null, model: null }], now: NOW });
    expect(d.lanes[0]).toMatchObject({ status: "done", endAt: "2026-10-31T09:00:00.000Z", column: "done" });
    expect(d.items.map((i) => [i.id, i.status, i.title, i.ref.model])).toEqual([
      ["s-main", "parked", "会话 s-main", "Claude"],
      ["s-fork", "parked", "分支会话", "Claude"],
    ]);
  });

  it("grows a tree: main sessions are rounds, branches and sessions another one started fork off it", () => {
    const tasks = [task("t-1", "2026-10-31T01:00:00.000Z")];
    const sessions = [
      session("r1", "t-1", "2026-10-31T01:00:00.000Z", "idle"),
      session("r2", "t-1", "2026-10-31T03:00:00.000Z", "running"),
      session("f", "t-1", "2026-10-31T02:00:00.000Z", "idle", { kind: "fork", parentId: "r1" }),
      // Opened with session_start by round 2; archived: it stopped.
      session("st", "t-1", "2026-10-31T04:00:00.000Z", "idle", { startedBy: "r2", archivedAt: "2026-10-31T05:00:00.000Z" }),
      // Started by a session not drawn (a subagent): a round of its own.
      session("sub", "t-1", "2026-10-31T04:30:00.000Z", "running", { kind: "sub", parentId: "r2" }),
      session("r3", "t-1", "2026-10-31T05:00:00.000Z", "completed", { startedBy: "sub" }),
    ];
    const d = toPanorama({ topic, tasks, sessions, now: NOW });
    expect(d.items.map((i) => [i.id, i.round, i.forkFrom, i.ended, i.ref.how])).toEqual([
      ["r1", 1, null, false, "round"],
      ["f", null, "r1", false, "fork"],
      ["r2", 2, null, false, "round"],
      ["st", null, "r2", true, "started"],
      ["r3", 3, null, false, "round"],
    ]);
  });

  it("puts the goal by the board column and counts the checklist; keeps only dependencies between the topic's tasks", () => {
    const tasks = [
      task("t-1", "2026-10-30T01:00:00.000Z"),
      task("t-2", "2026-10-30T02:00:00.000Z", { column: "review" }),
      task("t-3", "2026-10-30T03:00:00.000Z", { column: "done" }),
      task("t-x", "2026-10-30T04:00:00.000Z", { topicId: "tp-2" }),
    ];
    const checklist = [step("c1", "t-1", true), step("c2", "t-1", false), step("c3", "t-1", false), step("cx", "t-x", false)];
    const dependencies = [
      { from: "t-1", to: "t-2" },
      { from: "t-x", to: "t-1" },
      { from: "t-3", to: "t-3" },
    ];
    const d = toPanorama({ topic, tasks, sessions: [], checklist, dependencies, now: NOW });
    expect(d.lanes.map((l) => [l.id, l.goal])).toEqual([
      ["t-1", { state: "open", checklist: { done: 1, total: 3 } }],
      ["t-2", { state: "review", checklist: null }],
      ["t-3", { state: "reached", checklist: null }],
    ]);
    expect(d.links).toEqual([{ from: "t-1", to: "t-2", rel: "depends" }]);
  });

  it("cuts long titles for the signs", () => {
    expect(cut("一二三四五六七八九十一二三", 12)).toBe("一二三四五六七八九十一…");
    expect(cut("短", 12)).toBe("短");
    const d = toPanorama({ topic, tasks: [task("t-1", NOW, { title: "给 al20 那个设备也加下 tailscale 转发" })], sessions: [], now: NOW });
    expect([...d.lanes[0]!.short].length).toBe(12);
  });
});

describe("全景 layout", () => {
  it("places every item on its task's lane, in order, and the same data always the same way", () => {
    const tasks = [task("t-1", "2026-10-30T01:00:00.000Z"), task("t-2", "2026-10-31T01:00:00.000Z")];
    const sessions = [
      session("a", "t-1", "2026-10-30T02:00:00.000Z", "idle"),
      session("b", "t-1", "2026-10-30T03:00:00.000Z", "awaiting-answer"),
      session("c", "t-2", "2026-10-31T02:00:00.000Z", "running"),
    ];
    const d = toPanorama({ topic, tasks, sessions, now: NOW });
    const L = layoutPanorama(d);
    expect(L.regions.map((r) => r.id)).toEqual(["t-1", "t-2"]);
    expect(L.byItem["b"]!.id).toBe("t-1");
    const r1 = L.regions[0]!;
    // Along the lane: the later session further on (east), up at node height.
    expect(r1.nodes["b"]!.at[0]).toBeGreaterThan(r1.nodes["a"]!.at[0]);
    expect(r1.nodes["a"]!.at[2]).toBeGreaterThan(0);
    // Inside its own area, and the areas do not overlap.
    for (const r of L.regions)
      for (const id of Object.keys(r.nodes)) {
        const [x, y] = r.nodes[id]!.ground;
        expect(x).toBeGreaterThan(r.bounds[0]);
        expect(x).toBeLessThan(r.bounds[2]);
        expect(y).toBeGreaterThan(r.bounds[1]);
        expect(y).toBeLessThan(r.bounds[3]);
      }
    const [a, b] = [L.regions[0]!.bounds, L.regions[1]!.bounds];
    expect(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]).toBe(true);
    // A status change moves nothing.
    const moved = layoutPanorama(toPanorama({ topic, tasks, sessions: sessions.map((s) => ({ ...s, status: "running" as const })), now: NOW }));
    expect(moved.regions[0]!.nodes["b"]).toEqual(r1.nodes["b"]);
    expect(L.grid.length).toBeGreaterThan(0);
  });

  it("copes with a topic without tasks and a task without sessions", () => {
    expect(layoutPanorama(toPanorama({ topic, tasks: [], sessions: [], now: NOW })).regions).toEqual([]);
    const L = layoutPanorama(toPanorama({ topic, tasks: [task("t-1", NOW)], sessions: [], now: NOW }));
    expect(L.regions[0]!.walked.length).toBeGreaterThan(1);
    expect(L.bounds[0]).toBeLessThan(L.bounds[2]);
  });
});

describe("全景 tree layout", () => {
  const tasks = [task("t-1", "2026-10-31T01:00:00.000Z"), task("t-2", "2026-10-31T02:00:00.000Z")];
  const sessions = [
    session("r1", "t-1", "2026-10-31T01:00:00.000Z", "idle"),
    session("f", "t-1", "2026-10-31T02:00:00.000Z", "running", { kind: "fork", parentId: "r1" }),
    session("r2", "t-1", "2026-10-31T03:00:00.000Z", "idle"),
    session("r3", "t-1", "2026-10-31T04:00:00.000Z", "running"),
    session("q", "t-2", "2026-10-31T02:00:00.000Z", "idle"),
  ];

  it("lays the trunk evenly from the start beacon, branches off it, the goal ahead and lights into what runs", () => {
    const L = layoutPanorama(toPanorama({ topic, tasks, sessions, dependencies: [{ from: "t-1", to: "t-2" }], now: NOW }));
    const r = L.regions[0]!;
    const x = (id: string) => r.nodes[id]!.ground[0];
    expect(x("r2") - x("r1")).toBeCloseTo(x("r3") - x("r2"), 9);
    expect(r.origin.ground[0]).toBeLessThan(x("r1"));
    expect(r.origin.top[2]).toBeGreaterThan(r.nodes["r1"]!.at[2]);
    // The branch leaves round 1 and sits off the trunk, further on than where it left.
    expect(r.branches.map((b) => [b.from, b.itemIds])).toEqual([["r1", ["f"]]]);
    expect(x("f")).toBeGreaterThan(x("r1"));
    expect(Math.abs(r.nodes["f"]!.ground[1] - r.nodes["r1"]!.ground[1])).toBeGreaterThan(0.005);
    expect(r.branches[0]!.path[0]).toEqual(r.nodes["r1"]!.ground);
    // The goal is ahead of the newest node, the road there still dashes.
    expect(r.goal.ground[0]).toBeGreaterThan(Math.max(...Object.values(r.nodes).map((n) => n.ground[0])));
    expect(r.ahead.length).toBeGreaterThan(0);
    expect(r.active).toBe(true);
    // Two running sessions: the branch and round 3 (lights come from round 2).
    expect(r.flows.length).toBe(2);
    expect(r.flows[1]![r.flows[1]!.length - 1]![0]).toBeCloseTo(x("r3"), 9);
    // The dependency: from t-1's goal to t-2's start.
    expect(L.arcs).toEqual([{ from: "t-1", to: "t-2", s: r.goal.at, t: L.regions[1]!.origin.top }]);
  });

  it("puts what one session opened on one branch, in the order it started, and another opener on another track", () => {
    const opened = [1, 2, 3].map((k) => session(`o${k}`, "t-1", `2026-10-31T0${4 + k}:00:00.000Z`, "idle", { startedBy: "r1" }));
    const other = session("p", "t-1", "2026-10-31T05:30:00.000Z", "idle", { startedBy: "r2" });
    const L = layoutPanorama(toPanorama({ topic, tasks, sessions: [...sessions, ...opened, other], now: NOW }));
    const r = L.regions[0]!;
    expect(r.branches.map((b) => [b.from, b.itemIds])).toEqual([
      ["r1", ["f", "o1", "o2", "o3"]],
      ["r2", ["p"]],
    ]);
    const x = (id: string) => r.nodes[id]!.ground[0];
    expect(x("o1")).toBeLessThan(x("o2"));
    expect(x("o2")).toBeLessThan(x("o3"));
    // Two branches whose spans overlap are on different tracks.
    expect(r.nodes["p"]!.ground[1] - r.nodes["r2"]!.ground[1]).not.toBeCloseTo(r.nodes["o2"]!.ground[1] - r.nodes["r1"]!.ground[1], 3);
  });

  it("brings the goal closer with each ticked checklist step, and joins it once the task is done", () => {
    const lane = (checklist: { done: number; total: number } | null, state: "open" | "review" | "reached" = "open") =>
      toPanorama({ topic, tasks: [task("t-1", NOW, { column: state === "reached" ? "done" : state === "review" ? "review" : "doing" })], sessions: [], now: NOW }).lanes.map((l) => ({ ...l, goal: { state, checklist } }))[0]!;
    expect(goalGap(lane({ done: 0, total: 4 }))).toBeGreaterThan(goalGap(lane({ done: 2, total: 4 })));
    expect(goalGap(lane({ done: 2, total: 4 }))).toBeGreaterThan(goalGap(lane({ done: 4, total: 4 })));
    expect(goalGap(lane(null, "reached"))).toBeLessThan(goalGap(lane(null)));
    const done = layoutPanorama(toPanorama({ topic, tasks: [task("t-1", NOW, { column: "done" })], sessions: [session("a", "t-1", NOW, "idle")], now: NOW })).regions[0]!;
    expect(done.active).toBe(false);
    expect(done.ahead).toEqual([]);
    expect(done.walked[done.walked.length - 1]![0]).toBeCloseTo(done.goal.ground[0], 9);
    expect(done.flows).toEqual([]);
  });
});

describe("全景 looks (track, pillars, plinth)", () => {
  it("measures a session's work from its start to its end, to now while it runs, on a log scale capped at ten hours", () => {
    const at = (h: number) => new Date(Date.parse("2026-11-01T00:00:00.000Z") + h * 3_600_000).toISOString();
    const base = { createdAt: at(0), updatedAt: at(2), archivedAt: null };
    expect(workOf({ ...base, status: "idle" }, at(5)).minutes).toBe(120);
    expect(workOf({ ...base, status: "running" }, at(5)).minutes).toBe(300);
    expect(workOf({ ...base, status: "awaiting-answer" }, at(5)).minutes).toBe(300);
    expect(workOf({ ...base, status: "running", archivedAt: at(1) }, at(5)).minutes).toBe(60);
    const w = (h: number) => workOf({ ...base, updatedAt: at(h), status: "idle" }, at(99)).weight;
    expect(w(0)).toBe(0);
    expect(w(1)).toBeGreaterThan(0.5);
    expect(w(1)).toBeLessThan(w(4));
    expect(w(10)).toBe(1);
    expect(w(40)).toBe(1);
  });

  it("hugs the tree with a tight base, lays the road as a band with a tick per round, and raises columns by work", () => {
    const tasks = [task("t-1", "2026-10-31T01:00:00.000Z")];
    const sessions = [
      session("r1", "t-1", "2026-10-31T01:00:00.000Z", "idle", { updatedAt: "2026-10-31T01:05:00.000Z" }),
      session("r2", "t-1", "2026-10-31T02:00:00.000Z", "idle", { updatedAt: "2026-10-31T09:00:00.000Z" }),
      session("b", "t-1", "2026-10-31T03:00:00.000Z", "idle", { startedBy: "r2", updatedAt: "2026-10-31T09:00:00.000Z" }),
    ];
    const d = toPanorama({ topic, tasks, sessions, now: NOW });
    const wide = layoutPanorama(d).regions[0]!;
    const tight = layoutPanorama(d, { tight: true }).regions[0]!;
    const span = (b: number[]) => b[2]! - b[0]!;
    expect(span(tight.bounds)).toBeLessThan(span(wide.bounds));
    expect(tight.nameBelow).toBe(true);
    expect(tight.name[1]).toBeLessThan(tight.bounds[1]);
    // The band: both edges, its fill closed around the part walked, one tick per round, one branch band.
    expect(tight.band.walked.length).toBe(2);
    expect(tight.band.ahead.length).toBe(2);
    expect(tight.band.ticks.length).toBe(2);
    expect(tight.band.branches.length).toBe(1);
    expect(tight.band.fill.length).toBe(tight.band.walked[0]!.length * 2);
    // Columns: the longer round taller; a branch lower than a round of the same work.
    const [r1, r2, b] = d.items;
    expect(pillarHeight(r2!)).toBeGreaterThan(pillarHeight(r1!));
    expect(pillarHeight(b!)).toBeLessThan(pillarHeight(r2!));
    expect(tight.nodes["r2"]!.top[2]).toBe(pillarHeight(r2!));
  });
});

describe("全景 front, folding, fixed footprint, curves", () => {
  // A task with n rounds an hour apart; `opener` rounds started a session, `need` ones wait on the person.
  const long = (id: string, n: number, opener: number[] = [], need: number[] = [], t0 = Date.parse("2026-10-01T00:00:00.000Z")) => {
    const at = (h: number) => new Date(t0 + h * 3_600_000).toISOString();
    const sessions: Session[] = [];
    for (let i = 1; i <= n; i++) {
      sessions.push(session(`${id}-r${i}`, id, at(i), need.includes(i) ? "awaiting-answer" : "idle"));
      if (opener.includes(i)) sessions.push(session(`${id}-b${i}`, id, at(i + 0.5), "completed", { startedBy: `${id}-r${i}` }));
    }
    return { task: task(id, at(0)), sessions };
  };
  const data = (...ts: ReturnType<typeof long>[]) => toPanorama({ topic, tasks: ts.map((t) => t.task), sessions: ts.flatMap((t) => t.sessions), now: NOW });

  it("folds runs of three or more smooth rounds, keeping the first, the latest two, openers and what waits on the person", () => {
    const d = data(long("t-1", 40, [9, 17, 26], [33]));
    const trunk = d.items.filter((i) => i.round !== null);
    expect(foldRuns(trunk, d.items).map((r) => [r[0]!.round, r.length])).toEqual([
      [2, 7],
      [10, 7],
      [18, 8],
      [27, 6],
      [34, 5],
    ]);
    // Short tasks have nothing to fold.
    const s = data(long("t-2", 4));
    expect(foldRuns(s.items, s.items)).toEqual([]);
  });

  it("opens a folded run where it stands: nothing else moves, the footprint stays", () => {
    const d = data(long("t-1", 40, [9, 17, 26], [33]));
    const shut = layoutPanorama(d, { tight: true, fold: true }).regions[0]!;
    const key = shut.folds[1]!.key;
    const open = layoutPanorama(d, { tight: true, fold: true, open: new Set([key]) }).regions[0]!;
    expect(open.folds.map((f) => f.open)).toEqual([false, true, false, false, false]);
    expect(open.bounds).toEqual(shut.bounds);
    const inRun = new Set(shut.folds[1]!.ids);
    for (const it of d.items) if (!inRun.has(it.id)) expect(open.nodes[it.id]!.ground).toEqual(shut.nodes[it.id]!.ground);
    // Folded, its rounds bunch together (and the mark across the road shows); open, they spread over the same stretch.
    const xs = (r: typeof shut) => shut.folds[1]!.ids.map((id) => r.nodes[id]!.ground[0]);
    const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
    expect(spread(xs(open))).toBeGreaterThan(spread(xs(shut)) * 4);
    expect(shut.folds[1]!.brk.length).toBe(2);
    expect(open.folds[1]!.brk.length).toBe(0);
    // "all": everything open (the camera at 中).
    expect(layoutPanorama(d, { fold: true, open: "all" }).regions[0]!.folds.every((f) => f.open)).toBe(true);
  });

  it("keeps a task's footprint about fixed with span: 40 rounds and 100 take about the same room, the newest spaced widest", () => {
    const width = (n: number, span: boolean) => {
      const r = layoutPanorama(data(long("t-1", n)), { tight: true, span }).regions[0]!;
      return { w: r.bounds[2] - r.bounds[0], r };
    };
    const w40 = width(40, true).w;
    const { w: w100, r } = width(100, true);
    expect(Math.abs(w100 - w40) / w40).toBeLessThan(0.05);
    expect(width(100, false).w).toBeGreaterThan(w100 * 4);
    // A short task is laid out as without it.
    expect(width(6, true).w).toBeCloseTo(width(6, false).w, 9);
    const x = r.items.map((i) => r.nodes[i.id]!.ground[0]);
    expect(x[99]! - x[98]!).toBeGreaterThan((x[1]! - x[0]!) * 20);
  });

  it("raises the front node's column and puts chevrons ahead of it until the goal is reached", () => {
    const d = data(long("t-1", 5, [3]));
    const r = layoutPanorama(d, { tight: true, front: 2500 }).regions[0]!;
    expect(r.front).toBe("t-1-r5");
    expect(r.nodes["t-1-r5"]!.top[2]).toBe(2500);
    expect(r.nodes["t-1-r4"]!.top[2]).toBe(pillarHeight(d.items.find((i) => i.id === "t-1-r4")!));
    expect(r.chevrons.length).toBeGreaterThan(1);
    const goalX = r.goal.ground[0];
    expect(r.chevrons.every((c) => c[1]![0] > r.nodes["t-1-r5"]!.ground[0] && c[1]![0] < goalX)).toBe(true);
    expect(layoutPanorama(d, { tight: true }).regions[0]!.front).toBe(null);
    const done = toPanorama({ topic, tasks: [task("t-1", NOW, { column: "done" })], sessions: [session("a", "t-1", NOW, "idle")], now: NOW });
    expect(layoutPanorama(done, { front: 2500 }).regions[0]!.chevrons).toEqual([]);
  });

  it("bends every road along one field with flow, keeping each going forward, and curls them out of the middle with spiral", () => {
    const d = data(long("t-1", 8, [2]), long("t-2", 5), long("t-3", 3, [], [2]), long("t-4", 12, [5]));
    const flow = layoutPanorama(d, { tight: true, curve: "flow" });
    for (const r of flow.regions) {
      const x = r.items.filter((i) => i.round !== null).map((i) => r.nodes[i.id]!.ground[0]);
      expect(x.every((v, i) => !i || v > x[i - 1]!)).toBe(true);
    }
    // Bent: the trunk is not one straight line any more.
    const ys = flow.regions[3]!.items.filter((i) => i.round !== null).map((i) => flow.regions[3]!.nodes[i.id]!.ground[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(5 * 0.001);
    const spiral = layoutPanorama(d, { tight: true, curve: "spiral" });
    for (const r of spiral.regions) {
      const dist = (p: number[]) => Math.hypot(p[0]!, p[1]!);
      expect(dist(r.goal.ground)).toBeGreaterThan(dist(r.origin.ground));
      const rr = r.items.filter((i) => i.round !== null).map((i) => dist(r.nodes[i.id]!.ground));
      expect(rr.every((v, i) => !i || v > rr[i - 1]!)).toBe(true);
    }
    // Arms leave the middle at different angles.
    const ang = spiral.regions.map((r) => Math.atan2(r.origin.ground[1], r.origin.ground[0]));
    expect(new Set(ang.map((a) => a.toFixed(2))).size).toBe(4);
  });

  it("reads looks from the preview's address", () => {
    expect(lookFrom("abd")).toEqual(LOOKS.abd);
    expect(lookFrom("abd-line")).toEqual({ ...LOOKS.abd, front: true, fold: true, span: true, blocks: true, curve: "line" });
    expect(lookFrom("abd-flow")).toEqual({ ...LOOKS.abd, front: true, fold: true, span: true, blocks: true, curve: "flow" });
    expect(lookFrom("spiral")).toEqual({ ...LOOKS.abd, front: true, fold: true, span: true, blocks: true, curve: "spiral" });
    expect(lookFrom("base-wave-nofold")).toEqual({ ...LOOKS.base, front: true, fold: false, span: true, blocks: true, curve: "wave" });
    expect(lookFrom("abd-line-noblocks")).toEqual({ ...LOOKS.abd, front: true, fold: true, span: true, blocks: false, curve: "line" });
    expect(lookFrom("abd-sideways")).toBe(null);
  });
});

describe("全景 0.3: topics and projects", () => {
  const mining: Topic = { id: "tp-m", title: "mining 迭代", workspaceIds: ["ws-c", "ws-d"], description: "11 月 20 日出 0.18 测试版\n\n更多说明", createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", archivedAt: null };
  const t = (id: string, ws: string, extra: Partial<Task> = {}) => task(id, "2026-10-25T00:00:00.000Z", { topicId: "tp-m", workspaceId: ws, ...extra });
  const s = (id: string, taskId: string | null, at: string, status: SessionStatus, extra: Partial<Session> = {}) => session(id, taskId as string, at, status, { taskId, ...extra });
  const input = () => ({
    topic,
    topics: [topic, mining],
    tasks: [task("t-a", "2026-10-30T01:00:00.000Z"), t("t-c1", "ws-c"), t("t-c2", "ws-c", { column: "review" }), t("t-s", "ws-s")],
    sessions: [
      s("s-a", "t-a", "2026-10-30T02:00:00.000Z", "idle"),
      s("lead-1", null, "2026-10-21T00:00:00.000Z", "idle", { topicId: "tp-m" }),
      s("lead-2", null, "2026-10-24T00:00:00.000Z", "running", { topicId: "tp-m" }),
      s("lead-sub", null, "2026-10-24T01:00:00.000Z", "completed", { topicId: "tp-m", kind: "sub" }),
      s("c1-1", "t-c1", "2026-10-25T01:00:00.000Z", "idle"),
      s("c1-2", "t-c1", "2026-10-26T01:00:00.000Z", "awaiting-approval"),
      s("c2-1", "t-c2", "2026-10-25T02:00:00.000Z", "idle"),
      s("s-1", "t-s", "2026-10-25T03:00:00.000Z", "running"),
    ],
    workspaces: [
      { id: "ws-c", name: "project_mining" },
      { id: "ws-s", name: "project_mining_server" },
    ],
    docs: [
      { id: "d-2", topicId: "tp-m", title: "版本规范", updatedAt: "2026-10-22T00:00:00.000Z", body: "# 版本规范\n\n版本号：主.次.修订。\n包体上限 **1.4 GB**。" },
      { id: "d-1", topicId: "tp-m", title: "0.18 范围说明", updatedAt: "2026-10-21T00:00:00.000Z" },
      { id: "d-x", topicId: "tp-other", title: "别的专题", updatedAt: "2026-10-21T00:00:00.000Z" },
    ],
    reviews: [{ id: "rv-1", topicId: "tp-m", num: 3, title: "掉落表要不要拆", status: "discuss" as const, sessionId: null, updatedAt: "2026-10-27T00:00:00.000Z" }],
    extra: {
      projects: { "tp-m/ws-c": { status: [{ label: "包体", value: "1.42 GB", tone: "warn" as const }], summary: "在瘦身", by: "专项管理 · 第 5 轮", updatedAt: "2026-11-01T00:00:00.000Z" } },
      proposedBy: { "t-c1": "lead-1", "t-c2": "lead-2", "t-s": "s-a" },
      cards: [
        { id: "k-1", topicId: "tp-m", sessionId: "c1-1", type: "finding" as const, title: "音效包没压缩", at: "2026-10-25T05:00:00.000Z" },
        { id: "k-2", topicId: "tp-m", type: "question" as const, title: "包体超了还发不发？", at: "2026-10-31T00:00:00.000Z", needsYou: true },
        { id: "k-3", topicId: "tp-m", sessionId: "lead-1", type: "decision" as const, title: "不做跨服", at: "2026-10-21T05:00:00.000Z" },
      ],
    },
    now: NOW,
  });

  it("makes a topic per topic, a project per workspace with the fields its spec asks for, the shelf and the spine", () => {
    const d = toPanorama(input());
    expect(d.topics.map((x) => [x.id, x.goal, x.status])).toEqual([
      ["tp-1", "这几天的迭代", "waiting"],
      ["tp-m", "11 月 20 日出 0.18 测试版 更多说明", "running"],
    ]);
    // Its tasks' workspaces in the order they came, then the topic's own (ws-d has no task yet).
    const pm = d.projects.filter((p) => p.topic === "tp-m");
    expect(pm.map((p) => [p.id, p.title])).toEqual([
      ["tp-m/ws-c", "project_mining"],
      ["tp-m/ws-s", "project_mining_server"],
      ["tp-m/ws-d", "ws-d"],
    ]);
    expect(pm[0]!.status).toEqual([{ label: "包体", value: "1.42 GB", tone: "warn" }, { label: "任务", value: "2 个 · 1 在跑" }]);
    expect([pm[0]!.summary, pm[0]!.by, pm[1]!.summary]).toEqual(["在瘦身", "专项管理 · 第 5 轮", null]);
    expect(pm[1]!.status).toEqual([{ label: "任务", value: "1 个 · 1 在跑" }]);
    expect(pm[2]!.status).toEqual([{ label: "任务", value: "0 个" }]);
    expect(boardLines(pm[0]!)).toBe(5);
    // Lanes know their topic and project.
    expect(d.lanes.map((l) => [l.id, l.topic, l.project])).toEqual([
      ["t-a", "tp-1", "tp-1/ws-1"],
      ["t-c1", "tp-m", "tp-m/ws-c"],
      ["t-c2", "tp-m", "tp-m/ws-c"],
      ["t-s", "tp-m", "tp-m/ws-s"],
    ]);
    // The shelf: by title, 规范 in the title makes a spec; the first lines without headings or marks.
    expect(d.docs.map((x) => [x.id, x.kind, x.summary])).toEqual([
      ["d-1", "doc", ""],
      ["d-2", "spec", "版本号：主.次.修订。 包体上限 1.4 GB。"],
    ]);
    // The spine: the topic's own sessions (no subagents), a round each; proposedBy only from the spine.
    const spine = d.items.filter((i) => i.topic === "tp-m" && i.type === "session" && i.lane === null);
    expect(spine.map((i) => [i.id, i.round])).toEqual([
      ["lead-1", 1],
      ["lead-2", 2],
    ]);
    expect(d.lanes.map((l) => l.proposedBy)).toEqual([null, "lead-1", "lead-2", null]);
  });

  it("puts points on a round when they came from it, else on the topic's board; review items by their status", () => {
    const d = toPanorama(input());
    const pts = d.items.filter((i) => i.type !== "session");
    expect(pts.map((i) => [i.id, i.type, i.status, i.lane, i.round, i.of])).toEqual([
      ["rv-1", "question", "waiting", null, null, null],
      ["k-1", "finding", "settled", "t-c1", 1, "c1-1"],
      ["k-2", "question", "needs_you", null, null, null],
      ["k-3", "decision", "settled", null, null, "lead-1"],
    ]);
    expect(pts[0]!.title).toBe("#3 掉落表要不要拆");
    // What waits on the person: the session asking for approval and the question.
    expect(needsYou(d).map((i) => i.id)).toEqual(expect.arrayContaining(["c1-2", "k-2"]));
    expect(needsYou(d)).toHaveLength(2);
  });

  it("lays each topic out as a block: bands that do not overlap, every task inside its band, lines from the spine", () => {
    const d = toPanorama(input());
    const L = layoutPanorama(d, { tight: true, curve: "line", span: true, fold: true, front: 2700, blocks: true });
    expect(L.blocks.map((b) => b.id)).toEqual(["tp-1", "tp-m"]);
    const [a, m] = [L.blocks[0]!, L.blocks[1]!];
    // Blocks apart from each other.
    const apart = (p: number[], q: number[]) => p[2]! < q[0]! || q[2]! < p[0]! || p[3]! < q[1]! || q[3]! < p[1]!;
    expect(apart(a.bounds, m.bounds)).toBe(true);
    expect(m.bands.map((b) => b.project.id)).toEqual(["tp-m/ws-c", "tp-m/ws-s", "tp-m/ws-d"]);
    const box = (pts: number[][]) => [Math.min(...pts.map((p) => p[0]!)), Math.min(...pts.map((p) => p[1]!)), Math.max(...pts.map((p) => p[0]!)), Math.max(...pts.map((p) => p[1]!))];
    const bands = m.bands.map((b) => box(b.fill));
    for (let i = 1; i < bands.length; i++) expect(bands[i]![3]!).toBeLessThan(bands[i - 1]![1]!);
    // Each task's base inside its project's band and inside the block.
    for (const r of L.regions.filter((r) => r.lane.topic === "tp-m")) {
      const band = bands[m.bands.findIndex((b) => b.project.id === r.lane.project)]!;
      expect(r.bounds[0]).toBeGreaterThanOrEqual(band[0]! - 1e-9);
      expect(r.bounds[2]).toBeLessThanOrEqual(m.bounds[2] + 1e-9);
      expect(r.bounds[3]).toBeLessThanOrEqual(band[3]! + 1e-9);
      expect(r.bounds[1]).toBeGreaterThanOrEqual(m.bounds[1] - 1e-9);
    }
    // The spine and its proposals: from lead-1 to t-c1's start, from lead-2 to t-c2's.
    expect(m.spine.nodes.map((n) => n.id)).toEqual(["lead-1", "lead-2"]);
    expect(m.proposed.map((p) => [p.item, p.lane])).toEqual([
      ["lead-1", "t-c1"],
      ["lead-2", "t-c2"],
    ]);
    const c1 = L.regions.find((r) => r.id === "t-c1")!;
    const end = m.proposed[0]!.path[m.proposed[0]!.path.length - 1]!;
    expect(Math.hypot(end[0] - c1.origin.ground[0], end[1] - c1.origin.ground[1])).toBeLessThan(0.5 * U);
    // The shelf and the board: two documents; the review item, the question and the decision of a spine round.
    expect(m.shelf.docs.map((x) => x.doc.id)).toEqual(["d-1", "d-2"]);
    expect(m.board.cards.map((c) => c.id)).toEqual(["rv-1", "k-2", "k-3"]);
    // Without blocks (or with spiral) nothing of this.
    expect(layoutPanorama(d, { tight: true, curve: "line" }).blocks).toEqual([]);
    expect(layoutPanorama(d, { tight: true, curve: "spiral", blocks: true }).blocks).toEqual([]);
  });

  it("puts live tasks in no topic into one more block, a band per project, only when asked and only when there are some", () => {
    const base = input();
    const free = [task("t-f1", "2026-10-28T00:00:00.000Z", { topicId: null, workspaceId: "ws-s" }), task("t-f2", "2026-10-29T00:00:00.000Z", { topicId: null, workspaceId: "ws-c" }), task("t-f3", "2026-10-29T00:00:00.000Z", { topicId: null, archivedAt: NOW })];
    const d = toPanorama({ ...base, tasks: [...base.tasks, ...free], loose: true });
    expect(d.topics.map((x) => [x.id, x.title])).toEqual([
      ["tp-1", "AMO迭代"],
      ["tp-m", "mining 迭代"],
      [LOOSE_TOPIC, LOOSE_TITLE],
    ]);
    expect(d.lanes.filter((l) => l.topic === LOOSE_TOPIC).map((l) => [l.id, l.project])).toEqual([
      ["t-f1", "loose/ws-s"],
      ["t-f2", "loose/ws-c"],
    ]);
    expect(d.projects.filter((p) => p.topic === LOOSE_TOPIC).map((p) => p.title)).toEqual(["project_mining_server", "project_mining"]);
    const L = layoutPanorama(d, { tight: true, curve: "line", span: true, fold: true, front: 2700, blocks: true });
    expect(L.blocks.map((b) => b.id)).toEqual(["tp-1", "tp-m", LOOSE_TOPIC]);
    expect(L.blocks[2]!.bands).toHaveLength(2);
    // Not asked (the preview's demo), or only archived ones: no block.
    expect(toPanorama({ ...base, tasks: [...base.tasks, ...free] }).topics.map((x) => x.id)).toEqual(["tp-1", "tp-m"]);
    expect(toPanorama({ ...base, tasks: [...base.tasks, free[2]!], loose: true }).topics.map((x) => x.id)).toEqual(["tp-1", "tp-m"]);
    // No topic at all: the loose block alone, once.
    expect(toPanorama({ topic: { ...topic, id: LOOSE_TOPIC, title: LOOSE_TITLE }, topics: [], tasks: free, sessions: [], loose: true, now: NOW }).topics.map((x) => x.id)).toEqual([LOOSE_TOPIC]);
  });
});
