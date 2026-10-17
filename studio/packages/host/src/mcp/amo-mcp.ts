import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { HostService } from "../service.js";
import { MCP_SESSION_HEADER, type McpIdentities } from "./identity.js";
import { AMO_MCP_INSTRUCTIONS, AMO_MCP_NAME, amoToolsFor, type McpCaller } from "./tools.js";
import { PROMPTED_WRITE_TOOLS } from "./names.js";
import { recordRole, roleCard } from "../features/guide/role.js";

// AMO MCP over Streamable HTTP, stateless (one server per request), served by the Host at /mcp. Codex sessions reach
// it with a token that opens /mcp only, plus a per-thread header naming the session; Claude sessions get the same
// tools in-process (see tools.ts). DSH sessions (stage 17) come the same way as Codex ones; DSH puts a server's
// instructions into its system prompt, so theirs carry the session's role card (as Claude's do), and DSH runs MCP
// tools without asking, so the writes the person approves first are left out for them.

/** `connecting`: the request is the client's `initialize`, the one that reads the instructions. */
export function createAmoMcpServer(service: HostService, caller: McpCaller | null = null, connecting = false): McpServer {
  const dsh = caller ? service.store.getSession(caller.sessionId)?.runtime === "dsh" : false;
  const server = new McpServer({ name: AMO_MCP_NAME, version: "0.5.0" }, { instructions: dsh && caller ? dshInstructions(service, caller.sessionId, connecting) : AMO_MCP_INSTRUCTIONS });
  const prompted = new Set<string>(PROMPTED_WRITE_TOOLS);
  for (const t of amoToolsFor(service, caller)) {
    if (dsh && prompted.has(t.name)) continue;
    const annotations = { readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false };
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations }, (args: Record<string, unknown>) => t.run(args));
  }
  return server;
}

/** The role card goes into the instructions; the session counts as told only when it connects. */
function dshInstructions(service: HostService, sessionId: string, connecting: boolean): string {
  try {
    const card = roleCard(service, sessionId);
    if (connecting) recordRole(service, sessionId);
    return `${AMO_MCP_INSTRUCTIONS}

${card}`;
  } catch {
    return AMO_MCP_INSTRUCTIONS;
  }
}

/** Handles one /mcp request (already authenticated). */
export async function handleMcpRequest(service: HostService, req: IncomingMessage, res: ServerResponse, body: unknown, identities?: McpIdentities): Promise<void> {
  const header = req.headers[MCP_SESSION_HEADER.toLowerCase()];
  const sessionId = identities?.sessionFor(Array.isArray(header) ? header[0] : header) ?? null;
  const connecting = !!body && typeof body === "object" && (body as { method?: unknown }).method === "initialize";
  const server = createAmoMcpServer(service, sessionId ? { sessionId } : null, connecting);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
