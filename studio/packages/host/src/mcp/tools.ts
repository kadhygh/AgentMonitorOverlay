import type { HostService } from "../service.js";
import { FEATURES } from "../features/index.js";
import type { Task } from "@amo-studio/protocol";
import { fail, toolContext, type AmoTool, type McpCaller } from "./tool-kit.js";

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
  "A report or review with many points (a batch of commits, an involved design) goes on your topic's canvas as review items (canvas_items_post), with remarks and questions pinned to the cards (canvas_callout), rather than in one long reply the person loses track of; amo_guide section canvas explains the flow.",
  "When the person wants to review a file or saved changes, use review_open: mode=file for its current content (optional line/endLine), mode=changes for its Git diff (optional base, commit or range). It opens the person's reviewer and defaults comments back to your session; it does not perform or approve a review. Save edits before reopening to show the latest content.",
  // 会话里用中转 (2026-10-30, plans/relay-in-sessions.md).
  "When the work needs someone on the team other than the person you work for — a programmer to confirm an implementation, an interface or the work it takes, or to check a plan — ask them with team_ask (AMO 中转; team_members lists who does what). It usually waits for the person's OK in Studio (the answer says), goes as the person marked as their AI's, and the reply comes back into this conversation by itself: end your turn after it instead of going on in the unconfirmed direction; then team_followup to ask again, team_done once settled. (task_message is different: it talks to another task's session inside Studio.)",
].join("\n\n");

/** Every AMO tool for one caller (null: reading only): the features' tools, reading ones first; none of a feature turned off. */
export function amoToolsFor(service: HostService, caller: McpCaller | null): AmoTool[] {
  const ctx = toolContext(service, caller);
  const off = new Set<string>(service.config.disabledFeatures());
  const tools = FEATURES.filter((f) => !off.has(f.name)).flatMap((f) => f.tools?.(ctx) ?? []).map((t) => keepOffRemoteCopies(service, t));
  return [...tools.filter((t) => t.readOnly), ...tools.filter((t) => !t.readOnly)];
}

/**
 * 远程 (2026-10-29): a copy of a task another computer granted this one (Task.remote, sessions running "remote") is that
 * computer's task — agents here neither read nor change it (no notes, 说明, mail, sessions, canvas). Any tool given the id
 * of such a task or of one of its sessions answers so; board_list leaves them out (read-model.ts).
 */
function keepOffRemoteCopies(service: HostService, tool: AmoTool): AmoTool {
  return {
    ...tool,
    run: (args) => {
      const copy = remoteCopyNamed(service, args);
      if (!copy?.remote) return tool.run(args);
      return fail(`「${copy.title || "未命名任务"}」是 ${copy.remote.name}（${copy.remote.account}）授权给这台电脑的远程任务，在那台电脑上运行：这里的 AMO 工具不读也不改它（只能由人在 Studio 里打开它操作）。`);
    },
  };
}

/** The remote copy whose id (a task's or a session's) is among a call's arguments, if any. */
export function remoteCopyNamed(service: HostService, args: unknown): Task | null {
  const ids = new Set<string>();
  const collect = (v: unknown, depth: number) => {
    if (typeof v === "string") {
      if (v.length <= 100) ids.add(v);
    } else if (depth < 2 && Array.isArray(v)) for (const x of v) collect(x, depth + 1);
    else if (depth < 2 && v && typeof v === "object") for (const x of Object.values(v)) collect(x, depth + 1);
  };
  collect(args, 0);
  for (const id of ids) {
    const task = service.store.getTask(id);
    if (task?.remote) return task;
    const session = task ? undefined : service.store.getSession(id);
    if (session?.runtime === "remote" && session.taskId) {
      const owner = service.store.getTask(session.taskId);
      if (owner?.remote) return owner;
    }
  }
  return null;
}
