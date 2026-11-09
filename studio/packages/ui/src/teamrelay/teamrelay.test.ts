import { describe, expect, it } from "vitest";
import type { TeamThread } from "@amo-studio/protocol";
import { TAKEN_SHOWN_MS, teamTaken, teamWaits } from "./TeamRelay.js";

const now = 1_000_000_000;
const thread = (threadId: string, over: Partial<TeamThread>): TeamThread => ({ threadId, sessionId: "s1", title: threadId, to: "dhy", state: "open", since: now - 120_000, deliveredAt: null, takenAt: null, ...over });

describe("中转 lines on a task", () => {
  const threads = [
    thread("wait", {}),
    thread("taken", { state: "done", takenAt: now - 60_000 }),
    thread("old", { state: "done", takenAt: now - TAKEN_SHOWN_MS - 1 }),
    thread("elsewhere", { sessionId: "s2", state: "done", takenAt: now - 1 }),
  ];
  const sessions = [{ id: "s1" }];
  it("waits on whom, and what was taken on in the last day", () => {
    expect(teamWaits(threads, sessions, now)).toEqual(["等 dhy 回复（中转）· 已等 2 分钟"]);
    expect(teamTaken(threads, sessions, now).map((t) => t.threadId)).toEqual(["taken"]);
  });
  it("leaves out the taken ones put away with 知道了 (2026-11-09)", () => {
    expect(teamTaken(threads, sessions, now, ["taken"])).toEqual([]);
  });
});
