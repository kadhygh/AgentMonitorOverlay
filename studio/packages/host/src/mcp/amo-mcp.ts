import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { HostService } from "../service.js";
import { MCP_SESSION_HEADER, type McpIdentities } from "./identity.js";
import { AMO_MCP_INSTRUCTIONS, AMO_MCP_NAME, amoToolsFor, type McpCaller } from "./tools.js";

// AMO MCP over Streamable HTTP, stateless (one server per request), served by the Host at /mcp. Codex sessions reach
// it with a token that opens /mcp only, plus a per-thread header naming the session; Claude sessions get the same
// tools in-process (see tools.ts).

export function createAmoMcpServer(service: HostService, caller: McpCaller | null = null): McpServer {
  const server = new McpServer({ name: AMO_MCP_NAME, version: "0.5.0" }, { instructions: AMO_MCP_INSTRUCTIONS });
  for (const t of amoToolsFor(service, caller)) {
    const annotations = { readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false };
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations }, (args: Record<string, unknown>) => t.run(args));
  }
  return server;
}

/** Handles one /mcp request (already authenticated). */
export async function handleMcpRequest(service: HostService, req: IncomingMessage, res: ServerResponse, body: unknown, identities?: McpIdentities): Promise<void> {
  const header = req.headers[MCP_SESSION_HEADER.toLowerCase()];
  const sessionId = identities?.sessionFor(Array.isArray(header) ? header[0] : header) ?? null;
  const server = createAmoMcpServer(service, sessionId ? { sessionId } : null);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
