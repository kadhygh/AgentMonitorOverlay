import type { CanvasColor, CanvasDoc, CanvasGroup, CanvasNode, Id, Point, Rect } from "@amo-studio/protocol";

// Pure canvas edits used by the canvas page. Membership is structural (node.groupId); positions follow it.

export const GROUP_MIN = { w: 200, h: 140 };
export const GROUP_HEADER = 30;

export function contains(rect: Rect, p: Point): boolean {
  return p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h;
}

/** The group a point falls into; later groups are drawn on top, so they win. */
export function groupAt(groups: readonly CanvasGroup[], p: Point): CanvasGroup | null {
  for (let i = groups.length - 1; i >= 0; i--) if (contains(groups[i]!.rect, p)) return groups[i]!;
  return null;
}

/** Moves a node and re-evaluates which group its centre falls into. */
export function moveNode(doc: CanvasDoc, nodeId: Id, pos: Point, size: { w: number; h: number }): CanvasDoc {
  const centre = { x: pos.x + size.w / 2, y: pos.y + size.h / 2 };
  const groupId = groupAt(doc.groups, centre)?.id ?? null;
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === nodeId ? { ...n, pos, groupId } : n)) };
}

/** Moves a group together with its member nodes. */
export function moveGroup(doc: CanvasDoc, groupId: Id, dx: number, dy: number): CanvasDoc {
  return {
    ...doc,
    groups: doc.groups.map((g) => (g.id === groupId ? { ...g, rect: { ...g.rect, x: g.rect.x + dx, y: g.rect.y + dy } } : g)),
    nodes: doc.nodes.map((n) => (n.groupId === groupId ? { ...n, pos: { x: n.pos.x + dx, y: n.pos.y + dy } } : n)),
  };
}

export function resizeGroup(doc: CanvasDoc, groupId: Id, w: number, h: number): CanvasDoc {
  return {
    ...doc,
    groups: doc.groups.map((g) => (g.id === groupId ? { ...g, rect: { ...g.rect, w: Math.max(GROUP_MIN.w, w), h: Math.max(GROUP_MIN.h, h) } } : g)),
  };
}

export function updateGroup(doc: CanvasDoc, groupId: Id, patch: Partial<Pick<CanvasGroup, "title" | "workspaceId">>): CanvasDoc {
  return { ...doc, groups: doc.groups.map((g) => (g.id === groupId ? { ...g, ...patch } : g)) };
}

/** Removes a group; its cards and notes stay where they are, ungrouped. */
export function deleteGroup(doc: CanvasDoc, groupId: Id): CanvasDoc {
  return {
    ...doc,
    groups: doc.groups.filter((g) => g.id !== groupId),
    nodes: doc.nodes.map((n) => (n.groupId === groupId ? { ...n, groupId: null } : n)),
  };
}

export function addGroup(doc: CanvasDoc, group: CanvasGroup): CanvasDoc {
  return { ...doc, groups: [...doc.groups, group] };
}

/** Point where the segment from the centre of `rect` towards `target` leaves the rectangle. */
export function borderPoint(rect: Rect, target: Point): Point {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx === 0 ? Infinity : rect.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : rect.h / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

/** Arrow from one card to another, clipped to both card borders. */
export function arrowBetween(from: Rect, to: Rect): { a: Point; b: Point } {
  const fc = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const tc = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  return { a: borderPoint(from, tc), b: borderPoint(to, fc) };
}

// ---- right-click menu edits (stage 16) ------------------------------------------------------------------------------

/** A colour mark on a group or a node (null: none). */
export function setColor(doc: CanvasDoc, target: { kind: "group" | "node"; id: Id }, color: CanvasColor | null): CanvasDoc {
  const paint = <T extends { color?: CanvasColor }>(o: T): T => {
    const { color: _old, ...rest } = o;
    return (color ? { ...rest, color } : rest) as T;
  };
  return target.kind === "group"
    ? { ...doc, groups: doc.groups.map((g) => (g.id === target.id ? paint(g) : g)) }
    : { ...doc, nodes: doc.nodes.map((n) => (n.id === target.id ? paint(n) : n)) };
}

/** Takes a node out of its group: it goes just below the group, at its left edge. */
export function outOfGroup(doc: CanvasDoc, nodeId: Id, size: { w: number; h: number }): CanvasDoc {
  const node = doc.nodes.find((n) => n.id === nodeId);
  const group = node?.groupId ? doc.groups.find((g) => g.id === node.groupId) : undefined;
  if (!node || !group) return doc;
  const pos = { x: group.rect.x, y: group.rect.y + group.rect.h + 16 };
  return { ...doc, nodes: doc.nodes.map((n) => (n.id === nodeId ? { ...n, pos, groupId: null } : n)) };
}

/** Removes a group with its notes and reference cards; its tasks' cards stay, ungrouped (a task is not the canvas's to delete). */
export function deleteGroupWithContents(doc: CanvasDoc, groupId: Id): CanvasDoc {
  const gone = (n: CanvasNode) => n.groupId === groupId && n.kind !== "task";
  return deleteGroup({ ...doc, nodes: doc.nodes.filter((n) => !gone(n)) }, groupId);
}

/** A copy of a note beside it (in the same group when it fits there). */
export function duplicateNote(doc: CanvasDoc, nodeId: Id, newId: Id): CanvasDoc {
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node || node.kind !== "note") return doc;
  return { ...doc, nodes: [...doc.nodes, { ...node, id: newId, pos: { x: node.pos.x + 24, y: node.pos.y + 24 } }] };
}

export function reverseEdge(doc: CanvasDoc, edgeId: Id): CanvasDoc {
  return { ...doc, edges: doc.edges.map((e) => (e.id === edgeId ? { ...e, from: e.to, to: e.from } : e)) };
}

export function removeEdge(doc: CanvasDoc, edgeId: Id): CanvasDoc {
  return { ...doc, edges: doc.edges.filter((e) => e.id !== edgeId) };
}

/** The box around everything on the canvas, or null when it is empty. */
export function contentBounds(doc: CanvasDoc, sizeOf: (n: CanvasNode) => { w: number; h: number }): Rect | null {
  const rects: Rect[] = [...doc.groups.map((g) => g.rect), ...doc.nodes.map((n) => ({ ...n.pos, ...sizeOf(n) }))];
  if (!rects.length) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}
