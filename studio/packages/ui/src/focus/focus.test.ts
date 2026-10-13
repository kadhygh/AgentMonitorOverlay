import { describe, expect, it } from "vitest";
import { exampleItems, exampleSessions, exampleTasks, exampleWorkspaces, type SessionItem, type StateSnapshot } from "@amo-studio/protocol";
import { latestSnippet, needsMe } from "./FocusApp.js";

describe("Focus", () => {
  it("lists live sessions waiting for approval or review, newest first", () => {
    const sessions = [
      { ...exampleSessions[0]!, id: "a", status: "awaiting-approval" as const, updatedAt: "2026-10-01T00:00:00Z" },
      { ...exampleSessions[0]!, id: "b", status: "awaiting-review" as const, updatedAt: "2026-10-02T00:00:00Z" },
      { ...exampleSessions[0]!, id: "c", status: "running" as const, updatedAt: "2026-10-03T00:00:00Z" },
      { ...exampleSessions[0]!, id: "d", status: "awaiting-review" as const, updatedAt: "2026-10-04T00:00:00Z", archivedAt: "2026-10-05T00:00:00Z" },
    ];
    const state = { workspaces: exampleWorkspaces, tasks: exampleTasks, sessions, profiles: [] } as unknown as StateSnapshot;
    expect(needsMe(state).map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("shows the pending approval, else the latest reply, shortened", () => {
    const pending = latestSnippet(exampleItems.filter((i) => i.sessionId === "s-main"));
    expect(pending.approval?.approvalId).toBe("0");
    expect(pending.text).toBe("npm test");
    const long: SessionItem[] = [
      { id: "x", sessionId: "s", seq: 1, createdAt: "2026-10-01T00:00:00Z", type: "agent", markdown: "早先的回复", streaming: false },
      { id: "y", sessionId: "s", seq: 2, createdAt: "2026-10-01T00:00:00Z", type: "agent", markdown: "长".repeat(400), streaming: false },
    ];
    const reply = latestSnippet(long);
    expect(reply.approval).toBeNull();
    expect(reply.text).toBe(`${"长".repeat(300)}…`);
  });

  it("lists sessions waiting for an answer and shows what was asked", () => {
    const sessions = [{ ...exampleSessions[0]!, id: "q", status: "awaiting-answer" as const }];
    const state = { workspaces: exampleWorkspaces, tasks: exampleTasks, sessions, profiles: [] } as unknown as StateSnapshot;
    expect(needsMe(state).map((s) => s.id)).toEqual(["q"]);
    const base = { sessionId: "q", seq: 1, createdAt: "2026-10-01T00:00:00Z" };
    const asked: SessionItem[] = [
      { ...base, id: "a", type: "question", source: "claude-ask", state: "pending", questions: [{ id: "x", question: "怎么重试？", options: [] }, { id: "y", question: "记什么？", options: [] }] },
    ];
    expect(latestSnippet(asked)).toEqual({ text: "怎么重试？\n记什么？", approval: null });
    const plan: SessionItem[] = [{ ...base, id: "p", type: "question", source: "plan-review", state: "pending", plan: "# 加重试\n正文" }];
    expect(latestSnippet(plan).text).toBe("计划待审：加重试");
  });
});
