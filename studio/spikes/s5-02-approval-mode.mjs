// S5-02: what does each MCP tool approval mode do for a tool without readOnlyHint? (mock model, no budget)
//   npm run build && node spikes/s5-00-codex-identity.mjs
// A probe MCP server (port 47970) records the headers and URL of every tool call. One app-server (mock model, sandbox
// CODEX_HOME) runs several threads that each override the AMO MCP settings in thread/start `config`, then call the
// probe's `whoami` tool. No model budget.
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { codexServerSpec } from "../packages/host/dist/index.js";
import { mockCodexProvider, startMockModel } from "../packages/testkit/dist/index.js";
import { RpcClient, isTurnDone, sandboxWorkspace, startAppServer } from "./lib.mjs";

const cwd = sandboxWorkspace("s5-02/workspace");
const codexHome = sandboxWorkspace("s5-02/codex-home");
const calls = [];

// Probe MCP: one tool, answers with what it saw.
const probe = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const json = body ? JSON.parse(body) : undefined;
  const seen = { url: req.url, session: req.headers["x-amo-session"] ?? null, auth: req.headers.authorization ?? null };
  const server = new McpServer({ name: "amo", version: "0" });
  server.registerTool("whoami", { description: "Who is calling", inputSchema: {} }, () => {
    calls.push(seen);
    return { content: [{ type: "text", text: JSON.stringify(seen) }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, json);
});
await new Promise((r) => probe.listen(47970, "127.0.0.1", r));

const mock = await startMockModel();
const profile = { id: "codex-mock", label: "Mock", runtime: "codex", provider: "amo-mock", model: "mock-model", credentialId: "mock" };
const spec = codexServerSpec(profile, [profile], { read: () => "mock-key" }, { providers: { "amo-mock": mockCodexProvider(mock.baseUrl) }, mcp: { url: "http://127.0.0.1:47970/mcp", token: "server-wide-token" } });
let server = await startAppServer({ port: 47913, cwd, configArgs: spec.configArgs, env: { ...spec.env, CODEX_HOME: codexHome } });
const approvals = [];
const client = new RpcClient("spike", server.url, server.token, { onServerRequest: (e, c) => { approvals.push(`${e.method}: ${String(e.params?.message ?? "").slice(0, 120)}`); c.respond(e.id, e.method === "mcpServer/elicitation/request" ? { action: "accept", content: {}, _meta: null } : { decision: "accept" }); } });
const out = { variants: [] };

const modes = ["auto", "prompt", "writes", "approve"];
try {
  await client.connect();
  for (const mode of modes) {
    for (const scope of ["server", "tool"]) {
      const key = scope === "server" ? "mcp_servers.amo.default_tools_approval_mode" : "mcp_servers.amo.tools.whoami.approval_mode";
      const before = calls.length;
      const st = await client.request("thread/start", { cwd, approvalPolicy: "on-request", sandbox: "read-only", config: { [key]: mode } });
      const t = await client.request("turn/start", { threadId: st.thread.id, input: [{ type: "text", text: "[[mcp: whoami]]", text_elements: [] }] });
      await client.waitFor(isTurnDone(t.turn.id), 90_000);
      const asked = approvals.splice(0);
      const result = { mode, scope, asked: asked.length, ran: calls.length > before };
      out.variants.push(result);
      console.log(JSON.stringify(result));
    }
  }
} finally {
  client.close();
  await server.stop();
  await mock.close();
  probe.close();
  fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "results", "s5-02-approval-mode.json"), JSON.stringify(out, null, 2));
}
