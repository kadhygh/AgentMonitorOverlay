import type { HostService } from "../service.js";
import { FEATURES } from "../features/index.js";
import { toolContext, type AmoTool, type McpCaller } from "./tool-kit.js";

// The AMO MCP tools, defined once: the Host serves them over HTTP at /mcp (Codex sessions), and Claude sessions get the
// same tools in-process through the SDK, so no token has to reach the Claude CLI.
// Reading is open to every caller. Writing (stage 5) is scoped to the session behind the call: Claude's in-process
// server is bound to its session; a Codex thread carries its own token in a header (spikes/RESULTS.md section j).
// Each feature declares its tools (features/<name>/mcp.ts).

export type { AmoTool, McpCaller, ToolResult } from "./tool-kit.js";

export const AMO_MCP_NAME = "amo";
/**
 * What every agent is told about AMO (stage 16, the stage 15 design): the server's instructions, which both CLIs hand
 * to the model. The role card is per session: Claude gets it appended here (each Claude session has its own server),
 * Codex as its thread's developer instructions (its server cannot tell sessions apart when it starts).
 */
export const AMO_MCP_INSTRUCTIONS = [
  "AMO Studio: the workbench the person uses to run and watch AI work. Work is organised as projects (a folder, usually a git repository), tasks (one piece of work in one project, optionally in a topic; each has its own sessions, a board column, a description, progress notes and a handoff) and topics (专题: related tasks, possibly across projects, on one canvas with groups, dependencies, notes, colour marks, and the topic's own documents).",
  "A task the person marks as 主控 (lead) coordinates its topic: it splits the work into tasks, arranges the canvas, describes the tasks and writes the topic's documents, while the work itself happens in each task's own sessions, which the person talks to directly. Every other task's session does its own task (执行). The person decides when to branch and when to merge; Studio never does.",
  // 2026-10-22: an agent's xargs -P 12 burst and a grep -r over a big checkout made the person's desktop lag.
  "The person works on this same machine while you run, often with several agents and big game projects open, so keep your commands light: do not fan out many processes at once (xargs -P, parallel loops, more than a few background jobs), search with rg or git grep limited to the folders that matter instead of grep -r over a whole checkout or drive, and cap test runners' workers (for example vitest --maxWorkers=4, dotnet test -m:2) unless the person asks for speed.",
  "Your role card (who you are, your task, topic, its 主控 and documents) is given to you when the session starts; when you do not have it, or need the current one, call amo_whoami. amo_guide explains each part (tasks, topics, canvas, collab, lead, files). Writes that touch other tasks or the canvas's structure ask the person first; your own task's notes, descriptions and colour marks do not.",
  "When the person wants to review a file or saved changes, use review_open: mode=file for its current content (optional line/endLine), mode=changes for its Git diff (optional base, commit or range). It opens the person's reviewer and defaults comments back to your session; it does not perform or approve a review. Save edits before reopening to show the latest content.",
].join("\n\n");

/** Every AMO tool for one caller (null: reading only): the features' tools, reading ones first; none of a feature turned off. */
export function amoToolsFor(service: HostService, caller: McpCaller | null): AmoTool[] {
  const ctx = toolContext(service, caller);
  const off = new Set<string>(service.config.disabledFeatures());
  const tools = FEATURES.filter((f) => !off.has(f.name)).flatMap((f) => f.tools?.(ctx) ?? []);
  return [...tools.filter((t) => t.readOnly), ...tools.filter((t) => !t.readOnly)];
}
