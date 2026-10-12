import { describe, expect, it } from "vitest";
import { emptyCanvas, type CanvasDoc } from "@amo-studio/protocol";
import { deleteGroup, groupAt, moveGroup, moveNode, resizeGroup, updateGroup } from "./geometry.js";

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
