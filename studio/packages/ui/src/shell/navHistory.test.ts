import { describe, expect, it } from "vitest";
import { EMPTY, MAX, noteScroll, pickSession, step, visit, type NavState, type Place } from "./navHistory.js";

const all = { kind: "all" } as const;
const task = (taskId: string, sessionId?: string): Place => ({ view: { kind: "task", taskId, ...(sessionId ? { sessionId } : {}) }, scope: all });
const board: Place = { view: { kind: "board" }, scope: all };
const alive = () => true;

describe("后退 / 前进 history", () => {
  it("puts the place left on the back list; the same place again is not a step", () => {
    let s: NavState = visit(EMPTY, board);
    s = visit(s, task("t1", "s1"));
    s = visit(s, task("t1", "s1"));
    expect(s.back).toEqual([board]);
    expect(s.current).toEqual(task("t1", "s1"));
    // Another scope is another place.
    s = visit(s, { view: { kind: "board" }, scope: { kind: "topic", id: "p1" } });
    expect(s.back).toHaveLength(2);
  });

  it("fills in the session a task page opened on; another session is a step of its own", () => {
    let s = visit(visit(EMPTY, board), task("t1"));
    s = pickSession(s, "t1", "s1");
    expect(s.current).toEqual(task("t1", "s1"));
    expect(s.back).toEqual([board]);
    s = pickSession(s, "t1", "s2");
    expect(s.current).toEqual(task("t1", "s2"));
    expect(s.back).toEqual([board, task("t1", "s1")]);
    // A page that picks its session before its place is recorded: the place gets it when it comes.
    s = pickSession(s, "t9", "s9");
    expect(s.current).toEqual(task("t1", "s2"));
    s = visit(s, task("t9"));
    expect(s.current).toEqual(task("t9", "s9"));
    expect(s.picked).toBeUndefined();
  });

  it("notes how far the current session was read, and keeps it when the place is left and come back to", () => {
    let s = visit(EMPTY, task("t1", "s1"));
    s = noteScroll(s, "s1", 420);
    expect(noteScroll(s, "s2", 10)).toBe(s);
    s = visit(s, task("t2", "s5"));
    const back = step(s, -1, alive)!;
    expect(back.place).toEqual({ ...task("t1", "s1"), scroll: 420 });
  });

  it("goes back and forward; going somewhere new drops the forward list", () => {
    let s = visit(visit(visit(EMPTY, board), task("t1", "s1")), task("t2", "s2"));
    const b1 = step(s, -1, alive)!;
    expect(b1.place).toEqual(task("t1", "s1"));
    const b2 = step(b1.state, -1, alive)!;
    expect(b2.place).toEqual(board);
    expect(step(b2.state, -1, alive)).toBeNull();
    const f1 = step(b2.state, 1, alive)!;
    expect(f1.place).toEqual(task("t1", "s1"));
    s = visit(f1.state, task("t3", "s3"));
    expect(s.forward).toEqual([]);
    expect(step(s, 1, alive)).toBeNull();
  });

  it("skips (and drops) places that are gone", () => {
    const s = visit(visit(visit(EMPTY, board), task("gone", "s1")), task("t2", "s2"));
    const r = step(s, -1, (p) => !(p.view.kind === "task" && p.view.taskId === "gone"))!;
    expect(r.place).toEqual(board);
    expect(r.state.back).toEqual([]);
    expect(r.state.forward).toEqual([task("t2", "s2")]);
  });

  it(`keeps at most ${MAX} places back`, () => {
    let s = EMPTY;
    for (let i = 0; i < MAX + 10; i++) s = visit(s, task(`t${i}`, "s"));
    expect(s.back).toHaveLength(MAX);
    expect(s.back[0]).toEqual(task("t9", "s"));
  });
});
