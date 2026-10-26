import { describe, expect, it } from "vitest";
import { addDependency, addGroupAuto, addItems, CanvasLayoutError, findItem, ITEM_CARD, LAYOUT, placeNewGroup, placeTask, refsToCard, removeTask, unplaceTask } from "./canvas-layout.js";
import { emptyCanvas, validateCanvas } from "./canvas.js";
import type { CanvasDoc } from "./entities.js";

const doc = (over: Partial<CanvasDoc> = {}): CanvasDoc => ({ ...emptyCanvas(), ...over });

describe("canvas layout for agent changes", () => {
  it("puts a new group to the right of everything, aligned with the first group", () => {
    expect(placeNewGroup(doc())).toEqual({ x: 40, y: 64, w: 500, h: 320 });
    const one = addGroupAuto(doc(), { id: "g1", title: "导入", workspaceId: null });
    const two = addGroupAuto({ ...one, nodes: [{ id: "n1", kind: "note", text: "x", groupId: null, pos: { x: 700, y: 500 } }] }, { id: "g2", title: "配置", workspaceId: null });
    expect(two.groups[1]!.rect).toEqual({ x: 700 + LAYOUT.card.w + 40, y: 64, w: 500, h: 320 });
  });

  it("fills a group row by row and grows it when full", () => {
    let d = addGroupAuto(doc(), { id: "g1", title: "导入", workspaceId: null });
    for (const t of ["a", "b", "c", "d", "e", "f", "g", "h"]) d = placeTask(d, t, "g1", `n-${t}`);
    const pos = (t: string) => d.nodes.find((n) => n.kind === "task" && n.taskId === t)!.pos;
    expect(pos("a")).toEqual({ x: 52, y: 64 + 30 + 12 });
    expect(pos("b")).toEqual({ x: 52 + 236, y: 106 });
    expect(pos("c")).toEqual({ x: 52, y: 106 + 82 }); // two cards per row in a 500-wide group
    const g = d.groups[0]!.rect;
    expect(g.y + g.h).toBeGreaterThanOrEqual(pos("h").y + LAYOUT.card.h + LAYOUT.pad);
    expect(d.nodes.every((n) => n.groupId === "g1")).toBe(true);
  });

  it("takes a card out of its group to below everything, and keeps one card per task", () => {
    let d = addGroupAuto(doc(), { id: "g1", title: "导入", workspaceId: null });
    d = placeTask(d, "a", "g1", "n-a");
    d = placeTask(d, "a", null, "unused");
    expect(d.nodes).toHaveLength(1);
    expect(d.nodes[0]).toMatchObject({ id: "n-a", groupId: null, pos: { x: 40, y: 64 + 320 + 40 } });
    expect(() => placeTask(d, "a", "nope", "n")).toThrow(CanvasLayoutError);
  });

  it("hides a card but keeps its dependencies; leaving the topic takes both", () => {
    let d = placeTask(placeTask(doc(), "a", null, "n-a"), "b", null, "n-b");
    d = addDependency(d, "a", "b", "e1");
    const hidden = unplaceTask(d, "a");
    expect(hidden.nodes.map((n) => n.id)).toEqual(["n-b"]);
    expect(hidden.edges).toHaveLength(1);
    const gone = removeTask(d, "a");
    expect(gone.nodes.map((n) => n.id)).toEqual(["n-b"]);
    expect(gone.edges).toEqual([]);
  });

  it("turns a reference into the task's own card when the task joins the topic", () => {
    const d = doc({
      nodes: [
        { id: "r1", kind: "ref", taskId: "a", groupId: null, pos: { x: 5, y: 6 } },
        { id: "n-b", kind: "task", taskId: "b", groupId: null, pos: { x: 0, y: 0 } },
        { id: "r2", kind: "ref", taskId: "a", groupId: null, pos: { x: 9, y: 9 } },
      ],
    });
    expect(refsToCard(d, "a").nodes).toEqual([
      { id: "r1", kind: "task", taskId: "a", groupId: null, pos: { x: 5, y: 6 } },
      { id: "n-b", kind: "task", taskId: "b", groupId: null, pos: { x: 0, y: 0 } },
    ]);
    expect(refsToCard(d, "c")).toBe(d);
  });

  it("adds dependencies but refuses itself, duplicates and cycles", () => {
    let d = addDependency(doc(), "a", "b", "e1");
    d = addDependency(d, "b", "c", "e2");
    expect(d.edges.map((e) => [e.from, e.to])).toEqual([["a", "b"], ["b", "c"]]);
    expect(() => addDependency(d, "a", "a", "x")).toThrow(/itself/);
    expect(() => addDependency(d, "a", "b", "x")).toThrow(/already/);
    expect(() => addDependency(d, "c", "a", "x")).toThrow(/cycle/);
  });
});

describe("review items (画布审阅)", () => {
  let n = 0;
  const next = () => `i${++n}`;
  const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < ITEM_CARD.w && Math.abs(a.y - b.y) < ITEM_CARD.h;

  it("lays items out in a new group four to a row, numbered after the canvas's highest, and finds them by #n", () => {
    const start = doc({ nodes: [{ id: "old", kind: "item", num: 4, title: "旧", status: "done", sessionId: null, groupId: null, pos: { x: 0, y: 0 } }] });
    const { doc: d, items } = addItems(start, { id: "g1", title: "审阅" }, Array.from({ length: 6 }, (_, i) => ({ title: `第${i}条`, status: "todo" as const })), next);
    expect(items.map((i) => i.num)).toEqual([5, 6, 7, 8, 9, 10]);
    const g = d.groups.find((x) => x.id === "g1")!.rect;
    for (const i of items) expect(i.pos.x >= g.x && i.pos.y >= g.y + LAYOUT.header && i.pos.x + ITEM_CARD.w <= g.x + g.w && i.pos.y + ITEM_CARD.h <= g.y + g.h).toBe(true);
    expect(new Set(items.map((i) => i.pos.y)).size).toBe(2);
    for (const a of items) for (const b of items) if (a !== b) expect(overlaps(a.pos, b.pos)).toBe(false);
    expect(validateCanvas(d, new Set())).toEqual([]);
    expect(findItem(d, "#7")?.title).toBe("第2条");
    expect(findItem(d, "7")?.id).toBe(items[2]!.id);
    expect(findItem(d, items[0]!.id)?.num).toBe(5);

    // More into the same group: under what it holds, the group grows.
    const more = addItems(d, { id: "g1" }, [{ title: "补充", status: "todo" }], next);
    const added = more.items[0]!;
    expect(items.every((i) => !overlaps(i.pos, added.pos))).toBe(true);
    expect(added.pos.y + ITEM_CARD.h).toBeLessThanOrEqual(more.doc.groups[0]!.rect.y + more.doc.groups[0]!.rect.h);
    expect(() => addItems(d, { id: "nope" }, [{ title: "x", status: "todo" }], next)).toThrow(CanvasLayoutError);
  });

  it("validation refuses a broken item", () => {
    const bad = doc({
      nodes: [
        { id: "a", kind: "item", num: 1, title: "", status: "todo", sessionId: null, groupId: null, pos: { x: 0, y: 0 } },
        { id: "b", kind: "item", num: 1, title: "x", status: "nope" as never, sessionId: null, groupId: null, pos: { x: 300, y: 0 } },
      ],
    });
    expect(validateCanvas(bad, new Set()).join("; ")).toMatch(/needs a title.*unknown status.*used twice/);
  });
});
