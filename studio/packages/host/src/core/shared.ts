import type { SessionOptions, HostErrorCode, HostEvent, Session } from "@amo-studio/protocol";
import { CLAUDE_SUBSCRIPTION_CREDENTIAL } from "../runtime/profiles.js";

/** Env var that carries the app-server token into an attached terminal; never put the token itself on a command line. */
export const TERMINAL_TOKEN_ENV = "AMO_STUDIO_CODEX_TOKEN";

export const SCRATCHPAD_KEY = "scratchpad";
/** Before structure v2 the common space was a plain workspace remembered here; now it is marked `builtin`. */
export const LEGACY_COMMON_WORKSPACE_KEY = "settings:common-workspace";
export const COMMON_NAME = "公共";
export const PRESETS_KEY = "settings:presets";
export const DISABLED_FEATURES_KEY = "settings:disabled-features";
/** 设置 → 额度: where each account's quota shows. */
export const QUOTA_DISPLAY_KEY = "settings:quota-display";
/** 设置 → 模型 → 快速选择: the model tiles, in order. */
export const QUICK_MODELS_KEY = "settings:quick-models";
export const MAX_PRESETS = 30;

/** Checks one option value: a short CLI id (model names like "glm-5.3[1m]" included). */
export function optionValue(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > 100 || !/^[\w.:\-[\]/ ]+$/.test(v)) throw new HostError("bad_request", `${field} is not a valid value`);
  return v;
}

/** Session options from a request body; unknown keys are ignored. */
export function sessionOptions(v: unknown): SessionOptions {
  const o = v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  const out: SessionOptions = {};
  const model = optionValue(o.model, "model");
  const effort = optionValue(o.effort, "effort");
  const permission = optionValue(o.permission, "permission");
  if (model) out.model = model;
  if (effort) out.effort = effort;
  if (permission) out.permission = permission;
  if (typeof o.fast === "boolean") out.fast = o.fast;
  return out;
}

// Application layer behind the Host API. HTTP handlers stay thin and call into this.

export class HostError extends Error {
  constructor(readonly code: HostErrorCode, message: string) {
    super(message);
    this.name = "HostError";
  }
}

export interface HostServiceEvents {
  event: [HostEvent];
}

// Agents write notes, mail and questions through the AMO MCP; a runaway turn must not fill the store or the Focus
// window, so these texts are bounded (a handoff summary fits easily).
export const MAX_NOTE_CHARS = 8000;
export const MAX_QUESTION_CHARS = 2000;
export const MAX_OPTION_CHARS = 200;
/** Proposals one scheduler session (one round) may make (design/scheduler.md). */
export const PROPOSALS_PER_ROUND = 3;
export const SCHEDULER_TASK_KEY = "scheduler:task";

export function boundedText(value: unknown, field: string, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new HostError("bad_request", `${field} is required`);
  if (text.length > max) throw new HostError("bad_request", `${field} is too long (${text.length} characters; at most ${max})`);
  return text;
}

/** The only entry Studio writes: the Claude subscription token the person pastes in 设置 → 模型凭据. */
export const WRITABLE_CREDENTIALS = new Set([CLAUDE_SUBSCRIPTION_CREDENTIAL]);
