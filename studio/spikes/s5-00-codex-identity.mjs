// S5-00: can one Codex app-server give each thread its own identity towards the AMO MCP?
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

const cwd = sandboxWorkspace("s5-00/workspace");
const codexHome = sandboxWorkspace("s5-00/codex-home");
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
let server = await startAppServer({ port: 47912, cwd, configArgs: spec.configArgs, env: { ...spec.env, CODEX_HOME: codexHome } });
const approvals = [];
const client = new RpcClient("spike", server.url, server.token, { onServerRequest: (e, c) => { approvals.push(`${e.method}: ${String(e.params?.message ?? "").slice(0, 120)}`); c.respond(e.id, e.method === "mcpServer/elicitation/request" ? { action: "accept", content: {}, _meta: null } : { decision: "accept" }); } });
const out = { variants: [] };

const variants = [
  { name: "none", config: undefined },
  { name: "dotted http_headers", config: { "mcp_servers.amo.http_headers": { "X-AMO-Session": "dotted" } } },
  { name: "nested http_headers", config: { mcp_servers: { amo: { http_headers: { "X-AMO-Session": "nested" } } } } },
  { name: "dotted url", config: { "mcp_servers.amo.url": "http://127.0.0.1:47970/mcp?session=by-url" } },
];

try {
  await client.connect();
  for (const v of variants) {
    const before = calls.length;
    let result;
    try {
      const st = await client.request("thread/start", { cwd, approvalPolicy: "on-request", sandbox: "read-only", ...(v.config ? { config: v.config } : {}) });
      const t = await client.request("turn/start", { threadId: st.thread.id, input: [{ type: "text", text: "[[mcp: whoami]]", text_elements: [] }] });
      await client.waitFor(isTurnDone(t.turn.id), 90_000);
      const last = mock.requests.at(-1);
      const agent = client.events.filter((e) => e.method === "item/completed" && e.params?.threadId === st.thread.id && e.params.item?.type === "agentMessage").map((e) => e.params.item.text);
      result = { thread: st.thread.id, approvals: approvals.splice(0), probeCalls: calls.slice(before), amoTools: (last?.tools ?? []).filter((x) => /amo|whoami/.test(x)), reply: agent.at(-1)?.slice(0, 200) };
    } catch (err) {
      result = { error: String(err.message ?? err).slice(0, 300) };
    }
    out.variants.push({ name: v.name, ...result });
    console.log(v.name, JSON.stringify(result));
  }
  // Does a thread keep its override after a resume (another connection, no config), and can resume set it again?
  const dotted = out.variants.find((v) => v.name === "dotted http_headers").thread;
  for (const [label, resumeConfig] of [["resume without config", undefined], ["resume with config", { "mcp_servers.amo.http_headers": { "X-AMO-Session": "resumed" } }]]) {
    const other = new RpcClient("other", server.url, server.token, { onServerRequest: (e, c) => c.respond(e.id, { action: "accept", content: {}, _meta: null }) });
    await other.connect();
    const before = calls.length;
    try {
      await other.request("thread/resume", { threadId: dotted, ...(resumeConfig ? { config: resumeConfig } : {}) });
      const t = await other.request("turn/start", { threadId: dotted, input: [{ type: "text", text: "[[mcp: whoami]]", text_elements: [] }] });
      await other.waitFor(isTurnDone(t.turn.id), 90_000);
      out.variants.push({ name: label, probeCalls: calls.slice(before) });
      console.log(label, JSON.stringify(calls.slice(before)));
    } catch (err) {
      console.log(label, "error", String(err.message ?? err).slice(0, 300));
    }
    other.close();
  }
  // After an app-server restart the thread must be loaded again: is the override kept, and can resume set it?
  client.close();
  await server.stop();
  server = await startAppServer({ port: 47912, cwd, configArgs: spec.configArgs, env: { ...spec.env, CODEX_HOME: codexHome } });
  const noneThread = out.variants.find((v) => v.name === "none").thread;
  for (const [label, threadId, resumeConfig] of [["after restart, resume without config", dotted, undefined], ["after restart, resume with config", noneThread, { "mcp_servers.amo.http_headers": { "X-AMO-Session": "after-restart" } }]]) {
    const c2 = new RpcClient("restart", server.url, server.token, { onServerRequest: (e, c) => c.respond(e.id, { action: "accept", content: {}, _meta: null }) });
    await c2.connect();
    const before = calls.length;
    try {
      await c2.request("thread/resume", { threadId, ...(resumeConfig ? { config: resumeConfig } : {}) });
      const t = await c2.request("turn/start", { threadId, input: [{ type: "text", text: "[[mcp: whoami]]", text_elements: [] }] });
      await c2.waitFor(isTurnDone(t.turn.id), 90_000);
      out.variants.push({ name: label, probeCalls: calls.slice(before) });
      console.log(label, JSON.stringify(calls.slice(before)));
    } catch (err) {
      console.log(label, "error", String(err.message ?? err).slice(0, 300));
    }
    c2.close();
  }
} finally {
  client.close();
  await server.stop();
  await mock.close();
  probe.close();
  fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "results", "s5-00.json"), JSON.stringify(out, null, 2));
}
