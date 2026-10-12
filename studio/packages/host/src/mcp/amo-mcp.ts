import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { HostService } from "../service.js";
import { NotFoundError, ReadModel } from "./read-model.js";

// AMO MCP (read-only, stage 4): what an agent can learn about the workbench. Served by the Host at /mcp over
// Streamable HTTP in stateless mode (one server per request), behind the same bearer token as the REST API.

export const AMO_MCP_NAME = "amo";
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

/** Runs a read and turns a missing id into a tool error the agent can read, instead of a protocol error. */
function answer(read: () => unknown) {
  try {
    return json(read());
  } catch (err) {
    if (err instanceof NotFoundError) return { content: [{ type: "text" as const, text: err.message }], isError: true };
    throw err;
  }
}

export function createAmoMcpServer(service: HostService): McpServer {
  const model = new ReadModel(service);
  const server = new McpServer({ name: AMO_MCP_NAME, version: "0.4.0" }, { instructions: "AMO Studio workbench, read-only: the board, tasks, session trees, workspaces and the canvas." });

  server.registerTool(
    "board_list",
    {
      title: "看板",
      description: "Tasks on the AMO board (most recently active first) with their column, status and workspace. Filter by workspace (id or name) or column.",
      inputSchema: { workspace: z.string().optional(), column: z.enum(["todo", "doing", "review", "done"]).optional() },
      annotations: READ_ONLY,
    },
    (args) => answer(() => model.boardList(args)),
  );

  server.registerTool(
    "task_get",
    {
      title: "任务详情",
      description: "One task: column, status, workspace, the tasks it depends on and that depend on it, its canvas group and its sessions (no transcripts).",
      inputSchema: { taskId: z.string() },
      annotations: READ_ONLY,
    },
    ({ taskId }) => answer(() => model.taskGet(taskId)),
  );

  server.registerTool(
    "session_tree",
    {
      title: "会话树",
      description: "A task's sessions as a tree (main sessions, branches, subagents) with an excerpt of each one's latest reply.",
      inputSchema: { taskId: z.string() },
      annotations: READ_ONLY,
    },
    ({ taskId }) => answer(() => model.sessionTree(taskId)),
  );

  server.registerTool(
    "project_context",
    {
      title: "项目信息",
      description: "Registered workspaces (name, path, open tasks). With a workspace (id or name), that workspace and its open tasks.",
      inputSchema: { workspace: z.string().optional() },
      annotations: READ_ONLY,
    },
    ({ workspace }) => answer(() => model.projectContext(workspace)),
  );

  server.registerTool(
    "canvas_read",
    {
      title: "画布",
      description: "The canvas as structure, without coordinates: groups with their tasks and notes, ungrouped items, tasks not placed yet, and dependencies. Returns a readable outline and the same data as JSON.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    () => {
      const { outline, json: data } = model.canvasRead();
      return { content: [{ type: "text" as const, text: outline }, { type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    },
  );

  return server;
}

/** Handles one /mcp request (already authenticated). */
export async function handleMcpRequest(service: HostService, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const server = createAmoMcpServer(service);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
