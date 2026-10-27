import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TurnDecode } from "@amo-studio/protocol";

// A Claude subagent's tokens and speed from the transcript Claude Code keeps for it (2026-10-27):
// `projects/<cwd>/<session>/subagents/agent-<agentId>.jsonl`, its Agent call named in `agent-<agentId>.meta.json`.
// The SDK sends a subagent's messages with the output count at each call's start, and not its stream, so the output
// Studio counted live was far too low and there was no speed. In the transcript each call (one message id) comes as one
// line per content block, the later ones with the larger output count. The speed is per call from the line before it
// (the request going out: the prompt, or the tool results it answers) to its last block: it includes the wait for the
// first token, unlike the generation-only speed of a main session, and is marked so (`basis: "request"`).

export interface SubagentStats {
  input: number;
  cachedInput: number;
  output: number;
  decode?: TurnDecode;
}

interface Line {
  type?: string;
  timestamp?: string;
  message?: { id?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } };
}

/** The transcript of the subagent an Agent call (its tool_use id) started, in a Claude config dir; null when none. */
export function subagentLogFile(configDir: string, sessionRef: string, toolUseId: string): string | null {
  const projects = join(configDir, "projects");
  if (!existsSync(projects)) return null;
  for (const dir of readdirSync(projects)) {
    const subs = join(projects, dir, sessionRef, "subagents");
    if (!existsSync(subs)) continue;
    for (const f of readdirSync(subs)) {
      if (!f.endsWith(".meta.json")) continue;
      try {
        if ((JSON.parse(readFileSync(join(subs, f), "utf8")) as { toolUseId?: unknown }).toolUseId !== toolUseId) continue;
      } catch {
        continue;
      }
      const log = join(subs, f.replace(/\.meta\.json$/, ".jsonl"));
      return existsSync(log) ? log : null;
    }
  }
  return null;
}

/** A subagent's stats from its transcript file; null when unreadable or it made no calls. */
export function subagentStatsOf(file: string): SubagentStats | null {
  try {
    return subagentStats(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** The stats of a subagent's transcript text (exported for tests). */
export function subagentStats(text: string): SubagentStats | null {
  const lines: Line[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as Line);
    } catch {
      // A line still being written.
    }
  }
  const calls = new Map<string, { start: number | null; end: number; input: number; cached: number; output: number }>();
  lines.forEach((l, i) => {
    const id = l.message?.id;
    const used = l.message?.usage;
    const at = l.timestamp ? Date.parse(l.timestamp) : NaN;
    if (l.type !== "assistant" || !id || !used || !Number.isFinite(at)) return;
    const cached = used.cache_read_input_tokens ?? 0;
    const input = (used.input_tokens ?? 0) + cached + (used.cache_creation_input_tokens ?? 0);
    const call = calls.get(id);
    if (call) {
      call.end = Math.max(call.end, at);
      call.output = Math.max(call.output, used.output_tokens ?? 0);
      call.input = Math.max(call.input, input);
      call.cached = Math.max(call.cached, cached);
      return;
    }
    const before = i > 0 ? Date.parse(lines[i - 1]!.timestamp ?? "") : NaN;
    calls.set(id, { start: Number.isFinite(before) && before <= at ? before : null, end: at, input, cached, output: used.output_tokens ?? 0 });
  });
  if (!calls.size) return null;
  const out: SubagentStats = { input: 0, cachedInput: 0, output: 0 };
  let ms = 0;
  let tokens = 0;
  for (const c of calls.values()) {
    out.input += c.input;
    out.cachedInput += c.cached;
    out.output += c.output;
    if (c.start === null || c.output <= 0) continue;
    ms += c.end - c.start;
    tokens += c.output;
  }
  return ms > 0 ? { ...out, decode: { ms, tokens, basis: "request" } } : out;
}
