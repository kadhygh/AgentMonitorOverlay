import type { ModelProfile } from "@amo-studio/protocol";

// The "常用" model tiles (design/ui-directions/new-task.html): the combinations the person used last, then each
// profile's own default. Kept per install, like the other remembered choices.

/** A profile and one of its models (null: whatever the profile runs by default). */
export interface ModelPick {
  profileId: string;
  model: string | null;
}

const KEY = "amo.recentModels";
const KEEP = 8;

function read(): ModelPick[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is ModelPick => !!p && typeof p.profileId === "string" && (typeof p.model === "string" || p.model === null)) : [];
  } catch {
    return [];
  }
}

export const samePick = (a: ModelPick, b: ModelPick) => a.profileId === b.profileId && (a.model ?? null) === (b.model ?? null);

/** Moves a pick to the front of the recent list. */
export function rememberPick(pick: ModelPick): void {
  const next = [pick, ...read().filter((p) => !samePick(p, pick))].slice(0, KEEP);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // per-viewer convenience only
  }
}

/**
 * 设置 → 模型 → 快速选择: the tiles the person chose, in order (kept here so the keyboard handlers can read them; the
 * main window sets them from its settings on every render). Empty: recent picks, then each profile's default.
 */
let quick: readonly ModelPick[] = [];
export function setQuickModels(list: readonly ModelPick[] | undefined): void {
  quick = list ?? [];
}
/** How many tiles the row shows: the chosen ones, else four. */
export const tileCount = () => (quick.length ? quick.length : 4);

/** Up to `count` tiles: the chosen 快速选择 if any, else recent picks of profiles that still exist, then the profiles' defaults. */
export function commonPicks(profiles: readonly ModelProfile[], count = tileCount()): ModelPick[] {
  const known = new Set(profiles.map((p) => p.id));
  const chosen = quick.filter((p) => known.has(p.profileId));
  if (chosen.length) return chosen.slice(0, count).map((p) => ({ profileId: p.profileId, model: p.model }));
  const out: ModelPick[] = [];
  const add = (p: ModelPick) => {
    if (out.length < count && known.has(p.profileId) && !out.some((x) => samePick(x, p))) out.push(p);
  };
  read().forEach(add);
  profiles.forEach((p) => add({ profileId: p.id, model: null }));
  return out;
}
