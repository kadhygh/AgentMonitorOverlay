import { describe, expect, it } from "vitest";
import { addDependency, addGroupAuto, CanvasLayoutError, LAYOUT, placeNewGroup, placeTask } from "./canvas-layout.js";
import { emptyCanvas } from "./canvas.js";
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

  it("adds dependencies but refuses itself, duplicates and cycles", () => {
    let d = addDependency(doc(), "a", "b", "e1");
    d = addDependency(d, "b", "c", "e2");
    expect(d.edges.map((e) => [e.from, e.to])).toEqual([["a", "b"], ["b", "c"]]);
    expect(() => addDependency(d, "a", "a", "x")).toThrow(/itself/);
    expect(() => addDependency(d, "a", "b", "x")).toThrow(/already/);
    expect(() => addDependency(d, "c", "a", "x")).toThrow(/cycle/);
  });
});
