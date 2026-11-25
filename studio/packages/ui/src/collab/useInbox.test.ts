import { describe, expect, it } from "vitest";
import { exampleSessions, exampleTasks, type HostEvent } from "@amo-studio/protocol";
import { touchesPending } from "./useInbox.js";

// 待我处理 leaves out messages whose recipient is archived (host features/collab/matters.ts pendingView): the page reads
// the list again after what can archive or restore one.
describe("touchesPending", () => {
  const session = (over: Partial<(typeof exampleSessions)[number]>): HostEvent => ({ seq: 1, type: "session.upserted", session: { ...exampleSessions[0]!, ...over } });

  it("reads again when a task changes, or a session that is not in a turn (archived, restored)", () => {
    expect(touchesPending({ seq: 1, type: "task.upserted", task: exampleTasks[0]! })).toBe(true);
    expect(touchesPending(session({ status: "idle", archivedAt: "2026-11-25T00:00:00Z" }))).toBe(true);
    expect(touchesPending(session({ status: "idle", archivedAt: null }))).toBe(true);
  });

  it("not for every update of a running session", () => {
    expect(touchesPending(session({ status: "running" }))).toBe(false);
    expect(touchesPending({ seq: 1, type: "item.delta", sessionId: "s", itemId: "i", append: "x" })).toBe(false);
  });
});
