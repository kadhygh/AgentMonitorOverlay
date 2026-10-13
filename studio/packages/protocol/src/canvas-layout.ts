import { wouldCycle } from "./canvas.js";
import type { CanvasDoc, CanvasGroup, Rect, Id } from "./entities.js";

// Where things go when an agent (through the AMO MCP) changes the canvas: agents never write coordinates, Studio lays
// out. Sizes match the workbench canvas (task card 220×66, group header 30).

export const LAYOUT = { card: { w: 220, h: 66 }, header: 30, pad: 12, gap: 16, group: { w: 500, h: 320 }, margin: 40 } as const;

const right = (r: Rect) => r.x + r.w;
const bottom = (r: Rect) => r.y + r.h;

export class CanvasLayoutError extends Error {}

/** A new group to the right of everything on the canvas, top-aligned with the first group (or at the origin). */
export function placeNewGroup(doc: CanvasDoc): Rect {
  const rects = [...doc.groups.map((g) => g.rect), ...doc.nodes.map((n) => ({ x: n.pos.x, y: n.pos.y, w: LAYOUT.card.w, h: LAYOUT.card.h }))];
  const x = rects.length ? Math.max(...rects.map(right)) + LAYOUT.margin : LAYOUT.margin;
  const y = doc.groups.length ? Math.min(...doc.groups.map((g) => g.rect.y)) : LAYOUT.margin + 24;
  return { x, y, w: LAYOUT.group.w, h: LAYOUT.group.h };
}

export function addGroupAuto(doc: CanvasDoc, group: { id: Id; title: string; workspaceId: Id | null }): CanvasDoc {
  return { ...doc, groups: [...doc.groups, { ...group, rect: placeNewGroup(doc) }] };
}

/** Grid slot `index` inside a group. */
function slot(g: CanvasGroup, index: number) {
  const cols = Math.max(1, Math.floor((g.rect.w - LAYOUT.pad * 2 + LAYOUT.gap) / (LAYOUT.card.w + LAYOUT.gap)));
  const col = index % cols;
  const row = Math.floor(index / cols);
  return { x: g.rect.x + LAYOUT.pad + col * (LAYOUT.card.w + LAYOUT.gap), y: g.rect.y + LAYOUT.header + LAYOUT.pad + row * (LAYOUT.card.h + LAYOUT.gap) };
}

/**
 * Puts a task's card into a group (the next free grid slot; the group grows to fit) or, with `groupId` null, below
 * everything ungrouped. Creates the card if the task was not on the canvas yet.
 */
export function placeTask(doc: CanvasDoc, taskId: Id, groupId: Id | null, newNodeId: Id): CanvasDoc {
  const existing = doc.nodes.find((n) => n.kind === "task" && n.taskId === taskId);
  const others = doc.nodes.filter((n) => n !== existing);
  if (groupId === null) {
    const bottoms = [...doc.groups.map((g) => bottom(g.rect)), ...others.map((n) => n.pos.y + LAYOUT.card.h)];
    const pos = { x: LAYOUT.margin, y: (bottoms.length ? Math.max(...bottoms) : 0) + LAYOUT.margin };
    const node = existing ? { ...existing, groupId: null, pos } : { id: newNodeId, kind: "task" as const, taskId, groupId: null, pos };
    return { ...doc, nodes: [...others, node] };
  }
  const group = doc.groups.find((g) => g.id === groupId);
  if (!group) throw new CanvasLayoutError(`group ${groupId} not found`);
  const members = others.filter((n) => n.groupId === groupId).length;
  const pos = slot(group, members);
  const neededBottom = pos.y + LAYOUT.card.h + LAYOUT.pad;
  const groups = neededBottom > bottom(group.rect) ? doc.groups.map((g) => (g.id === groupId ? { ...g, rect: { ...g.rect, h: neededBottom - g.rect.y } } : g)) : doc.groups;
  const node = existing ? { ...existing, groupId, pos } : { id: newNodeId, kind: "task" as const, taskId, groupId, pos };
  return { ...doc, groups, nodes: [...others, node] };
}

/** Adds "to depends on from"; refuses itself, duplicates and cycles. */
export function addDependency(doc: CanvasDoc, from: Id, to: Id, edgeId: Id): CanvasDoc {
  if (from === to) throw new CanvasLayoutError("a task cannot depend on itself");
  if (doc.edges.some((e) => e.from === from && e.to === to)) throw new CanvasLayoutError("that dependency already exists");
  if (wouldCycle(doc.edges, from, to)) throw new CanvasLayoutError("that dependency would make a cycle");
  return { ...doc, edges: [...doc.edges, { id: edgeId, kind: "depends", from, to }] };
}

/** Takes a task off a canvas: its card and every dependency it is part of (when it leaves the topic). */
export function removeTask(doc: CanvasDoc, taskId: Id): CanvasDoc {
  return {
    ...doc,
    nodes: doc.nodes.filter((n) => !(n.kind === "task" && n.taskId === taskId)),
    edges: doc.edges.filter((e) => e.from !== taskId && e.to !== taskId),
  };
}
