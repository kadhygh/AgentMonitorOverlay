import { describe, expect, it } from "vitest";
import { exampleSessions, type Session } from "@amo-studio/protocol";
import { awaitsPerson, hangsUnderOf, interruptedSince, markSeen, readSeen, subsByParent, unseenSessions, withGrants } from "./sessionSeen.js";

function memory(): Pick<Storage, "getItem" | "setItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const at = (id: string, status: Session["status"], updatedAt: string, extra: Partial<Session> = {}): Session => ({ ...exampleSessions[0]!, id, status, updatedAt, archivedAt: null, kind: "main", ...extra });

describe("sessions the person has not looked at", () => {
  it("starts keeping from now, so what ended before counts as seen", () => {
    const store = memory();
    const first = readSeen(store);
    expect(first.seen).toEqual({});
    expect(readSeen(store).since).toBe(first.since);
    const data = { since: "2026-10-15T08:00:00.000Z", seen: {} };
    expect(unseenSessions([at("old", "idle", "2026-10-15T07:00:00.000Z"), at("new", "idle", "2026-10-15T09:00:00.000Z")], data).map((s) => s.id)).toEqual(["new"]);
  });

  it("lists ended and failed replies newer than the last look, newest first; not running, archived or subagent ones", () => {
    const data = { since: "2026-10-15T08:00:00.000Z", seen: { looked: "2026-10-15T09:30:00.000Z", again: "2026-10-15T09:00:00.000Z" } };
    const sessions = [
      at("looked", "idle", "2026-10-15T09:10:00.000Z"),
      at("again", "completed", "2026-10-15T09:20:00.000Z"),
      at("failed", "error", "2026-10-15T09:40:00.000Z"),
      at("running", "running", "2026-10-15T09:50:00.000Z"),
      at("asking", "awaiting-approval", "2026-10-15T09:50:00.000Z"),
      at("archived", "idle", "2026-10-15T09:50:00.000Z", { archivedAt: "2026-10-15T09:55:00.000Z" }),
      at("sub", "completed", "2026-10-15T09:50:00.000Z", { kind: "sub" }),
    ];
    expect(unseenSessions(sessions, data).map((s) => s.id)).toEqual(["failed", "again"]);
  });

  it("marking a session seen clears it until its next reply ends", () => {
    const store = memory();
    store.setItem("amo.sessionSeen", JSON.stringify({ since: "2026-10-15T08:00:00.000Z", seen: {} }));
    const s = at("s", "idle", "2026-10-15T09:00:00.000Z");
    expect(unseenSessions([s], readSeen(store))).toHaveLength(1);
    markSeen(["s"], "2026-10-15T09:01:00.000Z", store);
    expect(unseenSessions([s], readSeen(store))).toHaveLength(0);
    expect(unseenSessions([{ ...s, updatedAt: "2026-10-15T09:05:00.000Z" }], readSeen(store))).toHaveLength(1);
  });

  it("a session waiting for its subagents has not finished; it has once the last one ends, even when looked at meanwhile", () => {
    const data = { since: "2026-10-21T08:00:00.000Z", seen: { lead: "2026-10-21T09:03:00.000Z" } };
    // The Claude session ended its turn right after starting two background agents (17:00:55 that day).
    const lead = at("lead", "idle", "2026-10-21T09:00:55.000Z");
    const one = at("one", "completed", "2026-10-21T09:06:40.000Z", { kind: "sub", parentId: "lead" });
    const two = at("two", "running", "2026-10-21T09:00:45.000Z", { kind: "sub", parentId: "lead" });
    expect(unseenSessions([lead, one, two], { ...data, seen: {} })).toEqual([]);
    expect(unseenSessions([lead, one, { ...two, status: "completed", updatedAt: "2026-10-21T09:07:29.000Z" }], data).map((s) => s.id)).toEqual(["lead"]);
    // An archived subagent counts for nothing.
    expect(unseenSessions([lead, { ...two, archivedAt: "2026-10-21T09:01:00.000Z" }], { ...data, seen: {} }).map((s) => s.id)).toEqual(["lead"]);
  });

  it("a session started with session_start and reporting back hangs under its live starter, like a subagent; on its own once the starter is archived (委派, 10-22)", () => {
    const data = { since: "2026-10-22T08:00:00.000Z", seen: { lead: "2026-10-22T09:03:00.000Z" } };
    const lead = at("lead", "idle", "2026-10-22T09:00:55.000Z");
    const kid = at("kid", "running", "2026-10-22T09:01:00.000Z", { startedBy: "lead", reportTo: "lead" });
    expect(subsByParent([lead, kid]).get("lead")?.map((s) => s.id)).toEqual(["kid"]);
    // While it runs, its starter has not finished; once it ends, the starter has (and the kid is not listed apart).
    expect(unseenSessions([lead, kid], { ...data, seen: {} })).toEqual([]);
    expect(unseenSessions([lead, { ...kid, status: "idle", updatedAt: "2026-10-22T09:08:00.000Z" }], data).map((s) => s.id)).toEqual(["lead"]);
    // Starter archived: a session of its own again.
    const gone = { ...lead, archivedAt: "2026-10-22T09:05:00.000Z" };
    expect(hangsUnderOf([gone, kid])(kid)).toBeNull();
    expect(unseenSessions([gone, { ...kid, status: "idle", updatedAt: "2026-10-22T09:08:00.000Z" }], data).map((s) => s.id)).toEqual(["kid"]);
  });

  it("a 委派 session that does not report back is listed itself when it ends, and its starter does not wait for it (2026-10-27)", () => {
    const data = { since: "2026-10-27T08:00:00.000Z", seen: { lead: "2026-10-27T09:03:00.000Z" } };
    const lead = at("lead", "idle", "2026-10-27T09:00:55.000Z");
    const kid = at("kid", "running", "2026-10-27T09:01:00.000Z", { startedBy: "lead" });
    // Still shown under its starter while it runs (the session list and 进行中).
    expect(subsByParent([lead, kid]).get("lead")?.map((s) => s.id)).toEqual(["kid"]);
    expect(unseenSessions([lead, kid], { ...data, seen: {} }).map((s) => s.id)).toEqual(["lead"]);
    // It ends: 完成待审核 is the kid itself, not the starter the person already looked at.
    expect(unseenSessions([lead, { ...kid, status: "idle", updatedAt: "2026-10-27T09:08:00.000Z" }], data).map((s) => s.id)).toEqual(["kid"]);
  });

  it("opening a session is coming to deal with it when it waits for the person or ended unseen", () => {
    const data = { since: "2026-10-21T08:00:00.000Z", seen: { seen: "2026-10-21T09:30:00.000Z" } };
    expect(awaitsPerson(at("asks", "awaiting-approval", "2026-10-21T09:00:00.000Z"), [], data)).toBe(true);
    expect(awaitsPerson(at("ended", "idle", "2026-10-21T09:00:00.000Z"), [], data)).toBe(true);
    expect(awaitsPerson(at("seen", "idle", "2026-10-21T09:00:00.000Z"), [], data)).toBe(false);
    expect(awaitsPerson(at("busy", "running", "2026-10-21T09:00:00.000Z"), [], data)).toBe(false);
    const lead = at("lead", "idle", "2026-10-21T09:00:00.000Z");
    expect(awaitsPerson(lead, [lead, at("sub", "running", "2026-10-21T09:00:00.000Z", { kind: "sub", parentId: "lead" })], data)).toBe(false);
  });

  it("starts again when the record cannot be read", () => {
    const store = memory();
    store.setItem("amo.sessionSeen", "{not json");
    expect(readSeen(store).seen).toEqual({});
  });

  it("counts the subagents cut off since the person last looked at their parent (2026-10-28)", () => {
    const parent = at("p", "idle", "2026-10-28T10:05:00.000Z");
    const old = at("s1", "interrupted", "2026-10-28T09:00:00.000Z", { kind: "sub", parentId: "p" });
    const fresh = at("s2", "interrupted", "2026-10-28T10:04:00.000Z", { kind: "sub", parentId: "p" });
    const done = at("s3", "completed", "2026-10-28T10:04:00.000Z", { kind: "sub", parentId: "p" });
    const data = { since: "2026-10-01T00:00:00.000Z", seen: { p: "2026-10-28T10:00:00.000Z" } };
    expect(interruptedSince(parent, [parent, old, fresh, done], data).map((s) => s.id)).toEqual(["s2"]);
  });
});

describe("a task granted from another computer (远程, 2026-11-04)", () => {
  it("counts what its sessions had before the grant as seen, and lists what ends after it", () => {
    const data = { since: "2026-10-01T00:00:00.000Z", seen: {} };
    const remote = { account: "a", device: "d_a", name: "A", state: "active" as const, profiles: [], allowed: [], grantedAt: "2026-11-04T10:00:00.000Z" };
    const tasks = [{ id: "copy", remote }, { id: "own" }];
    const sessions = [
      at("before", "idle", "2026-11-04T09:00:00.000Z", { taskId: "copy" }),
      at("after", "completed", "2026-11-04T10:05:00.000Z", { taskId: "copy" }),
      at("mine", "idle", "2026-11-04T09:00:00.000Z", { taskId: "own" }),
    ];
    expect(unseenSessions(sessions, withGrants(data, tasks, sessions)).map((s) => s.id)).toEqual(["after", "mine"]);
    // Nothing granted: the same record.
    expect(withGrants(data, [{ id: "own" }], sessions)).toBe(data);
  });
});

describe("the seen record kept small", () => {
  it("does not bring back the sessions it drops (2026-11-04)", () => {
    const store = memory();
    store.setItem("amo.sessionSeen", JSON.stringify({ since: "2026-10-01T00:00:00.000Z", seen: {} }));
    const iso = (i: number) => new Date(Date.UTC(2026, 9, 2) + i * 60_000).toISOString();
    // 501 sessions, each ended a minute before it was looked at.
    for (let i = 1; i <= 501; i++) markSeen([`s${i}`], iso(i), store);
    const data = readSeen(store);
    expect(Object.keys(data.seen)).toHaveLength(500);
    expect(data.seen.s1).toBeUndefined();
    expect(unseenSessions([at("s1", "idle", iso(0.5)), at("s501", "idle", iso(500.5))], data)).toEqual([]);
    expect(unseenSessions([at("later", "idle", iso(600))], data).map((s) => s.id)).toEqual(["later"]);
  });
});
