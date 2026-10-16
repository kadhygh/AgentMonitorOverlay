import type { AccountUsage, ModelOption, ModelProfile, TurnRetry } from "@amo-studio/protocol";

// What a Codex app-server says about the account and its models (stage 16 split out of codex-runtime.ts): models and
// their fast tier, the quota, skills, /code-review targets and why a turn retries.

/** The fields of a `model/list` entry the runtime reads. */
export interface CodexModel {
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string }>;
  defaultReasoningEffort: string;
  isDefault: boolean;
  /** Speed tiers beyond standard (codex-cli 0.162: GPT models list `{ id: "priority", name: "Fast", … }`). */
  serviceTiers?: Array<{ id: string; name: string; description: string }> | null;
}

/** Standard speed, as Codex names it (`service_tier = "default"`). */
export const STANDARD_TIER = "default";

/** A model's fast tier: the one named or with id "fast" (Codex calls it "priority" with the name "Fast"). */
export function fastTier(tiers: CodexModel["serviceTiers"]): ModelOption["fast"] | undefined {
  const t = (tiers ?? []).find((x) => /^fast$/i.test(x.name) || /^fast$/i.test(x.id));
  return t ? { tier: t.id, ...(t.description ? { description: t.description } : {}) } : undefined;
}

export function toModelOption(m: CodexModel, profile: ModelProfile): ModelOption {
  const fast = fastTier(m.serviceTiers);
  return {
    id: m.model,
    label: m.displayName || m.model,
    ...(m.description ? { description: m.description } : {}),
    efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    defaultEffort: m.model === profile.model && profile.reasoningEffort ? profile.reasoningEffort : m.defaultReasoningEffort,
    ...((profile.model ? m.model === profile.model : m.isDefault) ? { isDefault: true } : {}),
    ...(fast ? { fast } : {}),
  };
}

/** A skill as skills/list describes it (the fields the runtime reads). */
export interface CodexSkill {
  name: string;
  description: string;
  shortDescription?: string;
  path: string;
  enabled?: boolean;
}

/** `/code-review` arguments: nothing (uncommitted changes), `base <branch>`, `commit <sha>`, or review instructions. */
export function reviewTarget(args: string): Record<string, unknown> {
  const text = args.trim();
  const base = /^base\s+(\S+)$/i.exec(text);
  if (base) return { type: "baseBranch", branch: base[1] };
  const commit = /^commit\s+([0-9a-f]{4,40})$/i.exec(text);
  if (commit) return { type: "commit", sha: commit[1], title: null };
  return text ? { type: "custom", instructions: text } : { type: "uncommittedChanges" };
}

export interface CodexTurnError {
  message: string;
  codexErrorInfo?: unknown;
  additionalDetails?: string | null;
}

const RETRY_REASONS: Record<string, string> = {
  responseStreamDisconnected: "连接中断",
  responseStreamConnectionFailed: "连接失败",
  httpConnectionFailed: "连接失败",
  serverOverloaded: "服务繁忙",
  rateLimitExceeded: "触发限流",
  internalServerError: "服务出错",
};

/** An `error` with willRetry: "Reconnecting... 2/5" and why. */
export function codexRetry(error: CodexTurnError): TurnRetry {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(error.message);
  const info = error.codexErrorInfo;
  const code = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : undefined;
  const reason = (code && RETRY_REASONS[code]) || firstLineOf(error.additionalDetails || error.message);
  return { attempt: m ? Number(m[1]) : 1, ...(m ? { max: Number(m[2]) } : {}), reason };
}

export const firstLineOf = (text: string) => text.split(/\r?\n/)[0]!.trim().slice(0, 200);

export type CodexRateWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null } | null;
export type GetAccountRateLimitsResponse = { rateLimits: { primary: CodexRateWindow; secondary: CodexRateWindow } };

const windowLabel = (mins: number | null) =>
  mins === null ? "额度" : mins === 300 ? "5 小时" : mins === 10080 ? "每周" : mins === 1440 ? "每天" : mins % 60 === 0 ? `${mins / 60} 小时` : `${mins} 分钟`;

/** A Codex rate-limit snapshot as the windows Studio shows (resetsAt comes in epoch seconds). */
export function codexUsage(profile: ModelProfile, limits: { primary: CodexRateWindow; secondary: CodexRateWindow }): AccountUsage {
  const windows = [limits.primary, limits.secondary]
    .filter((w): w is NonNullable<CodexRateWindow> => !!w)
    .map((w) => ({ label: windowLabel(w.windowDurationMins), usedPercent: w.usedPercent, resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null }));
  return { profileId: profile.id, label: profile.label, windows, note: windows.length ? null : "这个账号没有用量限制", updatedAt: new Date().toISOString() };
}
