import { describe, expect, it } from "vitest";
import { exampleSessions } from "@amo-studio/protocol";
import { liveDecisions } from "./decisions.js";

describe("liveDecisions", () => {
  const [one, two] = exampleSessions;
  const open = [
    { id: "d-1", sessionId: one!.id },
    { id: "d-2", sessionId: two!.id },
    { id: "d-3", sessionId: "s-gone" },
  ];
  const ids = (sessions: typeof exampleSessions) => liveDecisions(open, sessions).map((d) => d.id);

  it("leaves out the 提问 of a session that is archived or not there", () => {
    expect(ids(exampleSessions)).toEqual(["d-1", "d-2"]);
    expect(ids(exampleSessions.map((s) => (s.id === two!.id ? { ...s, archivedAt: "2026-11-25T00:00:00Z" } : s)))).toEqual(["d-1"]);
    expect(ids([])).toEqual([]);
  });

  it("counts it again once the session is unarchived: the list itself is not changed", () => {
    const archived = exampleSessions.map((s) => ({ ...s, archivedAt: "2026-11-25T00:00:00Z" }));
    expect(ids(archived)).toEqual([]);
    expect(ids(archived.map((s) => ({ ...s, archivedAt: null })))).toEqual(["d-1", "d-2"]);
    expect(open).toHaveLength(3);
  });
});
