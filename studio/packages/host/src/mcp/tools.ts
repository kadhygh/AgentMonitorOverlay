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
export const AMO_MCP_INSTRUCTIONS =
  "AMO Studio workbench. Work is organised as projects (workspaces), tasks (each in one project, optionally in one topic) and topics (专题: several tasks, possibly across projects, on one canvas, with their own coordinating sessions). Read the board, tasks, topics, session trees, projects and a topic's canvas; record progress notes and handoff summaries on your own task; leave and read mail between sessions, tasks and topics (the person decides when mail enters a conversation); ask the person for a decision (the answer comes back as mail); arrange your topic's canvas (groups, dependencies, which group a task is in) with the person's approval; read the project's extension packs (conventions, templates) and tick your own task's checklist.";

/** Every AMO tool for one caller (null: reading only): the features' tools, reading ones first; none of a feature turned off. */
export function amoToolsFor(service: HostService, caller: McpCaller | null): AmoTool[] {
  const ctx = toolContext(service, caller);
  const off = new Set<string>(service.config.disabledFeatures());
  const tools = FEATURES.filter((f) => !off.has(f.name)).flatMap((f) => f.tools?.(ctx) ?? []);
  return [...tools.filter((t) => t.readOnly), ...tools.filter((t) => !t.readOnly)];
}
