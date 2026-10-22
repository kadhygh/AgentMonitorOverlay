import { describe, expect, it } from "vitest";
import { exampleSessions, type Session } from "@amo-studio/protocol";
import { pinnedSession, ranFor } from "./pins.js";

const at = (id: string, updatedAt: string, extra: Partial<Session> = {}): Session => ({ ...exampleSessions[0]!, id, taskId: "t", updatedAt, archivedAt: null, kind: "main", ...extra });

describe("Focus 置顶", () => {
  it("shows the task's latest live session that is not a subagent", () => {
    const sessions = [
      at("old", "2026-10-21T08:00:00.000Z"),
      at("fork", "2026-10-21T09:00:00.000Z", { kind: "fork" }),
      at("sub", "2026-10-21T10:00:00.000Z", { kind: "sub" }),
      at("gone", "2026-10-21T11:00:00.000Z", { archivedAt: "2026-10-21T11:00:00.000Z" }),
      at("other", "2026-10-21T12:00:00.000Z", { taskId: "u" }),
    ];
    expect(pinnedSession({ id: "t" }, sessions)?.id).toBe("fork");
    expect(pinnedSession({ id: "none" }, sessions)).toBeUndefined();
  });

  it("shows the session that waits for the person first, then one that runs (10-22)", () => {
    const sessions = [
      at("latest", "2026-10-21T12:00:00.000Z", { status: "idle" }),
      at("runs", "2026-10-21T10:00:00.000Z", { status: "running" }),
      at("asks", "2026-10-21T09:00:00.000Z", { status: "awaiting-approval" }),
    ];
    expect(pinnedSession({ id: "t" }, sessions)?.id).toBe("asks");
    expect(pinnedSession({ id: "t" }, sessions.slice(0, 2))?.id).toBe("runs");
  });

  it("says how long a subagent has run", () => {
    const now = Date.parse("2026-10-21T09:10:00.000Z");
    expect(ranFor("2026-10-21T09:09:20.000Z", now)).toBe("已跑 40 秒");
    expect(ranFor("2026-10-21T09:05:00.000Z", now)).toBe("已跑 5 分钟");
    expect(ranFor("2026-10-21T07:55:00.000Z", now)).toBe("已跑 1 小时 15 分");
  });
});
