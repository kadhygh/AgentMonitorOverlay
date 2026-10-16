import { describe, expect, it } from "vitest";
import { emptyCanvas, type CanvasDoc } from "@amo-studio/protocol";
import { contentBounds, deleteGroup, deleteGroupWithContents, duplicateNote, groupAt, moveGroup, moveNode, outOfGroup, removeEdge, resizeGroup, reverseEdge, setColor, updateGroup } from "./geometry.js";

const SIZE = { w: 220, h: 66 };

function doc(): CanvasDoc {
  return {
    ...emptyCanvas(),
    groups: [
      { id: "g1", title: "A", workspaceId: null, rect: { x: 0, y: 0, w: 400, h: 300 } },
      { id: "g2", title: "B", workspaceId: null, rect: { x: 300, y: 200, w: 400, h: 300 } },
    ],
    nodes: [
      { id: "n1", kind: "task", taskId: "t1", groupId: "g1", pos: { x: 20, y: 40 } },
      { id: "n2", kind: "note", text: "x", groupId: null, pos: { x: 900, y: 900 } },
    ],
    edges: [],
  };
}

describe("canvas geometry", () => {
  it("finds the top-most group under a point", () => {
    expect(groupAt(doc().groups, { x: 10, y: 10 })?.id).toBe("g1");
    expect(groupAt(doc().groups, { x: 350, y: 250 })?.id).toBe("g2"); // overlap: later group wins
    expect(groupAt(doc().groups, { x: 2000, y: 0 })).toBeNull();
  });

  it("moves a node into, between and out of groups by its centre", () => {
    let d = moveNode(doc(), "n2", { x: 400, y: 300 }, SIZE);
    expect(d.nodes[1]!.groupId).toBe("g2");
    d = moveNode(d, "n1", { x: 1500, y: 1500 }, SIZE);
    expect(d.nodes[0]).toMatchObject({ groupId: null, pos: { x: 1500, y: 1500 } });
  });

  it("moves a group with its members only", () => {
    const d = moveGroup(doc(), "g1", 50, -10);
    expect(d.groups[0]!.rect).toMatchObject({ x: 50, y: -10 });
    expect(d.nodes[0]!.pos).toEqual({ x: 70, y: 30 });
    expect(d.nodes[1]!.pos).toEqual({ x: 900, y: 900 });
  });

  it("resizes with a minimum and updates title and workspace", () => {
    expect(resizeGroup(doc(), "g1", 10, 10).groups[0]!.rect).toMatchObject({ w: 200, h: 140 });
    expect(updateGroup(doc(), "g2", { title: "C", workspaceId: "ws" }).groups[1]).toMatchObject({ title: "C", workspaceId: "ws" });
  });

  it("deletes a group but keeps its cards in place", () => {
    const d = deleteGroup(doc(), "g1");
    expect(d.groups.map((g) => g.id)).toEqual(["g2"]);
    expect(d.nodes[0]).toMatchObject({ groupId: null, pos: { x: 20, y: 40 } });
  });
});

describe("arrowBetween", () => {
  it("clips the arrow to both card borders", async () => {
    const { arrowBetween } = await import("./geometry.js");
    const left = { x: 0, y: 0, w: 100, h: 50 };
    const right = { x: 300, y: 0, w: 100, h: 50 };
    expect(arrowBetween(left, right)).toEqual({ a: { x: 100, y: 25 }, b: { x: 300, y: 25 } });
    const below = { x: 0, y: 200, w: 100, h: 50 };
    expect(arrowBetween(left, below)).toEqual({ a: { x: 50, y: 50 }, b: { x: 50, y: 200 } });
  });
});

describe("canvas menu edits (stage 16)", () => {
  it("marks a group or a node with a colour, and takes it off", () => {
    const red = setColor(doc(), { kind: "node", id: "n1" }, "red");
    expect(red.nodes[0]).toMatchObject({ color: "red" });
    expect(setColor(red, { kind: "node", id: "n1" }, null).nodes[0]).not.toHaveProperty("color");
    expect(setColor(doc(), { kind: "group", id: "g2" }, "blue").groups[1]).toMatchObject({ color: "blue" });
  });

  it("takes a card out of its group, below it", () => {
    expect(outOfGroup(doc(), "n1", SIZE).nodes[0]).toMatchObject({ groupId: null, pos: { x: 0, y: 316 } });
    expect(outOfGroup(doc(), "n2", SIZE)).toEqual(doc());
  });

  it("deletes a group with its notes and references, keeping its tasks' cards", () => {
    const d = doc();
    d.nodes.push({ id: "n3", kind: "note", text: "in", groupId: "g1", pos: { x: 30, y: 120 } }, { id: "n4", kind: "ref", taskId: "t9", groupId: "g1", pos: { x: 30, y: 200 } });
    const after = deleteGroupWithContents(d, "g1");
    expect(after.groups.map((g) => g.id)).toEqual(["g2"]);
    expect(after.nodes.map((n) => [n.id, n.groupId])).toEqual([["n1", null], ["n2", null]]);
  });

  it("copies a note beside it; reverses and removes a dependency; bounds everything", () => {
    expect(duplicateNote(doc(), "n2", "n9").nodes.at(-1)).toMatchObject({ id: "n9", kind: "note", text: "x", pos: { x: 924, y: 924 } });
    const d = { ...doc(), edges: [{ id: "e1", kind: "depends" as const, from: "t1", to: "t2" }] };
    expect(reverseEdge(d, "e1").edges[0]).toMatchObject({ from: "t2", to: "t1" });
    expect(removeEdge(d, "e1").edges).toEqual([]);
    expect(contentBounds(doc(), () => SIZE)).toEqual({ x: 0, y: 0, w: 1120, h: 966 });
    expect(contentBounds({ ...emptyCanvas(), groups: [], nodes: [], edges: [] }, () => SIZE)).toBeNull();
  });
});
