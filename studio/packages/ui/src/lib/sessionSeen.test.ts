import { describe, expect, it } from "vitest";
import { exampleSessions, type Session } from "@amo-studio/protocol";
import { markSeen, readSeen, unseenSessions } from "./sessionSeen.js";

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

  it("starts again when the record cannot be read", () => {
    const store = memory();
    store.setItem("amo.sessionSeen", "{not json");
    expect(readSeen(store).seen).toEqual({});
  });
});
