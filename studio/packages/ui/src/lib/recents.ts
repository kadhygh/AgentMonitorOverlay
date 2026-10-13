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

/** Up to `count` tiles: recent picks of profiles that still exist, then the profiles' defaults. */
export function commonPicks(profiles: readonly ModelProfile[], count = 4): ModelPick[] {
  const known = new Set(profiles.map((p) => p.id));
  const out: ModelPick[] = [];
  const add = (p: ModelPick) => {
    if (out.length < count && known.has(p.profileId) && !out.some((x) => samePick(x, p))) out.push(p);
  };
  read().forEach(add);
  profiles.forEach((p) => add({ profileId: p.id, model: null }));
  return out;
}
