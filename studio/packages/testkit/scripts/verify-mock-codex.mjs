// Runs the real `codex app-server` against the local mock model: one plain turn and one turn with an approved
// shell command. Spends no model budget. Usage: npm run build && node packages/testkit/scripts/verify-mock-codex.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMockModel } from "../dist/mock-model.js";
import { RpcClient, agentText, isTurnDone, sandboxWorkspace, startAppServer } from "../../../spikes/lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = path.join(here, "..", "assets", "mock-model.models.json").replaceAll("\\", "/");
const cwd = sandboxWorkspace("mock-codex");
const codexHome = sandboxWorkspace("codex-home-mock");

const mock = await startMockModel({ port: 47950 });
const providerArgs = [
  ["model_providers.amo-mock.name", "Mock"],
  ["model_providers.amo-mock.base_url", mock.baseUrl],
  ["model_providers.amo-mock.wire_api", "responses"],
  ["model_providers.amo-mock.env_key", "AMO_MOCK_API_KEY"],
  ["model_catalog_json", catalog],
  ["model_provider", "amo-mock"],
  ["model", "mock-model"],
].flatMap(([k, v]) => ["-c", `${k}=${JSON.stringify(v)}`]);

const server = await startAppServer({ port: 47914, cwd, configArgs: providerArgs, env: { CODEX_HOME: codexHome, AMO_MOCK_API_KEY: "mock" } });
const client = new RpcClient("verify", server.url, server.token, {
  onServerRequest: (e, c) => c.respond(e.id, { decision: "accept" }),
});
let threadId;
let ok = false;
try {
  await client.connect();
  const st = await client.request("thread/start", { cwd, approvalPolicy: "untrusted", sandbox: "read-only" });
  threadId = st.thread.id;

  const t1 = await client.request("turn/start", { threadId, input: [{ type: "text", text: "hello mock" }] });
  const d1 = await client.waitFor(isTurnDone(t1.turn.id), 60000);
  const reply1 = agentText(client.events, t1.turn.id);
  const deltas = client.events.filter((e) => e.method === "item/agentMessage/delta" && e.params.turnId === t1.turn.id).length;
  console.log("turn 1:", d1.params.turn.status, JSON.stringify(reply1), `deltas=${deltas}`);

  const t2 = await client.request("turn/start", { threadId, input: [{ type: "text", text: "[[shell: cmd /c echo mock-shell-ok]]" }] });
  const d2 = await client.waitFor(isTurnDone(t2.turn.id), 60000);
  const approvals = client.events.filter((e) => e.kind === "request").map((e) => e.method);
  const cmd = client.events.filter((e) => e.method === "item/completed" && e.params.turnId === t2.turn.id && e.params.item?.type === "commandExecution")
    .map((e) => ({ status: e.params.item.status, output: String(e.params.item.aggregatedOutput ?? "").trim() }));
  const reply2 = agentText(client.events, t2.turn.id);
  console.log("turn 2:", d2.params.turn.status, JSON.stringify(reply2), "approvals:", approvals, "command:", JSON.stringify(cmd));
  console.log("mock saw tools:", mock.requests[0]?.tools.join(","));

  ok = d1.params.turn.status === "completed" && reply1 === "MOCK: hello mock" && deltas > 0
    && d2.params.turn.status === "completed" && reply2 === "MOCK-DONE" && approvals.length > 0 && cmd.some((c) => c.output.includes("mock-shell-ok"));
} catch (e) {
  console.error("FATAL", e.message, server.state.stderr.slice(-1500));
} finally {
  if (threadId) await client.request("thread/archive", { threadId }).catch(() => {});
  client.close();
  await server.stop();
  await mock.close();
  fs.rmSync(codexHome, { recursive: true, force: true });
}
console.log(ok ? "PASS: real codex app-server ran against the mock model" : "FAIL");
process.exit(ok ? 0 : 1);
