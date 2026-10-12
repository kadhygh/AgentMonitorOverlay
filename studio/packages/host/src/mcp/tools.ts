import { z } from "zod";
import type { Id } from "@amo-studio/protocol";
import { HostError, type HostService } from "../service.js";
import { NotFoundError, ReadModel } from "./read-model.js";

// The AMO MCP tools, defined once: the Host serves them over HTTP at /mcp (Codex sessions), and Claude sessions get the
// same tools in-process through the SDK, so no token has to reach the Claude CLI.
// Reading is open to every caller. Writing (stage 5) is scoped to the session behind the call: Claude's in-process
// server is bound to its session; a Codex thread carries its own token in a header (spikes/RESULTS.md section j).

export const AMO_MCP_NAME = "amo";
export const AMO_MCP_INSTRUCTIONS =
  "AMO Studio workbench. Read the board, tasks, session trees, workspaces and the canvas; record progress notes and handoff summaries on your own task; leave and read mail between sessions (the person decides when mail enters a conversation); ask the person for a decision (the answer comes back as mail).";

/** The session a tool call comes from, if Studio could tell. */
export interface McpCaller {
  sessionId: Id;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface AmoTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** Reads only Studio's state (annotated readOnlyHint). */
  readOnly: boolean;
  /**
   * Runs without asking the person: reads, and writes that only touch the caller's own task. Codex gets
   * `tools.<name>.approval_mode = "approve"` for these; Claude lists them in allowedTools.
   */
  autoApprove: boolean;
  run(args: Record<string, unknown>): ToolResult;
}

const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

/** Runs a read and turns a missing id into a tool error the agent can read, instead of a protocol error. */
function answer(read: () => unknown): ToolResult {
  try {
    return json(read());
  } catch (err) {
    if (err instanceof NotFoundError) return { content: [{ type: "text", text: err.message }], isError: true };
    throw err;
  }
}

const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Runs a write for the caller; Studio's own refusals become readable tool errors. */
function write(caller: McpCaller | null, run: (caller: McpCaller) => unknown): ToolResult {
  if (!caller) return fail("这次调用没有 AMO 会话身份（例如由 Codex 自己派生的子 agent），只能使用只读工具。");
  try {
    return json(run(caller));
  } catch (err) {
    if (err instanceof HostError) return fail(err.message);
    throw err;
  }
}

/** Every AMO tool for one caller (null: reading only). */
export function amoToolsFor(service: HostService, caller: McpCaller | null): AmoTool[] {
  return [...amoTools(new ReadModel(service)), ...writeTools(service, caller)];
}


function writeTools(service: HostService, caller: McpCaller | null): AmoTool[] {
  const ownTask = (c: McpCaller) => service.store.getSession(c.sessionId)!.taskId;
  return [
    {
      name: "task_note_add",
      title: "记进度",
      description: "Add a short progress note to your own AMO task (what was done, what is next, what blocks). The person sees it on the task page. Cannot move the task between board columns.",
      inputSchema: { text: z.string() },
      readOnly: false,
      autoApprove: true,
      run: (args) => write(caller, (c) => service.addTaskNote(ownTask(c), { text: args.text, kind: "progress" }, c.sessionId)),
    },
    {
      name: "handoff_submit",
      title: "提交交接",
      description: "Submit a handoff summary for your own AMO task: what is done, what is left, where the relevant files are, and anything the next session must know.",
      inputSchema: { summary: z.string() },
      readOnly: false,
      autoApprove: true,
      run: (args) => write(caller, (c) => service.addTaskNote(ownTask(c), { text: args.summary, kind: "handoff" }, c.sessionId)),
    },
    {
      name: "mailbox_send",
      title: "留言",
      description:
        "Leave a message for another AMO session (toSessionId) or for a task (toTaskId); find ids with board_list, task_get or session_tree. It does not enter their conversation by itself: the person decides when to forward it, and the recipient can read it with mailbox_read.",
      inputSchema: { toSessionId: z.string().optional(), toTaskId: z.string().optional(), text: z.string() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const to = typeof args.toSessionId === "string" ? { kind: "session", sessionId: args.toSessionId } : typeof args.toTaskId === "string" ? { kind: "task", taskId: args.toTaskId } : null;
          if (!to) throw new HostError("bad_request", "give toSessionId or toTaskId");
          const m = service.sendMail(c.sessionId, to, args.text);
          return { id: m.id, to: m.to, state: m.state };
        }),
    },
    {
      name: "decision_request",
      title: "请求决策",
      description:
        "Ask the person to decide something you should not decide alone (offer short options when you can). It is shown in the AMO workbench and the Focus window; it does not block your turn. The answer comes back to you as mail (mailbox_read).",
      inputSchema: { question: z.string(), options: z.array(z.string()).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) =>
        write(caller, (c) => {
          const d = service.requestDecisionFromSession(c.sessionId, args.question, args.options);
          return { id: d.id, state: d.state, note: "The answer will arrive as mail; read it with mailbox_read." };
        }),
    },
    {
      name: "mailbox_read",
      title: "读留言",
      description: "Read the unread messages left for you or for your task (they are then marked read).",
      inputSchema: {},
      readOnly: false,
      autoApprove: true,
      run: () =>
        write(caller, (c) => {
          const title = (id: Id | null) => (id ? service.store.getSession(id)?.title || "会话" : "我（人）");
          return {
            // The text first: it is what the agent needs, the routing is context.
            messages: service.readMailFromSession(c.sessionId).map((m) => ({
              text: m.text,
              from: m.fromSessionId ? { sessionId: m.fromSessionId, title: title(m.fromSessionId), taskId: m.fromTaskId } : "person",
              to: m.to,
              at: m.createdAt,
            })),
          };
        }),
    },
  ];
}

export function amoTools(model: ReadModel): AmoTool[] {
  return [
    {
      name: "board_list",
      title: "看板",
      description: "Tasks on the AMO board (most recently active first) with their column, status and workspace. Filter by workspace (id or name) or column.",
      inputSchema: { workspace: z.string().optional(), column: z.enum(["todo", "doing", "review", "done"]).optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.boardList(args as { workspace?: string; column?: "todo" | "doing" | "review" | "done" })),
    },
    {
      name: "task_get",
      title: "任务详情",
      description: "One task: column, status, workspace, the tasks it depends on and that depend on it, its canvas group and its sessions (no transcripts).",
      inputSchema: { taskId: z.string() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.taskGet(String(args.taskId))),
    },
    {
      name: "session_tree",
      title: "会话树",
      description: "A task's sessions as a tree (main sessions, branches, subagents) with an excerpt of each one's latest reply.",
      inputSchema: { taskId: z.string() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.sessionTree(String(args.taskId))),
    },
    {
      name: "project_context",
      title: "项目信息",
      description: "Registered workspaces (name, path, open tasks). With a workspace (id or name), that workspace and its open tasks.",
      inputSchema: { workspace: z.string().optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => answer(() => model.projectContext(args.workspace === undefined ? undefined : String(args.workspace))),
    },
    {
      name: "canvas_read",
      title: "画布",
      description: "The canvas as structure, without coordinates: groups with their tasks and notes, ungrouped items, tasks not placed yet, and dependencies. Returns a readable outline and the same data as JSON.",
      inputSchema: {},
      readOnly: true,
      autoApprove: true,
      run: () => {
        const { outline, json: data } = model.canvasRead();
        return { content: [{ type: "text", text: outline }, { type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    },
  ];
}
