import { wouldCycle } from "./canvas.js";
import type { CanvasDoc, CanvasGroup, CanvasItem, Rect, Id } from "./entities.js";

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

/** Hides a task of the topic from its canvas: only its card goes; its dependencies stay (the task is still in the topic). */
export function unplaceTask(doc: CanvasDoc, taskId: Id): CanvasDoc {
  return { ...doc, nodes: doc.nodes.filter((n) => !(n.kind === "task" && n.taskId === taskId)) };
}

/** A task joining the topic: its first reference card there becomes its own card (same place); other references go. */
export function refsToCard(doc: CanvasDoc, taskId: Id): CanvasDoc {
  const refs = doc.nodes.filter((n) => n.kind === "ref" && n.taskId === taskId);
  if (!refs.length) return doc;
  const keep = doc.nodes.some((n) => n.kind === "task" && n.taskId === taskId) ? null : refs[0]!;
  return {
    ...doc,
    nodes: doc.nodes.flatMap((n) => (n === keep ? [{ id: n.id, kind: "task" as const, taskId, groupId: n.groupId, pos: n.pos }] : refs.includes(n) ? [] : [n])),
  };
}

/** Takes a task off a canvas: its card and every dependency it is part of (when it leaves the topic). */
export function removeTask(doc: CanvasDoc, taskId: Id): CanvasDoc {
  return {
    ...doc,
    nodes: doc.nodes.filter((n) => !(n.kind === "task" && n.taskId === taskId)),
    edges: doc.edges.filter((e) => e.from !== taskId && e.to !== taskId),
  };
}

// 画布审阅 (2026-10-27): review items laid out in a grid of ITEM_COLS, in their own group or one that exists.

/** A review item's card (the workbench draws it this size). */
export const ITEM_CARD = { w: 240, h: 124 } as const;
const ITEM_COLS = 4;

export type NewItem = Pick<CanvasItem, "title" | "status"> & Partial<Pick<CanvasItem, "body" | "refs" | "sessionId" | "conclusion">>;

/** The next free #n on the canvas. */
export const nextItemNum = (doc: CanvasDoc) => doc.nodes.reduce((n, x) => (x.kind === "item" ? Math.max(n, x.num) : n), 0) + 1;

function itemSlot(origin: { x: number; y: number }, index: number) {
  const col = index % ITEM_COLS;
  const row = Math.floor(index / ITEM_COLS);
  return { x: origin.x + col * (ITEM_CARD.w + LAYOUT.gap), y: origin.y + row * (ITEM_CARD.h + LAYOUT.gap) };
}

/**
 * Lays review items out: in a new group titled `group.title` (to the right of everything), at the end of an existing
 * group `group.id` (it grows to fit), or below everything ungrouped. Numbers continue after the canvas's highest.
 */
export function addItems(doc: CanvasDoc, group: { id: Id; title?: string } | null, items: readonly NewItem[], newNodeId: () => Id): { doc: CanvasDoc; items: CanvasItem[] } {
  if (!items.length) throw new CanvasLayoutError("no items to place");
  let num = nextItemNum(doc);
  const make = (item: NewItem, groupId: Id | null, pos: { x: number; y: number }): CanvasItem => ({
    id: newNodeId(),
    kind: "item",
    num: num++,
    title: item.title,
    status: item.status,
    ...(item.body ? { body: item.body } : {}),
    ...(item.conclusion ? { conclusion: item.conclusion } : {}),
    ...(item.refs?.length ? { refs: [...item.refs] } : {}),
    sessionId: item.sessionId ?? null,
    groupId,
    pos,
  });
  const span = (count: number) => ({
    w: Math.min(count, ITEM_COLS) * (ITEM_CARD.w + LAYOUT.gap) - LAYOUT.gap,
    h: Math.ceil(count / ITEM_COLS) * (ITEM_CARD.h + LAYOUT.gap) - LAYOUT.gap,
  });
  if (!group) {
    const bottoms = [...doc.groups.map((g) => bottom(g.rect)), ...doc.nodes.map((n) => n.pos.y + (n.kind === "item" ? ITEM_CARD.h : LAYOUT.card.h))];
    const origin = { x: LAYOUT.margin, y: (bottoms.length ? Math.max(...bottoms) : 0) + LAYOUT.margin };
    const placed = items.map((it, i) => make(it, null, itemSlot(origin, i)));
    return { doc: { ...doc, nodes: [...doc.nodes, ...placed] }, items: placed };
  }
  const existing = doc.groups.find((g) => g.id === group.id);
  if (!existing) {
    if (!group.title) throw new CanvasLayoutError(`group ${group.id} not found`);
    const at = placeNewGroup(doc);
    const size = span(items.length);
    const rect = { x: at.x, y: at.y, w: size.w + LAYOUT.pad * 2, h: LAYOUT.header + LAYOUT.pad * 2 + size.h };
    const origin = { x: rect.x + LAYOUT.pad, y: rect.y + LAYOUT.header + LAYOUT.pad };
    const placed = items.map((it, i) => make(it, group.id, itemSlot(origin, i)));
    return { doc: { ...doc, groups: [...doc.groups, { id: group.id, title: group.title, workspaceId: null, rect }], nodes: [...doc.nodes, ...placed] }, items: placed };
  }
  // After what the group holds: a new row under its lowest card.
  const members = doc.nodes.filter((n) => n.groupId === existing.id);
  const lowest = members.length ? Math.max(...members.map((n) => n.pos.y + (n.kind === "item" ? ITEM_CARD.h : LAYOUT.card.h))) + LAYOUT.gap : existing.rect.y + LAYOUT.header + LAYOUT.pad;
  const origin = { x: existing.rect.x + LAYOUT.pad, y: lowest };
  const placed = items.map((it, i) => make(it, existing.id, itemSlot(origin, i)));
  const size = span(items.length);
  const rect = { ...existing.rect, w: Math.max(existing.rect.w, size.w + LAYOUT.pad * 2), h: Math.max(existing.rect.h, origin.y + size.h + LAYOUT.pad - existing.rect.y) };
  return { doc: { ...doc, groups: doc.groups.map((g) => (g.id === existing.id ? { ...g, rect } : g)), nodes: [...doc.nodes, ...placed] }, items: placed };
}

/** An item by its id, "#3" or "3". */
export function findItem(doc: CanvasDoc, ref: string): CanvasItem | undefined {
  const m = /^#?(\d+)$/.exec(ref.trim());
  return doc.nodes.find((n): n is CanvasItem => n.kind === "item" && (m ? n.num === Number(m[1]) : n.id === ref.trim()));
}
