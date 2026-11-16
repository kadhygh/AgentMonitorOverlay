import type { Id, Session } from "./entities.js";

export interface SessionNode {
  session: Session;
  children: SessionNode[];
}

/**
 * The list's order among sessions side by side (拖拽排序, 2026-11-17): by Session.rank, those never moved after them by
 * createdAt (a new session goes to the end, as before ranks).
 */
export function compareSessions(a: Session, b: Session): number {
  const ra = a.rank ?? Infinity;
  const rb = b.rank ?? Infinity;
  return (ra === rb ? 0 : ra < rb ? -1 : 1) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * Builds the per-task session forest. Sessions whose parent is missing become roots. Side by side they follow
 * compareSessions (their rank, then createdAt). With `delegated`, a main session started by another (session_start)
 * hangs under it too, for the session list only (it names an earlier session, so it cannot loop).
 */
export function buildSessionTree(sessions: readonly Session[], opts: { delegated?: boolean } = {}): SessionNode[] {
  // Sorted as a whole: each parent takes its children in this order, so every level follows it.
  const sorted = [...sessions].sort(compareSessions);
  const nodes = new Map<Id, SessionNode>(sorted.map((s) => [s.id, { session: s, children: [] }]));
  const parentOf = (s: Session): Id | null => s.parentId ?? (opts.delegated ? (s.startedBy ?? null) : null);
  const roots: SessionNode[] = [];
  for (const s of sorted) {
    const node = nodes.get(s.id)!;
    const id = parentOf(s);
    const parent = id ? nodes.get(id) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * The sessions that stand beside `id` in the session list (its own level of buildSessionTree with `delegated`), in
 * their order; null when it is not among `sessions`. What 拖拽排序 reorders: never across levels.
 */
export function sessionSiblings(sessions: readonly Session[], id: Id): Id[] | null {
  const find = (nodes: readonly SessionNode[]): Id[] | null => {
    if (nodes.some((n) => n.session.id === id)) return nodes.map((n) => n.session.id);
    for (const n of nodes) {
      const got = find(n.children);
      if (got) return got;
    }
    return null;
  };
  return find(buildSessionTree(sessions, { delegated: true }));
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
