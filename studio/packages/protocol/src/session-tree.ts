import type { Id, Session } from "./entities.js";

export interface SessionNode {
  session: Session;
  children: SessionNode[];
}

/** Builds the per-task session forest. Sessions whose parent is missing become roots. Order follows createdAt. */
export function buildSessionTree(sessions: readonly Session[]): SessionNode[] {
  const sorted = [...sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const nodes = new Map<Id, SessionNode>(sorted.map((s) => [s.id, { session: s, children: [] }]));
  const roots: SessionNode[] = [];
  for (const s of sorted) {
    const node = nodes.get(s.id)!;
    const parent = s.parentId ? nodes.get(s.parentId) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** The session and all of its forks and subagents, depth-first. Archiving applies to this whole set. */
export function collectSubtreeIds(sessions: readonly Session[], rootId: Id): Id[] {
  const byParent = new Map<Id, Session[]>();
  for (const s of sessions) {
    if (!s.parentId) continue;
    const list = byParent.get(s.parentId) ?? [];
    list.push(s);
    byParent.set(s.parentId, list);
  }
  const out: Id[] = [];
  const seen = new Set<Id>();
  const visit = (id: Id) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const child of byParent.get(id) ?? []) visit(child.id);
  };
  if (sessions.some((s) => s.id === rootId)) visit(rootId);
  return out;
}
