import { z } from "zod";
import { NotFoundError, type ReadModel } from "./read-model.js";

// The AMO MCP tools (read-only, stage 4), defined once: the Host serves them over HTTP at /mcp (Codex sessions), and
// Claude sessions get the same tools in-process through the SDK, so no token has to reach the Claude CLI.

export const AMO_MCP_NAME = "amo";
export const AMO_MCP_INSTRUCTIONS = "AMO Studio workbench, read-only: the board, tasks, session trees, workspaces and the canvas.";

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

export function amoTools(model: ReadModel): AmoTool[] {
  return [
    {
      name: "board_list",
      title: "看板",
      description: "Tasks on the AMO board (most recently active first) with their column, status and workspace. Filter by workspace (id or name) or column.",
      inputSchema: { workspace: z.string().optional(), column: z.enum(["todo", "doing", "review", "done"]).optional() },
      run: (args) => answer(() => model.boardList(args as { workspace?: string; column?: "todo" | "doing" | "review" | "done" })),
    },
    {
      name: "task_get",
      title: "任务详情",
      description: "One task: column, status, workspace, the tasks it depends on and that depend on it, its canvas group and its sessions (no transcripts).",
      inputSchema: { taskId: z.string() },
      run: (args) => answer(() => model.taskGet(String(args.taskId))),
    },
    {
      name: "session_tree",
      title: "会话树",
      description: "A task's sessions as a tree (main sessions, branches, subagents) with an excerpt of each one's latest reply.",
      inputSchema: { taskId: z.string() },
      run: (args) => answer(() => model.sessionTree(String(args.taskId))),
    },
    {
      name: "project_context",
      title: "项目信息",
      description: "Registered workspaces (name, path, open tasks). With a workspace (id or name), that workspace and its open tasks.",
      inputSchema: { workspace: z.string().optional() },
      run: (args) => answer(() => model.projectContext(args.workspace === undefined ? undefined : String(args.workspace))),
    },
    {
      name: "canvas_read",
      title: "画布",
      description: "The canvas as structure, without coordinates: groups with their tasks and notes, ungrouped items, tasks not placed yet, and dependencies. Returns a readable outline and the same data as JSON.",
      inputSchema: {},
      run: () => {
        const { outline, json: data } = model.canvasRead();
        return { content: [{ type: "text", text: outline }, { type: "text", text: JSON.stringify(data, null, 2) }] };
      },
    },
  ];
}
