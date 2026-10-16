import type { QuestionPrompt, ToolFields, ToolKind, ToolStatus, TurnUsage } from "@amo-studio/protocol";
import { classifyCommand, contentText, fileDiff, formatInput, shortPath, tail, unwrapShell } from "../items.js";

// Codex's items as Studio's rows (stage 16 split out of codex-runtime.ts): tool calls, automatic reviews, plans, the
// questions of request_user_input, and a turn's token usage.

/** request_user_input's questions as Studio shows them: free text when there are no options, or `isOther`. */
export function inputQuestions(list: unknown): QuestionPrompt[] {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return (Array.isArray(list) ? (list as Array<Record<string, unknown>>) : [])
    .filter((q) => q && typeof q === "object" && str(q.id))
    .map((q) => {
      const options = (Array.isArray(q.options) ? (q.options as Array<Record<string, unknown>>) : [])
        .filter((o) => o && typeof o === "object" && str(o.label))
        .map((o) => ({ label: str(o.label), ...(str(o.description) ? { description: str(o.description) } : {}) }));
      return {
        id: str(q.id),
        question: str(q.question) || str(q.header) || str(q.id),
        ...(str(q.header) ? { header: str(q.header) } : {}),
        options,
        ...(q.isOther === true || !options.length ? { other: true } : {}),
        ...(q.isSecret === true ? { secret: true } : {}),
      };
    });
}

/** The subset of Codex ThreadItem fields the runtime reads. */
export interface CodexItem {
  type: string;
  id: string;
  text?: string;
  /** agentMessage from request_user_input_async: "async", with the questions asked. */
  delivery?: string | null;
  questions?: unknown;
  content?: unknown[];
  summary?: string[];
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  commandActions?: CommandAction[];
  changes?: Array<{ path: string; kind?: { type: string; move_path?: string | null }; diff?: string }>;
  server?: string;
  namespace?: string | null;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown } | null;
  error?: { message?: string } | null;
  contentItems?: unknown;
  success?: boolean | null;
  query?: string;
  action?: { type: string; query?: string | null; url?: string | null; pattern?: string | null } | null;
  kind?: string;
  agentThreadId?: string;
  agentPath?: string;
  // stage 12, S12-E: the remaining item types
  path?: string;
  savedPath?: string;
  revisedPrompt?: string | null;
  failure?: { type: string } | null;
  fragments?: Array<{ text: string }>;
  receiverThreadIds?: string[];
  prompt?: string | null;
  name?: string;
  output?: unknown;
  review?: string;
}

type CommandAction =
  | { type: "read"; command: string; name: string; path: string }
  | { type: "listFiles"; command: string; path: string | null }
  | { type: "search"; command: string; query: string | null; path: string | null }
  | { type: "unknown"; command: string };

function toolStatus(status: string | undefined): ToolStatus {
  return status === "completed" ? "completed" : status === "failed" ? "failed" : status === "declined" ? "declined" : "running";
}

/**
 * Row fields for a Codex item; `workspace` is the session's folder (paths inside it are shown relative). `done`: the
 * item is complete (items without a status of their own are then completed).
 */
export function describeTool(item: CodexItem, workspace?: string, done = true): ToolFields {
  const status = item.status === undefined ? (done ? "completed" : "running") : toolStatus(item.status);
  const base = item.cwd ?? workspace;
  const timing = item.durationMs != null ? { durationMs: item.durationMs } : {};
  switch (item.type) {
    case "commandExecution": {
      const actions = item.commandActions ?? [];
      const only = actions.length === 1 ? actions[0]! : undefined;
      const inner = only?.command ?? item.command ?? "";
      // Codex classifies Unix commands itself; on Windows they come back "unknown", so look at the command.
      const guess = !only || only.type === "unknown" ? classifyCommand(inner) : null;
      const kind: ToolKind =
        only?.type === "read" || guess?.kind === "read" ? "read" : only?.type === "search" || guess?.kind === "search" ? "search" : only?.type === "listFiles" || guess?.kind === "list" ? "list" : "command";
      const summary =
        only?.type === "read"
          ? shortPath(only.path, base)
          : only?.type === "search"
            ? [only.query, only.path ? shortPath(only.path, base) : null].filter(Boolean).join(" · ") || only.command
            : only?.type === "listFiles"
              ? only.path ? shortPath(only.path, base) : "."
              : guess
                ? guess.kind === "search" ? guess.target : shortPath(guess.target, base)
                : inner;
      return {
        name: "shell",
        kind,
        summary,
        input: inner,
        ...(item.aggregatedOutput ? { detail: tail(item.aggregatedOutput) } : {}),
        ...(item.exitCode != null ? { exitCode: item.exitCode } : {}),
        ...(item.cwd ? { cwd: item.cwd } : {}),
        ...timing,
        status,
      };
    }
    case "fileChange": {
      const files = (item.changes ?? []).map((c) =>
        fileDiff(shortPath(c.path, base), c.kind?.type === "add" ? "add" : c.kind?.type === "delete" ? "delete" : "update", c.diff),
      );
      return { name: "edit", kind: "edit", summary: files.map((f) => f.path).join(", "), files, status };
    }
    case "mcpToolCall": {
      const output = item.error?.message ?? contentText(item.result?.content);
      const input = formatInput(item.arguments);
      return {
        name: `${item.server ?? "mcp"}.${item.tool ?? ""}`,
        kind: "mcp",
        summary: item.tool ?? "",
        ...(input ? { input } : {}),
        ...(output ? { detail: tail(output) } : {}),
        ...timing,
        status,
      };
    }
    case "dynamicToolCall": {
      const output = contentText(item.contentItems);
      const input = formatInput(item.arguments);
      return {
        name: [item.namespace, item.tool].filter(Boolean).join("."),
        kind: "other",
        summary: item.tool ?? "",
        ...(input ? { input } : {}),
        ...(output ? { detail: tail(output) } : {}),
        ...timing,
        status: item.success === false ? "failed" : status,
      };
    }
    case "webSearch": {
      const a = item.action;
      const summary = a?.type === "openPage" || a?.type === "findInPage" ? (a.url ?? item.query ?? "") : (a?.query ?? item.query ?? "");
      // Web search items carry no status: started means running, completed means done.
      return { name: a?.type === "openPage" ? "web_fetch" : "web_search", kind: "web", summary, status: item.status ? status : "running" };
    }
    case "imageView": {
      const path = item.path ?? "";
      return { name: "view_image", kind: "read", summary: shortPath(path, base), ...(path ? { images: [{ id: null, path }] } : {}), status: done ? "completed" : "running" };
    }
    case "imageGeneration": {
      // `result` is the image itself (base64); only a saved file is shown.
      const failed = !!item.failure;
      return {
        name: "image_generation",
        kind: "other",
        summary: item.revisedPrompt?.trim() || "生成图片",
        ...(item.savedPath ? { images: [{ id: null, path: item.savedPath }] } : {}),
        ...(failed ? { detail: item.failure!.type === "usageLimitExceeded" ? "生成图片的额度用完了" : item.failure!.type } : {}),
        status: failed ? "failed" : done ? "completed" : "running",
      };
    }
    case "hookPrompt": {
      const text = (item.fragments ?? []).map((f) => f.text).filter(Boolean).join("\n\n");
      return { name: "hook_prompt", kind: "other", summary: "Hook 补充了提示", ...(text ? { detail: tail(text) } : {}), status: "completed" };
    }
    case "collabAgentToolCall": {
      const receivers = item.receiverThreadIds?.length ?? 0;
      const summary = item.prompt?.trim().split("\n")[0]?.slice(0, 120) || (receivers ? `${receivers} 个子 agent` : "");
      const s = item.status === "inProgress" ? "running" : item.status === "failed" ? "failed" : item.status === "interrupted" ? "declined" : done ? "completed" : "running";
      return { name: `collab.${item.tool ?? ""}`, kind: "subagent", summary, ...(item.prompt ? { input: item.prompt } : {}), status: s };
    }
    case "sleep":
      return { name: "sleep", kind: "other", summary: `等待 ${Math.max(1, Math.round((item.durationMs ?? 0) / 1000))} 秒`, ...timing, status: done ? "completed" : "running" };
    case "functionCallOutput": {
      const output = typeof item.output === "string" ? item.output : contentText(item.output);
      return { name: [item.namespace, item.name].filter(Boolean).join(".") || "function", kind: "other", summary: "", ...(output ? { detail: tail(output) } : {}), status: "completed" };
    }
    default:
      return { name: item.tool ?? item.type, kind: "other", summary: "", status };
  }
}

export interface CodexReview {
  startedAtMs: number;
  completedAtMs?: number;
  review: { status: string; riskLevel: string | null; rationale: string | null };
  action: { type: string; command?: string; program?: string; argv?: string[]; files?: string[]; target?: string; server?: string; toolName?: string; reason?: string | null };
}

const RISK: Record<string, string> = { low: "低风险", medium: "中风险", high: "高风险", critical: "极高风险" };
const VERDICT: Record<string, string> = { inProgress: "审查中", approved: "已批准", denied: "已拒绝", timedOut: "超时", aborted: "已中止" };

/** One automatic review: what it looked at, its verdict and risk, and its reasons. */
export function describeReview(r: CodexReview, workspace?: string): ToolFields {
  const a = r.action;
  const what =
    a.type === "command"
      ? unwrapShell(a.command ?? "")
      : a.type === "execve"
        ? [a.program, ...(a.argv ?? []).slice(1)].filter(Boolean).join(" ")
        : a.type === "applyPatch"
          ? (a.files ?? []).map((f) => shortPath(f, workspace)).join(", ")
          : a.type === "networkAccess"
            ? (a.target ?? "")
            : a.type === "mcpToolCall"
              ? `${a.server ?? ""}.${a.toolName ?? ""}`
              : (a.reason ?? a.type);
  const status = r.review.status;
  const verdict = [VERDICT[status] ?? status, r.review.riskLevel ? RISK[r.review.riskLevel] ?? r.review.riskLevel : null].filter(Boolean).join(" · ");
  return {
    name: "auto_review",
    kind: "review",
    summary: what ? `${verdict} · ${what}` : verdict,
    input: what,
    ...(r.review.rationale ? { detail: r.review.rationale } : {}),
    ...(r.completedAtMs ? { durationMs: r.completedAtMs - r.startedAtMs } : {}),
    status: status === "inProgress" ? "running" : status === "approved" ? "completed" : status === "denied" ? "declined" : "failed",
  };
}

/** A plan update (Codex's update_plan) as one tool row per turn. */
export function describePlan(plan: Array<{ step: string; status: string }>, explanation: string | null): ToolFields {
  const done = plan.filter((p) => p.status === "completed").length;
  const mark = (s: string) => (s === "completed" ? "✓" : s === "inProgress" ? "→" : "○");
  const lines = plan.map((p) => `${mark(p.status)} ${p.step}`);
  return {
    name: "update_plan",
    kind: "plan",
    summary: `${done}/${plan.length} 已完成`,
    detail: [explanation, ...lines].filter(Boolean).join("\n"),
    status: "completed",
  };
}

/** Adds one model call (`last`) to the turn's usage; the context is what that call left in it. */
export function addUsage(prev: TurnUsage | undefined, last: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number; totalTokens?: number }, window: number | null): TurnUsage {
  return {
    input: (prev?.input ?? 0) + last.inputTokens,
    cachedInput: (prev?.cachedInput ?? 0) + last.cachedInputTokens,
    output: (prev?.output ?? 0) + last.outputTokens,
    reasoning: (prev?.reasoning ?? 0) + last.reasoningOutputTokens,
    // A compaction's call reports no input or output, only the size of what it left.
    context: last.inputTokens + last.outputTokens || (last.totalTokens ?? 0),
    ...(window ? { contextWindow: window } : {}),
  };
}
