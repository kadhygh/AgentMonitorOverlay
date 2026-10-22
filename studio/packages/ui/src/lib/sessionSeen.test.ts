import { describe, expect, it } from "vitest";
import { exampleSessions, type Session } from "@amo-studio/protocol";
import { awaitsPerson, hangsUnderOf, markSeen, readSeen, subsByParent, unseenSessions } from "./sessionSeen.js";

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

  it("a session started with session_start hangs under its live starter, like a subagent; on its own once the starter is archived (委派, 10-22)", () => {
    const data = { since: "2026-10-22T08:00:00.000Z", seen: { lead: "2026-10-22T09:03:00.000Z" } };
    const lead = at("lead", "idle", "2026-10-22T09:00:55.000Z");
    const kid = at("kid", "running", "2026-10-22T09:01:00.000Z", { startedBy: "lead" });
    expect(subsByParent([lead, kid]).get("lead")?.map((s) => s.id)).toEqual(["kid"]);
    // While it runs, its starter has not finished; once it ends, the starter has (and the kid is not listed apart).
    expect(unseenSessions([lead, kid], { ...data, seen: {} })).toEqual([]);
    expect(unseenSessions([lead, { ...kid, status: "idle", updatedAt: "2026-10-22T09:08:00.000Z" }], data).map((s) => s.id)).toEqual(["lead"]);
    // Starter archived: a session of its own again.
    const gone = { ...lead, archivedAt: "2026-10-22T09:05:00.000Z" };
    expect(hangsUnderOf([gone, kid])(kid)).toBeNull();
    expect(unseenSessions([gone, { ...kid, status: "idle", updatedAt: "2026-10-22T09:08:00.000Z" }], data).map((s) => s.id)).toEqual(["kid"]);
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
});
