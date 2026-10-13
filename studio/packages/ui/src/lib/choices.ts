import { useEffect, useState } from "react";
import type { ModelOption, ProfileChoices, SessionOptions } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

// Models, reasoning efforts and permissions a profile offers (asked from its CLI by the Host), shared by the new-task
// page, the new-session form, the composer and the presets in 设置.

export const EFFORT_LABELS: Record<string, string> = { none: "不思考", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高", ultra: "极致" };
export const effortLabel = (e: string) => EFFORT_LABELS[e] ?? e;

// One request per profile for the page's life; a failed one is asked again next time.
const cache = new Map<string, Promise<ProfileChoices>>();

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

export function useProfileChoices(link: HostLink, profileId: string | null | undefined): { choices: ProfileChoices | null; error: string | null } {
  const [state, setState] = useState<{ id: string; choices: ProfileChoices | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    setState({ id: profileId, choices: storedChoices(profileId), error: null });
    loadChoices(link, profileId)
      .then((choices) => !cancelled && setState({ id: profileId, choices, error: null }))
      .catch((err: unknown) => !cancelled && setState({ id: profileId, choices: null, error: err instanceof HostApiError ? err.message : String(err) }));
    return () => {
      cancelled = true;
    };
  }, [link, profileId]);
  return state && state.id === profileId ? { choices: state.choices, error: state.error } : { choices: null, error: null };
}

export function defaultModel(choices: ProfileChoices): ModelOption | undefined {
  return choices.models.find((m) => m.isDefault) ?? choices.models[0];
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
  }, [link, key]);
  return loaded;
}
