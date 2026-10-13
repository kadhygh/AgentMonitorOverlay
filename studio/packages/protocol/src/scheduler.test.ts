import { describe, expect, it } from "vitest";
import type { Session } from "./entities.js";
import { exampleSessions } from "./examples.js";
import { workspaceActivity, workspacesActivity } from "./scheduler.js";

const base = exampleSessions[0]!;
const s = (over: Partial<Session>): Session => ({ ...base, id: `s-${Math.random()}`, workspaceId: "w1", status: "idle", writer: "workbench", archivedAt: null, ...over });

describe("workspace activity", () => {
  it("is idle when nothing in the workspace runs or waits for the person", () => {
    expect(workspaceActivity("w1", [s({}), s({ status: "completed" }), s({ status: "error" })])).toEqual({ workspaceId: "w1", idle: true, busy: 0 });
  });

  it("is busy while a session runs, waits for approval or review, or is in a terminal", () => {
    for (const over of [{ status: "running" }, { status: "awaiting-approval" }, { status: "awaiting-review" }, { writer: "terminal-handoff" }, { writer: "terminal-shared" }] as Partial<Session>[]) {
      expect(workspaceActivity("w1", [s(over)]).idle, JSON.stringify(over)).toBe(false);
    }
  });

  it("ignores archived sessions and other workspaces", () => {
    const sessions = [s({ status: "running", archivedAt: "2026-10-14T00:00:00Z" }), s({ status: "running", workspaceId: "w2" }), s({ status: "awaiting-approval", workspaceId: "w2" })];
    const all = workspacesActivity([{ id: "w1" }, { id: "w2" }] as never, sessions);
    expect(all.get("w1")).toEqual({ workspaceId: "w1", idle: true, busy: 0 });
    expect(all.get("w2")).toEqual({ workspaceId: "w2", idle: false, busy: 2 });
  });
});
