import type { ModelProfile } from "@amo-studio/protocol";
import { storedChoices } from "./choices.js";

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

/**
 * A pick naming its profile's default model by id is the same as no model (2026-10-18: "Claude · 默认" and "Claude ·
 * Opus" were two tiles of one model). Judged by the profile's last known choices.
 */
export function normalPick(p: ModelPick): ModelPick {
  if (!p.model) return { profileId: p.profileId, model: null };
  const d = storedChoices(p.profileId)?.models.find((m) => m.isDefault)?.id;
  return d === p.model ? { profileId: p.profileId, model: null } : { profileId: p.profileId, model: p.model };
}

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

/** Up to `count` tiles: the chosen 快速选择 if any, else the automatic ones (autoPicks). */
export function commonPicks(profiles: readonly ModelProfile[], count = tileCount()): ModelPick[] {
  const known = new Set(profiles.map((p) => p.id));
  const chosen = uniquePicks(quick.filter((p) => known.has(p.profileId)));
  if (chosen.length) return chosen.slice(0, count);
  return autoPicks(profiles, count);
}

/** The row without a 快速选择: recent picks of profiles that still exist, then the profiles' defaults. */
export function autoPicks(profiles: readonly ModelProfile[], count = 4): ModelPick[] {
  const known = new Set(profiles.map((p) => p.id));
  const out: ModelPick[] = [];
  for (const p of [...read(), ...profiles.map((x) => ({ profileId: x.id, model: null }))]) {
    const n = normalPick(p);
    if (out.length < count && known.has(n.profileId) && !out.some((x) => samePick(x, n))) out.push(n);
  }
  return out;
}

/** Normalised, each pick once, in order. */
export function uniquePicks(list: readonly ModelPick[]): ModelPick[] {
  const out: ModelPick[] = [];
  for (const p of list.map(normalPick)) if (!out.some((x) => samePick(x, p))) out.push(p);
  return out;
}
