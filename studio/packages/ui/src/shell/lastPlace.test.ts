import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPlace, rememberSession, savePlace } from "./lastPlace.js";

const store = new Map<string, string>();
const fake = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

describe("last place", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = fake;
  });
  afterEach(() => {
    store.clear();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("starts on the board, everything in scope", () => {
    expect(readPlace()).toEqual({ view: { kind: "board" }, scope: { kind: "all" } });
  });

  it("comes back to a task on the session last looked at, and where its ← goes", () => {
    savePlace({ kind: "task", taskId: "t1", nav: 5, created: true, back: { kind: "canvas" } }, { kind: "topic", id: "p1" });
    rememberSession("t1", "s2");
    rememberSession("t9", "s9");
    expect(readPlace()).toEqual({ view: { kind: "task", taskId: "t1", sessionId: "s2", back: { kind: "canvas" } }, scope: { kind: "topic", id: "p1" } });
  });

  it("comes back to the canvas; other pages come back as the board", () => {
    savePlace({ kind: "canvas" }, { kind: "workspace", id: "w1" });
    expect(readPlace().view).toEqual({ kind: "canvas" });
    savePlace({ kind: "packs", workspaceId: "w1" }, { kind: "all" });
    expect(readPlace().view).toEqual({ kind: "board" });
  });

  it("keeps the most recent hundred tasks' sessions", () => {
    for (let i = 0; i < 105; i++) rememberSession(`t${i}`, `s${i}`);
    rememberSession("t3", "again");
    const kept = JSON.parse(store.get("amo.lastSessions")!) as Record<string, string>;
    expect(Object.keys(kept)).toHaveLength(100);
    expect(kept.t3).toBe("again");
    expect(kept.t4).toBeUndefined();
  });
});
