import { useEffect, useState } from "react";
import type { ModelOption, ProfileChoices, SessionOptions } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent } from "../host/events.js";

// Models, reasoning efforts and permissions a profile offers (asked from its CLI by the Host), shared by the new-task
// page, the new-session form, the composer and the presets in 设置.

export const EFFORT_LABELS: Record<string, string> = { none: "不思考", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高", ultra: "极致" };
export const effortLabel = (e: string) => EFFORT_LABELS[e] ?? e;

// One request per profile for the page's life; a failed one is asked again next time. 设置 → 模型 (order, defaults)
// changes what the Host answers, so a change there drops the cache and the pickers ask again.
const cache = new Map<string, Promise<ProfileChoices>>();
const CHANGED = "amo:choices-changed";
let prefsSeen: string | null = null;
onHostEvent((e) => {
  if (e.type !== "settings.updated") return;
  const prefs = JSON.stringify(e.settings.modelPrefs ?? {});
  if (prefs === prefsSeen) return;
  prefsSeen = prefs;
  cache.clear();
  window.dispatchEvent(new Event(CHANGED));
});

// The last answer is also kept per install: asking a CLI can mean starting its app-server (seconds for a cold GPT
// one), so the pickers show what they knew last time at once and replace it when the fresh list arrives.
const storedKey = (profileId: string) => `amo.choices.${profileId}`;

export function storedChoices(profileId: string): ProfileChoices | null {
  try {
    const c = JSON.parse(localStorage.getItem(storedKey(profileId)) ?? "null") as ProfileChoices | null;
    return c && c.profileId === profileId && Array.isArray(c.models) && Array.isArray(c.permissions) ? c : null;
  } catch {
    return null;
  }
}

export function loadChoices(link: HostLink, profileId: string): Promise<ProfileChoices> {
  let p = cache.get(profileId);
  if (!p) {
    p = call(link, "GET /api/profiles/:id/choices", { id: profileId });
    p.then((c) => {
      try {
        localStorage.setItem(storedKey(profileId), JSON.stringify(c));
      } catch {
        // per-viewer convenience only
      }
    }, () => cache.delete(profileId));
    cache.set(profileId, p);
  }
  return p;
}

/** Goes up when 设置 → 模型 changes what the Host answers, so the hooks below ask again. */
function useChoicesVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(CHANGED, bump);
    return () => window.removeEventListener(CHANGED, bump);
  }, []);
  return version;
}

export function useProfileChoices(link: HostLink, profileId: string | null | undefined): { choices: ProfileChoices | null; error: string | null } {
  const [state, setState] = useState<{ id: string; choices: ProfileChoices | null; error: string | null } | null>(null);
  const version = useChoicesVersion();
  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    setState((cur) => (cur?.id === profileId && cur.choices ? cur : { id: profileId, choices: storedChoices(profileId), error: null }));
    loadChoices(link, profileId)
      .then((choices) => !cancelled && setState({ id: profileId, choices, error: null }))
      .catch((err: unknown) => !cancelled && setState({ id: profileId, choices: null, error: err instanceof HostApiError ? err.message : String(err) }));
    return () => {
      cancelled = true;
    };
  }, [link, profileId, version]);
  return state && state.id === profileId ? { choices: state.choices, error: state.error } : { choices: null, error: null };
}

export function defaultModel(choices: ProfileChoices): ModelOption | undefined {
  return choices.models.find((m) => m.isDefault) ?? choices.models[0];
}

/**
 * A model's short name for headers and pickers: Claude Code lists its default as "默认（Opus 5.5 …）", which reads
 * as the model inside; a 1M-context marker is dropped.
 */
export function modelName(m: Pick<ModelOption, "id" | "label"> | undefined): string | null {
  if (!m) return null;
  const inner = /^默认[（(](.+)[）)]$/.exec(m.label.trim())?.[1] ?? m.label;
  return inner.replace(/\s*[·・]\s*1M.*$|\s*\[1m\]$/i, "").trim() || m.id;
}

/** "Opus 5.5": the model a session runs (chosen, else the profile's default); null while the list is unknown. */
export function sessionModelName(choices: ProfileChoices | null, options: SessionOptions): string | null {
  if (!choices) return options.model ?? null;
  return modelName(activeModel(choices, options)) ?? options.model ?? null;
}

/** The model a session runs: the chosen one, else the profile's default. */
export function activeModel(choices: ProfileChoices, options: SessionOptions): ModelOption | undefined {
  return (options.model && choices.models.find((m) => m.id === options.model)) || defaultModel(choices);
}

/** "GPT-6.1 Sol · 高 · 逐条询问" — what a session runs with, defaults filled in. */
export function optionsSummary(choices: ProfileChoices | null, options: SessionOptions): string {
  if (!choices) return [options.model, options.effort && effortLabel(options.effort)].filter(Boolean).join(" · ") || "默认";
  const model = activeModel(choices, options);
  const effort = options.effort ?? model?.defaultEffort;
  const permission = choices.permissions.find((p) => p.id === (options.permission ?? choices.defaultPermission));
  return [model?.label ?? options.model ?? "默认模型", effort ? effortLabel(effort) : null, permission?.label].filter(Boolean).join(" · ");
}

export const sameOptions = (a: SessionOptions, b: SessionOptions) => (a.model ?? "") === (b.model ?? "") && (a.effort ?? "") === (b.effort ?? "") && (a.permission ?? "") === (b.permission ?? "");

/** Choices of several profiles at once (the model drawer); a profile still loading or failing maps to null. */
export function useChoicesFor(link: HostLink, profileIds: readonly string[]): ReadonlyMap<string, ProfileChoices | null> {
  const key = [...new Set(profileIds)].sort().join(",");
  const [loaded, setLoaded] = useState<ReadonlyMap<string, ProfileChoices | null>>(new Map());
  const version = useChoicesVersion();
  useEffect(() => {
    let cancelled = false;
    for (const id of key.split(",").filter(Boolean)) {
      const stored = storedChoices(id);
      if (stored) setLoaded((cur) => (cur.has(id) ? cur : new Map(cur).set(id, stored)));
      loadChoices(link, id)
        .then((c) => !cancelled && setLoaded((cur) => new Map(cur).set(id, c)))
        .catch(() => !cancelled && setLoaded((cur) => (cur.get(id) ? cur : new Map(cur).set(id, null))));
    }
    return () => {
      cancelled = true;
    };
  }, [link, key, version]);
  return loaded;
}
