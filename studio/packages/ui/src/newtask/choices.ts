import type { Task } from "@amo-studio/protocol";

// 新任务页的专题和项目两行 (2026-10-29, plans/remote-page-and-new-task.md 4.2): each row shows a few chips — for projects
// the topic's own first (「专题常用」), then pinned ones, then recently used ones, then the rest — and 「更多…」 opens a
// search over all of them, grouped the same way. Pure logic; the rows and the picker live in ChoiceRow.tsx.

/** How many chips a row shows besides 「不选」. */
export const ROW_MAX = 6;
/** How many go in 最近. */
const RECENT_MAX = 5;

export type ChoiceGroup = "topic" | "pinned" | "recent" | "all";
export const GROUP_HEADINGS: Record<ChoiceGroup, string> = { topic: "专题常用", pinned: "置顶", recent: "最近", all: "全部" };

export interface Choice {
  id: string;
  name: string;
  /** A project's folder, a topic's task count. */
  hint: string;
  group: ChoiceGroup;
}

/** Ids worked on most recently, newest first, by their live tasks' last change. */
export function recentIds(tasks: readonly Task[], key: (task: Task) => string | null, max = RECENT_MAX): string[] {
  const out: string[] = [];
  for (const t of [...tasks].filter((t) => !t.archivedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    const id = key(t);
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= max) break;
  }
  return out;
}

/** Every item once, in the first group it belongs to: the topic's (in that order), pinned, recent, then the rest as given. */
export function rankChoices<T>(
  items: readonly T[],
  describe: (item: T) => { id: string; name: string; hint: string },
  by: { topic?: readonly string[]; pinned?: readonly string[]; recent?: readonly string[] },
): Choice[] {
  const all = items.map(describe);
  const byId = new Map(all.map((c) => [c.id, c]));
  const out: Choice[] = [];
  const seen = new Set<string>();
  const take = (ids: readonly string[] | undefined, group: ChoiceGroup) => {
    for (const id of ids ?? []) {
      const c = byId.get(id);
      if (c && !seen.has(id)) {
        seen.add(id);
        out.push({ ...c, group });
      }
    }
  };
  take(by.topic, "topic");
  take(by.pinned, "pinned");
  take(by.recent, "recent");
  take(
    all.map((c) => c.id),
    "all",
  );
  return out;
}

/** The chips a row shows (the picked one always among them) and how many more 「更多…」 holds. */
export function rowChoices(ranked: readonly Choice[], selected: string | null, max = ROW_MAX): { shown: Choice[]; more: number } {
  let shown = ranked.slice(0, max);
  const picked = selected && !shown.some((c) => c.id === selected) ? ranked.find((c) => c.id === selected) : undefined;
  if (picked) shown = [...shown.slice(0, max - 1), picked];
  return { shown, more: ranked.length - shown.length };
}

/**
 * The picker's list for what was typed (in the ranked order): every word in the name — or, for a word with a slash in
 * it, in the folder (every folder shares its drive and parents, so plain words would match them all).
 */
export function filterChoices(ranked: readonly Choice[], query: string): Choice[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return ranked.filter((c) => words.every((w) => (/[\\/]/.test(w) ? c.hint.toLowerCase().replace(/\//g, "\\").includes(w.replace(/\//g, "\\")) : c.name.toLowerCase().includes(w))));
}

/**
 * The project a topic picks by itself (4.2): its one preferred project. With none or several the person picks.
 */
export function topicProject(preferred: readonly string[]): string | null {
  return preferred.length === 1 ? preferred[0]! : null;
}
