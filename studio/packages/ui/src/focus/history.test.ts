import { describe, expect, it } from "vitest";
import { HISTORY_MAX, updateHistory, type Attention } from "./history.js";

const a = (key: string, label = "完成待审核"): Attention => ({ key, sessionId: key.split(":")[1] ?? key, taskId: "t", label });

describe("Focus history", () => {
  it("adds what comes on top, marks what left as handled, and keeps the record of each", () => {
    let h = updateHistory([], [a("s:1")], "2026-10-20T10:00:00Z");
    h = updateHistory(h, [a("s:1"), a("s:2", "等待审批")], "2026-10-20T10:01:00Z");
    expect(h.map((r) => [r.key, r.handledAt])).toEqual([
      ["s:2", null],
      ["s:1", null],
    ]);
    h = updateHistory(h, [a("s:2", "等待审批")], "2026-10-20T10:02:00Z");
    expect(h.find((r) => r.key === "s:1")).toMatchObject({ at: "2026-10-20T10:00:00Z", handledAt: "2026-10-20T10:02:00Z" });
    // The same session needing the person again later is a new record.
    h = updateHistory(h, [a("s:2", "等待审批"), a("s:1")], "2026-10-20T10:03:00Z");
    expect(h.filter((r) => r.key === "s:1").map((r) => r.handledAt)).toEqual([null, "2026-10-20T10:02:00Z"]);
  });

  it("keeps one record while a session waits, following what it now is", () => {
    let h = updateHistory([], [a("s:1", "等待审批")], "2026-10-20T10:00:00Z");
    h = updateHistory(h, [a("s:1", "完成待审核")], "2026-10-20T10:01:00Z");
    expect(h).toEqual([{ key: "s:1", sessionId: "1", taskId: "t", label: "完成待审核", at: "2026-10-20T10:00:00Z", handledAt: null }]);
  });

  it("leaves no record of a session that was working again within moments, but keeps one handled at once", () => {
    let h = updateHistory([], [a("s:1")], "2026-10-20T10:00:00.000Z");
    expect(updateHistory(h, [], "2026-10-20T10:00:01.000Z", () => true)).toEqual([]);
    h = updateHistory(h, [], "2026-10-20T10:00:01.000Z", () => false);
    expect(h).toMatchObject([{ key: "s:1", handledAt: "2026-10-20T10:00:01.000Z" }]);
  });

  it("keeps the newest few", () => {
    let h = updateHistory([], []);
    for (let i = 0; i < HISTORY_MAX + 5; i++) h = updateHistory(h, [a(`s:${i}`)], `2026-10-20T10:${String(i).padStart(2, "0")}:00Z`);
    expect(h).toHaveLength(HISTORY_MAX);
    expect(h[0]!.key).toBe(`s:${HISTORY_MAX + 4}`);
  });
});
