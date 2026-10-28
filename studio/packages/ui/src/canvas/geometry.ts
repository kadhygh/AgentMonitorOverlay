import { pruneLinks, type CanvasColor, type CanvasDoc, type CanvasGroup, type CanvasLink, type CanvasNode, type CanvasSide, type Id, type Point, type Rect } from "@amo-studio/protocol";

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

/** What a group holds, by kind: what deleting it with its cards would take (the confirm says it in words). */
export function groupContents(doc: CanvasDoc, groupId: Id): { tasks: number; notes: number; refs: number; items: number; total: number } {
  const inside = doc.nodes.filter((n) => n.groupId === groupId);
  const count = (kind: CanvasNode["kind"]) => inside.filter((n) => n.kind === kind).length;
  return { tasks: count("task"), notes: count("note"), refs: count("ref"), items: count("item"), total: inside.length };
}

/**
 * Removes a group with every card in it (2026-10-29, 「同时删除组里的卡片」): notes, reference cards and review items
 * go; a task's card only leaves the canvas, as 「从画布上拿掉」 does — the task, and its dependencies, stay (a task is
 * not the canvas's to delete). Lines to the cards that went go with them.
 */
export function deleteGroupAndCards(doc: CanvasDoc, groupId: Id): CanvasDoc {
  return pruneLinks(deleteGroup({ ...doc, nodes: doc.nodes.filter((n) => n.groupId !== groupId) }, groupId));
}

/** A card dragged to a size (its corner handle); `null` gives it back its kind's own size. */
export function resizeNode(doc: CanvasDoc, nodeId: Id, size: { w: number; h: number } | null): CanvasDoc {
  return {
    ...doc,
    nodes: doc.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const { size: _old, ...rest } = n;
      return (size ? { ...rest, size: { w: Math.round(size.w), h: Math.round(size.h) } } : rest) as CanvasNode;
    }),
  };
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

// ---- 连线 (2026-10-19): lines between cards, side to side, as on an Obsidian canvas --------------------------------

const NORMAL: Record<CanvasSide, Point> = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } };

/** The middle of one side of a card: where its handle is and a line leaves or arrives. */
export function sidePoint(r: Rect, side: CanvasSide): Point {
  if (side === "top") return { x: r.x + r.w / 2, y: r.y };
  if (side === "bottom") return { x: r.x + r.w / 2, y: r.y + r.h };
  if (side === "left") return { x: r.x, y: r.y + r.h / 2 };
  return { x: r.x + r.w, y: r.y + r.h / 2 };
}

/** The side of a card nearest to a point (a line dropped on the card, not on one of its handles). */
export function nearestSide(r: Rect, p: Point): CanvasSide {
  const sides: CanvasSide[] = ["top", "right", "bottom", "left"];
  return sides.reduce((best, side) => (Math.hypot(sidePoint(r, side).x - p.x, sidePoint(r, side).y - p.y) < Math.hypot(sidePoint(r, best).x - p.x, sidePoint(r, best).y - p.y) ? side : best));
}

/**
 * A line's curve: it leaves `a` straight out of its side and arrives at `b` straight into its side (or, while being
 * drawn, at the pointer); `mid` is where its label goes.
 */
export function linkCurve(a: Point, aSide: CanvasSide, b: Point, bSide: CanvasSide | null): { d: string; mid: Point } {
  const reach = Math.min(150, Math.max(30, Math.hypot(b.x - a.x, b.y - a.y) / 2));
  const c1 = { x: a.x + NORMAL[aSide].x * reach, y: a.y + NORMAL[aSide].y * reach };
  const c2 = bSide ? { x: b.x + NORMAL[bSide].x * reach, y: b.y + NORMAL[bSide].y * reach } : b;
  const mid = { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 };
  const r = (n: number) => Math.round(n * 10) / 10;
  return { d: `M ${r(a.x)} ${r(a.y)} C ${r(c1.x)} ${r(c1.y)}, ${r(c2.x)} ${r(c2.y)}, ${r(b.x)} ${r(b.y)}`, mid };
}

/** Adds a line, unless the same one (same cards, same sides) is there already. */
export function addLink(doc: CanvasDoc, link: CanvasLink): CanvasDoc {
  const links = doc.links ?? [];
  if (link.from === link.to || links.some((l) => l.from === link.from && l.to === link.to && l.fromSide === link.fromSide && l.toSide === link.toSide)) return doc;
  return { ...doc, links: [...links, link] };
}

/** A line's label; an empty one is removed. */
export function setLinkLabel(doc: CanvasDoc, linkId: Id, label: string): CanvasDoc {
  const text = label.trim();
  return {
    ...doc,
    links: (doc.links ?? []).map((l) => {
      if (l.id !== linkId) return l;
      const { label: _old, ...rest } = l;
      return text ? { ...rest, label: text } : rest;
    }),
  };
}

export function reverseLink(doc: CanvasDoc, linkId: Id): CanvasDoc {
  return { ...doc, links: (doc.links ?? []).map((l) => (l.id === linkId ? { ...l, from: l.to, fromSide: l.toSide, to: l.from, toSide: l.fromSide } : l)) };
}

export function removeLink(doc: CanvasDoc, linkId: Id): CanvasDoc {
  return { ...doc, links: (doc.links ?? []).filter((l) => l.id !== linkId) };
}

/**
 * The dot grid behind the canvas, moving and scaling with the view so a drag on empty space reads as moving the camera
 * (2026-10-19). The spacing doubles when zoomed far out, so the dots never crowd.
 */
export function gridStyle(view: { x: number; y: number; k: number }): { backgroundPosition: string; backgroundSize: string } {
  let step = 20 * view.k;
  while (step < 12) step *= 2;
  return { backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${step}px ${step}px` };
}
