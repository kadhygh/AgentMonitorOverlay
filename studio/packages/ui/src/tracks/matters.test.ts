import { describe, expect, it } from "vitest";
import type { DecisionRequest, Session, SessionItem, TeamThread } from "@amo-studio/protocol";
import { sessionMatters } from "./matters.js";

const NOW = Date.parse("2026-11-15T10:00:00Z");
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const session = (id: string, over: Partial<Session> = {}): Session => ({ id, taskId: "t1", kind: "main", parentId: null, title: id, status: "idle", createdAt: iso(120), updatedAt: iso(10), ...over }) as Session;
const item = (id: string, body: Record<string, unknown>): SessionItem => ({ id, sessionId: "main", seq: 1, createdAt: iso(5), ...body }) as unknown as SessionItem;
const thread = (id: string, over: Partial<TeamThread> = {}): TeamThread => ({ threadId: id, sessionId: "main", title: "背包上限放哪", to: "程序老李", state: "open", since: NOW - 2 * 3_600_000, deliveredAt: null, ...over });

describe("a session's matters", () => {
  const main = session("main");

  it("lists what it asked through 中转, the sessions it started and what waits for the person; the person's first, ended ones last", () => {
    const sessions = [
      main,
      session("runner", { title: "测首帧", startedBy: "main", status: "running", updatedAt: iso(12) }),
      session("done", { title: "数表", startedBy: "main", status: "idle" }),
      session("elsewhere", { title: "别人开的", startedBy: "other" }),
      session("agent", { kind: "sub", parentId: "main", title: "Explore", status: "running", createdAt: iso(3) }),
      session("agent-done", { kind: "sub", parentId: "main", title: "Plan", status: "completed" }),
    ];
    const items = [
      item("u1", { type: "user", text: "把上限改成可配置" }),
      item("r1", { type: "user", text: "【你开的会话「数表」（done）这一轮做完了】\n有 3 张表", origin: { kind: "report", from: "数表", sessionId: "done", state: "done" } }),
      item("a1", { type: "approval", approvalId: "ap", kind: "command", summary: "npm run build", state: "pending", createdAt: iso(4) }),
      item("a0", { type: "approval", approvalId: "ap0", kind: "command", summary: "git status", state: "accepted" }),
      item("h1", { type: "user", text: "【中转回复】\n\n王五：可以", delivery: "held", origin: { kind: "team", from: "王五", threadIds: ["th-back"] } }),
    ];
    const threads = [thread("th-open"), thread("th-back", { to: "王五", title: "掉落表要不要拆", state: "returned", since: NOW - 3 * 60_000 }), thread("th-done", { state: "done", takenAt: NOW }), thread("th-other", { sessionId: "another" })];
    const decisions = [{ id: "d1", sessionId: "main", taskId: "t1", question: "先做哪个？", options: [], state: "open", answer: null, createdAt: iso(1), answeredAt: null } as DecisionRequest];
    const list = sessionMatters({ session: main, sessions, threads, items, decisions, now: NOW });

    expect(list.map((m) => [m.key, m.state, m.open])).toEqual([
      ["decision:d1", "you", true],
      ["approval:a1", "you", true],
      ["held", "you", true],
      ["team:th-back", "back", true],
      ["sub:agent", "run", true],
      ["session:runner", "run", true],
      ["team:th-open", "wait", true],
      // Ended ones: the latest first.
      ["session:done", "done", false],
      ["team:th-done", "done", false],
    ]);
    const by = (key: string) => list.find((m) => m.key === key)!;
    expect(by("team:th-open")).toMatchObject({ title: "问 程序老李：背包上限放哪", note: "等 程序老李 回复 · 2 小时" });
    // A click on a matter goes to what came back for it in this conversation, or to the session that works on it.
    expect(by("team:th-back")).toMatchObject({ itemId: "h1", note: "王五 回复了 · 3 分钟前，还没送进会话" });
    expect(by("session:done")).toMatchObject({ itemId: "r1", sessionId: "done", note: "这一轮做完了，结果已回到这里" });
    expect(by("session:runner")).toMatchObject({ sessionId: "runner", note: "在跑 · 12 分钟" });
    expect(by("approval:a1")).toMatchObject({ title: "等你审批：npm run build", itemId: "a1" });
    expect(by("team:th-done").note).toBe("程序老李 已接手，不用回复");
  });

  it("reads reports from before rows said who they are from", () => {
    const sessions = [main, session("old", { title: "旧的", startedBy: "main", status: "error" })];
    const items = [item("r0", { type: "user", text: "【你开的会话「旧的」（old）出错停下了】\nboom" })];
    const [m] = sessionMatters({ session: main, sessions, threads: [], items, decisions: [], now: NOW });
    expect(m).toMatchObject({ key: "session:old", state: "failed", open: true, itemId: "r0" });
  });

  it("is empty for a session that only talks with the person", () => {
    expect(sessionMatters({ session: main, sessions: [main], threads: [], items: [item("u1", { type: "user", text: "你好" })], decisions: [], now: NOW })).toEqual([]);
  });
});
