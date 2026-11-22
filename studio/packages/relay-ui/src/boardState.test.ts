import { describe, expect, it } from "vitest";
import { applyRecords, emptyBoard, fitView, fromSnapshot, groupAt, lockedBy, moveOps, nextUndo, setLock, zoomAt } from "./boardState.js";
import type { BoardItem, BoardOpRecord } from "./shared.js";

const card = (id: string, f: Partial<BoardItem> = {}): BoardItem => ({ id, kind: "note", x: 0, y: 0, w: 200, h: 100, color: null, text: "", group: null, session: null, ref: null, from: null, to: null, stale: false, version: 1, textVersion: 1, alt: null, createdBy: "小王", createdAt: 1, updatedBy: "小王", updatedAgent: null, updatedAt: 1, deleted: false, deletedBy: null, deletedAt: null, ...f });
const rec = (seq: number, items: BoardItem[], f: Partial<BoardOpRecord> = {}): BoardOpRecord => ({ seq, opId: null, op: "set", actor: "小王", agent: null, at: seq, items, changes: [], undoOf: null, conflict: false, ...f });
let n = 0;
const opId = () => `o${++n}`;

describe("协作's board as this client holds it", () => {
  it("takes a full snapshot, then operations; an older card version never wins", () => {
    let m = fromSnapshot(emptyBoard(), { seq: 3, full: true, items: [card("a", { version: 2 })], locks: [] }, "小王");
    m = applyRecords(m, [rec(5, [card("a", { version: 4, text: "新" })]), rec(4, [card("a", { version: 3, text: "旧" })])], "小周");
    expect(m.items.a).toMatchObject({ version: 4, text: "新" });
    expect(m.seq).toBe(5);
  });

  it("keeps my own operations to undo, and an undo takes its target off", () => {
    let m = applyRecords(emptyBoard(), [rec(1, [card("a")]), rec(2, [card("a", { version: 2 })], { actor: "小周" }), rec(3, [card("a", { version: 3 })], { agent: "studio:d:s" })], "小王");
    expect(m.mine).toEqual([1]);
    expect(nextUndo(m)).toBe(1);
    m = applyRecords(m, [rec(4, [card("a", { version: 4 })], { op: "undo", undoOf: 1 })], "小王");
    expect(nextUndo(m)).toBeNull();
  });

  it("knows who is writing a card, until the lock runs out", () => {
    const m = setLock(emptyBoard(), "a", { card: "a", by: "小周", until: 2000 });
    expect(lockedBy(m, "a", "小王", 1000)).toBe("小周");
    expect(lockedBy(m, "a", "小周", 1000)).toBeNull();
    expect(lockedBy(m, "a", "小王", 3000)).toBeNull();
    expect(lockedBy(setLock(m, "a", null), "a", "小王", 1000)).toBeNull();
  });

  it("drops a card into the group under its centre; a group moved takes its cards along", () => {
    const g = card("g", { kind: "group", x: 0, y: 0, w: 600, h: 400 });
    let m = applyRecords(emptyBoard(), [rec(1, [g, card("a", { x: 700, y: 0 }), card("b", { x: 20, y: 40, group: "g" })])], "x");
    expect(groupAt(m, 100, 100)).toBe("g");
    expect(moveOps(m, "a", 50, 50, opId)).toEqual([{ op: "set", opId: expect.any(String), id: "a", base: 1, fields: { x: 50, y: 50, group: "g" } }]);
    expect(moveOps(m, "b", 900, 900, opId)[0]).toMatchObject({ fields: { x: 900, y: 900, group: null } });
    const ops = moveOps(m, "g", 100, 10, opId);
    expect(ops.map((o) => (o.op === "set" ? [o.id, o.fields] : null))).toEqual([
      ["g", { x: 100, y: 10 }],
      ["b", { x: 120, y: 50 }],
    ]);
    m = applyRecords(m, [rec(2, [card("a", { deleted: true, version: 2 })])], "x");
    expect(groupAt(m, 100, 100, "g")).toBeNull();
  });

  it("zooms around the pointer and fits everything in view", () => {
    const v = zoomAt({ x: 0, y: 0, k: 1 }, 2, { x: 100, y: 100 });
    expect(v).toEqual({ k: 2, x: -100, y: -100 });
    expect(zoomAt({ x: 0, y: 0, k: 2 }, 2, { x: 0, y: 0 }).k).toBe(2);
    const m = applyRecords(emptyBoard(), [rec(1, [card("a", { x: 0, y: 0, w: 400, h: 200 })])], "x");
    expect(fitView(m, { w: 1000, h: 600 })).toEqual({ k: 1, x: 300, y: 200 });
  });
});
