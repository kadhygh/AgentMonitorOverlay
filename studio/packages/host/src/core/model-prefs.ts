import type { ModelPrefs, ProfileChoices, SessionOptions } from "@amo-studio/protocol";
import type { Store } from "../store/store.js";
import { HostError } from "./shared.js";

// 设置 → 模型 → 型号顺序和默认 (stage 12, S12-J): per profile, the order of its models in every picker and the model,
// reasoning effort and permissions a new session gets when none is chosen. Kept in the Host's kv table.

const KEY = "settings:model-prefs";

export function readModelPrefs(store: Store): Record<string, ModelPrefs> {
  try {
    const raw = JSON.parse(store.getKv(KEY)?.value ?? "{}") as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, ModelPrefs>) : {};
  } catch {
    return {};
  }
}

const text = (v: unknown, name: string) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > 200) throw new HostError("bad_request", `${name} must be a short string`);
  return v;
};

/** Replaces the prefs of the profiles given (null or {} clears a profile's). */
export function writeModelPrefs(store: Store, profileIds: readonly string[], input: unknown): Record<string, ModelPrefs> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HostError("bad_request", "modelPrefs must map profile ids to prefs");
  const next = readModelPrefs(store);
  for (const [profileId, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!profileIds.includes(profileId)) throw new HostError("bad_request", `unknown profile ${profileId}`);
    if (raw === null) {
      delete next[profileId];
      continue;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) throw new HostError("bad_request", `modelPrefs.${profileId} must be an object`);
    const o = raw as Record<string, unknown>;
    if (o.order !== undefined && (!Array.isArray(o.order) || o.order.length > 200 || o.order.some((x) => typeof x !== "string"))) throw new HostError("bad_request", "order must list model ids");
    const prefs: ModelPrefs = {
      ...(Array.isArray(o.order) && o.order.length ? { order: [...new Set(o.order as string[])] } : {}),
      ...(text(o.model, "model") ? { model: text(o.model, "model")! } : {}),
      ...(text(o.effort, "effort") ? { effort: text(o.effort, "effort")! } : {}),
      ...(text(o.permission, "permission") ? { permission: text(o.permission, "permission")! } : {}),
    };
    if (Object.keys(prefs).length) next[profileId] = prefs;
    else delete next[profileId];
  }
  store.setKv(KEY, JSON.stringify(next));
  return next;
}

/**
 * The CLI's choices with the person's prefs on top: models in their order (new ones after, as the CLI lists them),
 * their default model, effort (on the models that take it) and permissions. Prefs naming something the CLI no longer
 * offers are skipped.
 */
export function applyModelPrefs(choices: ProfileChoices, prefs: ModelPrefs | undefined): ProfileChoices {
  if (!prefs) return choices;
  const rank = new Map((prefs.order ?? []).map((id, i) => [id, i]));
  const models = choices.models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (rank.get(a.m.id) ?? rank.size + a.i) - (rank.get(b.m.id) ?? rank.size + b.i))
    .map(({ m }) => m);
  const pinned = prefs.model && models.some((m) => m.id === prefs.model) ? prefs.model : null;
  return {
    ...choices,
    models: models.map((m) => {
      const { isDefault: _was, ...rest } = m;
      const isDefault = pinned ? m.id === pinned : m.isDefault;
      const effort = prefs.effort && m.efforts.includes(prefs.effort) ? prefs.effort : m.defaultEffort;
      return { ...rest, ...(effort ? { defaultEffort: effort } : {}), ...(isDefault ? { isDefault: true } : {}) };
    }),
    defaultPermission: prefs.permission && choices.permissions.some((p) => p.id === prefs.permission) ? prefs.permission : choices.defaultPermission,
  };
}

/**
 * A new session's options with the defaults filled in where nothing was chosen: the default model, its default effort,
 * the default permissions, all as the choices (prefs applied) say. The CLI's own defaults are left implicit.
 */
export function fillDefaults(options: SessionOptions, choices: ProfileChoices, prefs: ModelPrefs | undefined): SessionOptions {
  if (!prefs) return options;
  const model = options.model ?? (prefs.model && choices.models.some((m) => m.id === prefs.model) ? prefs.model : undefined);
  const runs = choices.models.find((m) => m.id === model) ?? choices.models.find((m) => m.isDefault);
  const effort = options.effort ?? (prefs.effort && runs?.efforts.includes(prefs.effort) ? prefs.effort : undefined);
  const permission = options.permission ?? (prefs.permission && choices.permissions.some((p) => p.id === prefs.permission) ? prefs.permission : undefined);
  return { ...options, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(permission ? { permission } : {}) };
}
