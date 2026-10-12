import { describe, expect, it } from "vitest";
import { TASK_COLUMNS, type SessionItem } from "./entities.js";
import { exampleItems, exampleSessions, exampleTasks } from "./examples.js";
import { buildSessionTree, collectSubtreeIds } from "./session-tree.js";

describe("example data", () => {
  it("uses only known board columns", () => {
    for (const task of exampleTasks) expect(TASK_COLUMNS).toContain(task.column);
  });

  it("keeps item seq monotonic per session", () => {
    const last = new Map<string, number>();
    for (const item of exampleItems) {
      expect(item.seq).toBeGreaterThan(last.get(item.sessionId) ?? 0);
      last.set(item.sessionId, item.seq);
    }
  });

  it("points subagent items at existing sessions", () => {
    const ids = new Set(exampleSessions.map((s) => s.id));
    const subs = exampleItems.filter((i): i is Extract<SessionItem, { type: "subagent" }> => i.type === "subagent");
    for (const item of subs) expect(ids).toContain(item.childSessionId);
  });
});

describe("buildSessionTree", () => {
  it("nests forks and subagents under their parents in creation order", () => {
    const tree = buildSessionTree(exampleSessions);
    expect(tree.map((n) => n.session.id)).toEqual(["s-main", "s-second"]);
    expect(tree[0]!.children.map((n) => n.session.id)).toEqual(["s-fork"]);
    expect(tree[0]!.children[0]!.children.map((n) => n.session.id)).toEqual(["s-sub"]);
  });

  it("treats sessions with a missing parent as roots", () => {
    const orphan = { ...exampleSessions[1]!, id: "s-orphan", parentId: "gone" };
    expect(buildSessionTree([orphan]).map((n) => n.session.id)).toEqual(["s-orphan"]);
  });
});

describe("collectSubtreeIds", () => {
  it("returns the session and all descendants", () => {
    expect(collectSubtreeIds(exampleSessions, "s-main")).toEqual(["s-main", "s-fork", "s-sub"]);
    expect(collectSubtreeIds(exampleSessions, "s-second")).toEqual(["s-second"]);
  });

  it("returns nothing for an unknown id and survives cycles", () => {
    expect(collectSubtreeIds(exampleSessions, "nope")).toEqual([]);
    const a = { ...exampleSessions[0]!, id: "a", parentId: "b" };
    const b = { ...exampleSessions[0]!, id: "b", parentId: "a" };
    expect(collectSubtreeIds([a, b], "a")).toEqual(["a", "b"]);
  });
});
