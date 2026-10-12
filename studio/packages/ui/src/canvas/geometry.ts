import type { CanvasDoc, CanvasGroup, Id, Point, Rect } from "@amo-studio/protocol";

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
