import { AUTO_COMPACT_MAX, AUTO_COMPACT_MIN, DEFAULT_AUTO_COMPACT_TOKENS, type AutoCompactChoice } from "@amo-studio/protocol";
import type { Store } from "../store/store.js";

// 自动压缩点 (设置 → 模型, 2026-10-17): the context size at which a session summarises its conversation by itself. Both
// CLIs otherwise wait until the context nears the model's whole window (1M for the Claude subscription), and every
// model call reads the whole context again: a session left to grow to 460k spent ~450k per call. Claude Code takes it
// as CLAUDE_CODE_AUTO_COMPACT_WINDOW (it compacts as the context nears the smaller of this and the model's window),
// Codex as `model_auto_compact_token_limit` in a thread's config. S18 (2026-10-18): each channel (profile) may have
// its own, set on its page in 设置 → 模型; one without uses the shared value.

const KEY = "settings:auto-compact-tokens";
const PROFILES_KEY = "settings:auto-compact-profiles";

const valid = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= AUTO_COMPACT_MIN && n <= AUTO_COMPACT_MAX;

/** The shared setting: tokens, or null to leave it to the CLIs. Unset: DEFAULT_AUTO_COMPACT_TOKENS. */
export function readAutoCompact(store: Store, profileId?: string): number | null {
  if (profileId) {
    const own = readAutoCompactProfiles(store)[profileId];
    if (own === "cli") return null;
    if (own !== undefined) return own;
  }
  const raw = store.getKv(KEY)?.value;
  if (raw === undefined) return DEFAULT_AUTO_COMPACT_TOKENS;
  if (raw === "cli") return null;
  const n = Number(raw);
  return valid(n) ? n : DEFAULT_AUTO_COMPACT_TOKENS;
}

export function writeAutoCompact(store: Store, tokens: number | null): void {
  store.setKv(KEY, tokens === null ? "cli" : String(tokens));
}

/** The channels with their own 自动压缩点: tokens, or "cli" to leave it to the CLI. */
export function readAutoCompactProfiles(store: Store): Record<string, AutoCompactChoice> {
  try {
    const v = JSON.parse(store.getKv(PROFILES_KEY)?.value ?? "{}") as Record<string, unknown>;
    const out: Record<string, AutoCompactChoice> = {};
    for (const [id, x] of Object.entries(v ?? {})) if (x === "cli" || valid(x)) out[id] = x;
    return out;
  } catch {
    return {};
  }
}

/** Applies a patch: per profile id, tokens, "cli", or null to go back to the shared value. Throws on a bad value. */
export function writeAutoCompactProfiles(store: Store, known: readonly string[], patch: unknown): void {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("autoCompactProfiles must map profile ids to tokens, \"cli\" or null");
  const next = readAutoCompactProfiles(store);
  for (const [id, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!known.includes(id)) throw new Error(`unknown profile ${id}`);
    if (v === null) delete next[id];
    else if (v === "cli" || valid(v)) next[id] = v;
    else throw new Error(`autoCompactProfiles values are null, "cli" or a whole number from ${AUTO_COMPACT_MIN} to ${AUTO_COMPACT_MAX}`);
  }
  store.setKv(PROFILES_KEY, JSON.stringify(next));
}

/** For a Claude process's environment. */
export function claudeAutoCompactEnv(store: Store, profileId: string): Record<string, string> {
  const tokens = readAutoCompact(store, profileId);
  return tokens === null ? {} : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(tokens) };
}

/** For a Codex thread's config (thread/start, thread/fork, thread/resume). */
export function codexAutoCompactConfig(store: Store, profileId: string | undefined): Record<string, unknown> {
  const tokens = readAutoCompact(store, profileId);
  return tokens === null ? {} : { model_auto_compact_token_limit: tokens };
}
