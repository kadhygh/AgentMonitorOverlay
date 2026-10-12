import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { HostService } from "../service.js";
import { ReadModel } from "./read-model.js";
import { AMO_MCP_INSTRUCTIONS, AMO_MCP_NAME, amoTools } from "./tools.js";

// AMO MCP over Streamable HTTP, stateless (one server per request), served by the Host at /mcp. Codex sessions reach
// it with a token that opens /mcp only; Claude sessions get the same tools in-process (see tools.ts).

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

export function createAmoMcpServer(service: HostService): McpServer {
  const server = new McpServer({ name: AMO_MCP_NAME, version: "0.4.0" }, { instructions: AMO_MCP_INSTRUCTIONS });
  for (const t of amoTools(new ReadModel(service))) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: READ_ONLY }, (args: Record<string, unknown>) => t.run(args));
  }
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
