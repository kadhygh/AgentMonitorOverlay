import { describe, expect, it } from "vitest";
import { emptyCanvas, type CanvasDoc } from "@amo-studio/protocol";
import { contentBounds, deleteGroup, deleteGroupAndCards, duplicateNote, groupContents, groupAt, moveGroup, moveNode, outOfGroup, placeBeside, removeEdge, resizeGroup, resizeNode, reverseEdge, setColor, updateGroup } from "./geometry.js";

describe("placeBeside (详情框)", () => {
  const box = { w: 300, h: 200 };
  const area = { w: 1000, h: 600 };
  it("goes right of the card, its top lined up and kept in the area", () => {
    expect(placeBeside({ x: 100, y: 100, w: 220, h: 66 }, box, area)).toEqual({ x: 332, y: 100, side: "right" });
    expect(placeBeside({ x: 100, y: 550, w: 220, h: 66 }, box, area)).toEqual({ x: 332, y: 392, side: "right" });
    expect(placeBeside({ x: 100, y: -30, w: 220, h: 66 }, box, area)).toEqual({ x: 332, y: 8, side: "right" });
  });
  it("left when the right has no room, then below, then above", () => {
    expect(placeBeside({ x: 700, y: 100, w: 220, h: 66 }, box, area)).toEqual({ x: 388, y: 100, side: "left" });
    const wide = { x: 200, y: 50, w: 700, h: 100 };
    expect(placeBeside(wide, box, area)).toEqual({ x: 200, y: 162, side: "below" });
    expect(placeBeside({ ...wide, y: 380 }, box, area)).toEqual({ x: 200, y: 168, side: "above" });
  });
  it("of the sides with room, the one covering least of the other cards", () => {
    const anchor = { x: 340, y: 100, w: 220, h: 66 };
    expect(placeBeside(anchor, box, area)?.side).toBe("right");
    expect(placeBeside(anchor, box, area, 12, undefined, [{ x: 700, y: 120, w: 220, h: 66 }])?.side).toBe("left");
    // Every side covered: the least.
    const others = [{ x: 700, y: 120, w: 220, h: 66 }, { x: 0, y: 100, w: 300, h: 200 }, { x: 340, y: 200, w: 300, h: 100 }];
    expect(placeBeside(anchor, box, area, 12, undefined, others)?.side).toBe("right");
  });
  it("over the anchor when no side has room, and nothing when the anchor is out of view", () => {
    expect(placeBeside({ x: 50, y: 50, w: 900, h: 500 }, box, area)?.side).toBe("over");
    expect(placeBeside({ x: 1200, y: 100, w: 220, h: 66 }, box, area)).toBeNull();
    expect(placeBeside({ x: 100, y: -100, w: 220, h: 66 }, box, area)).toBeNull();
  });
});

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

  it("deletes a group alone (its cards stay where they are) or with every card in it (2026-10-29)", () => {
    const d = doc();
    d.nodes.push({ id: "n3", kind: "note", text: "in", groupId: "g1", pos: { x: 30, y: 120 } }, { id: "n4", kind: "ref", taskId: "t9", groupId: "g1", pos: { x: 30, y: 200 } });
    d.edges.push({ id: "e1", kind: "depends", from: "t1", to: "t2" });
    d.links = [
      { id: "l1", from: "n2", fromSide: "left", to: "n3", toSide: "right" },
      { id: "l2", from: "n2", fromSide: "top", to: "n2b", toSide: "top" },
    ];
    d.nodes.push({ id: "n2b", kind: "note", text: "y", groupId: null, pos: { x: 1200, y: 900 } });
    expect(groupContents(d, "g1")).toEqual({ tasks: 1, notes: 1, refs: 1, items: 0, total: 3 });
    expect(groupContents(d, "g2")).toMatchObject({ total: 0 });

    const alone = deleteGroup(d, "g1");
    expect(alone.groups.map((g) => g.id)).toEqual(["g2"]);
    expect(alone.nodes.map((n) => [n.id, n.groupId, n.pos])).toEqual(d.nodes.map((n) => [n.id, n.groupId === "g1" ? null : n.groupId, n.pos]));

    // With its cards: the task's card leaves the canvas but its dependency stays (the task is not deleted); the note and
    // the reference go, and so does the line to the note.
    const all = deleteGroupAndCards(d, "g1");
    expect(all.groups.map((g) => g.id)).toEqual(["g2"]);
    expect(all.nodes.map((n) => n.id)).toEqual(["n2", "n2b"]);
    expect(all.edges).toEqual(d.edges);
    expect(all.links?.map((l) => l.id)).toEqual(["l2"]);
  });

  it("gives a card a size and takes it back off (2026-10-29)", () => {
    const sized = resizeNode(doc(), "n1", { w: 300.4, h: 120.6 });
    expect(sized.nodes[0]).toMatchObject({ size: { w: 300, h: 121 }, pos: { x: 20, y: 40 }, groupId: "g1" });
    expect(sized.nodes[1]).toEqual(doc().nodes[1]);
    expect(resizeNode(sized, "n1", null).nodes[0]).not.toHaveProperty("size");
  });

  it("resizing a group leaves its cards where they are", () => {
    const d = resizeGroup(doc(), "g1", 150, 100);
    expect(d.groups[0]!.rect).toEqual({ x: 0, y: 0, w: 200, h: 140 });
    expect(d.nodes).toEqual(doc().nodes);
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
