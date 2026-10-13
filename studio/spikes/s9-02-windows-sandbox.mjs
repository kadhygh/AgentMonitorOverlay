// S9-02: which `windows.sandbox` setting lets commands run? (mock model, no budget)
//   npm run build && node spikes/s9-02-windows-sandbox.mjs
// The person's ~/.codex/config.toml has `[windows] sandbox = "unelevated"`; with it, GPT's commands failed in S9-01
// ("CreateProcessAsUserW failed: 5"). Each variant runs one app-server (sandbox CODEX_HOME, mock model) with a
// `-c windows.sandbox=...` override and asks for one PowerShell command, approved at once.
import fs from "node:fs";
import path from "node:path";
import { codexServerSpec } from "../packages/host/dist/index.js";
import { mockCodexProvider, startMockModel } from "../packages/testkit/dist/index.js";
import { RpcClient, isTurnDone, sandboxWorkspace, startAppServer } from "./lib.mjs";

const cwd = sandboxWorkspace("s9-02/workspace");
fs.writeFileSync(path.join(cwd, "importer.py"), "print('hi')\n");
const mock = await startMockModel();
const profile = { id: "codex-mock", label: "Mock", runtime: "codex", provider: "amo-mock", model: "mock-model", credentialId: "mock" };
const spec = codexServerSpec(profile, [profile], { read: () => "mock-key" }, { providers: { "amo-mock": mockCodexProvider(mock.baseUrl) } });
// "elevated" is left out: it may ask for administrator rights (a UAC window).
const variants = [null, "unelevated", "none", "disabled"];
const out = [];
let port = 47914;
for (const v of variants) {
  const codexHome = sandboxWorkspace(`s9-02/codex-home-${v ?? "unset"}`);
  const extra = v === null ? [] : ["-c", `windows.sandbox=${JSON.stringify(v)}`];
  let server;
  try {
    server = await startAppServer({ port: port++, cwd, configArgs: [...spec.configArgs, ...extra], env: { ...spec.env, CODEX_HOME: codexHome } });
  } catch (err) {
    out.push({ sandbox: v, start: String(err).slice(0, 300) });
    continue;
  }
  const events = [];
  const client = new RpcClient("s9-02", server.url, server.token, { onServerRequest: (e, c) => c.respond(e.id, { decision: "accept" }), onNotification: (e) => events.push(e) });
  try {
    await client.connect();
    const st = await client.request("thread/start", { cwd, approvalPolicy: "on-request", sandbox: "workspace-write" });
    const t = await client.request("turn/start", { threadId: st.thread.id, input: [{ type: "text", text: "[[shell: Get-Content importer.py]]", text_elements: [] }] });
    await client.waitFor(isTurnDone(t.turn.id), 90_000);
    const cmd = [...client.events ?? events].reverse().find((e) => e.method === "item/completed" && e.params?.item?.type === "commandExecution")?.params.item;
    out.push({ sandbox: v, status: cmd?.status ?? "no command", exitCode: cmd?.exitCode ?? null, output: String(cmd?.aggregatedOutput ?? "").slice(0, 160) });
  } catch (err) {
    out.push({ sandbox: v, error: String(err).slice(0, 300) });
  } finally {
    client.close();
    await server.stop();
  }
  console.log(JSON.stringify(out.at(-1)));
}
await mock.close();
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "results", "s9-02-windows-sandbox.json"), JSON.stringify(out, null, 2));
