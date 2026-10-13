import { useEffect, useState } from "react";
import type { ModelOption, ProfileChoices, SessionOptions } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

// Models, reasoning efforts and permissions a profile offers (asked from its CLI by the Host), shared by the new-task
// page, the new-session form, the composer and the presets in 设置.

export const EFFORT_LABELS: Record<string, string> = { none: "不思考", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高", ultra: "极致" };
export const effortLabel = (e: string) => EFFORT_LABELS[e] ?? e;

// One request per profile for the page's life; a failed one is asked again next time.
const cache = new Map<string, Promise<ProfileChoices>>();

export function loadChoices(link: HostLink, profileId: string): Promise<ProfileChoices> {
  let p = cache.get(profileId);
  if (!p) {
    p = call(link, "GET /api/profiles/:id/choices", { id: profileId });
    p.catch(() => cache.delete(profileId));
    cache.set(profileId, p);
  }
  return p;
}

export function useProfileChoices(link: HostLink, profileId: string | null | undefined): { choices: ProfileChoices | null; error: string | null } {
  const [state, setState] = useState<{ id: string; choices: ProfileChoices | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    setState({ id: profileId, choices: null, error: null });
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
