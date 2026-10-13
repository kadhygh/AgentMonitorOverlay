// S9-06: in the person's unelevated Windows sandbox, does any shell start? (mock, no budget)
//   npm run build && node spikes/s9-06-unelevated-shells.mjs
// S9-02/S9-05: sandboxed commands fail with "CreateProcessAsUserW failed: 5" — every time Codex started pwsh.exe from
// WindowsApps (the Store PowerShell 7, an app execution alias). exec_command takes a `shell` argument; each variant asks
// for one command through a different shell, sandboxed (workspace-write) under `windows.sandbox = "unelevated"`.
import fs from "node:fs";
import path from "node:path";
import { codexServerSpec } from "../packages/host/dist/index.js";
import { mockCodexProvider, startMockModel } from "../packages/testkit/dist/index.js";
import { RpcClient, sandboxWorkspace, startAppServer } from "./lib.mjs";

const cwd = sandboxWorkspace("s9-06/workspace");
fs.writeFileSync(path.join(cwd, "hello.txt"), "hello from the sandbox\n");
let shell = null;
const mock = await startMockModel({
  script: (req) =>
    req.afterToolOutput
      ? { kind: "text", text: "MOCK-DONE" }
      : { kind: "function_call", name: "exec_command", arguments: { cmd: shell?.startsWith("cmd") ? "type hello.txt" : "Get-Content hello.txt", ...(shell ? { shell } : {}) } },
});
const profile = { id: "codex-mock", label: "Mock", runtime: "codex", provider: "amo-mock", model: "mock-model", credentialId: "mock" };
const spec = codexServerSpec(profile, [profile], { read: () => "mock-key" }, { providers: { "amo-mock": mockCodexProvider(mock.baseUrl) } });
// The last variants hide WindowsApps (the Store PowerShell and its alias) from the app-server's PATH.
const shells = [null, "cmd", "cmd.exe", "powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "no-windowsapps", "no-windowsapps+auto-review"];
const pathWithoutWindowsApps = (process.env.PATH ?? process.env.Path ?? "").split(";").filter((d) => d && !/WindowsApps/i.test(d)).join(";");
const out = [];
let port = 47926;
for (const sh of shells) {
  const hide = sh?.startsWith("no-windowsapps");
  const review = sh?.endsWith("auto-review");
  shell = hide ? null : sh;
  const codexHome = sandboxWorkspace(`s9-06/codex-home-${out.length}`);
  const server = await startAppServer({ port: port++, cwd, configArgs: [...spec.configArgs, "-c", 'windows.sandbox="unelevated"'], env: { ...spec.env, CODEX_HOME: codexHome, ...(hide ? { PATH: pathWithoutWindowsApps, Path: pathWithoutWindowsApps } : {}) } });
  const client = new RpcClient("s9-06", server.url, server.token, { onServerRequest: (e, c) => c.respond(e.id, { decision: "decline" }) });
  try {
    await client.connect();
    const st = await client.request("thread/start", { cwd, approvalPolicy: "on-request", approvalsReviewer: review ? "auto_review" : "user", sandbox: "workspace-write" });
    await client.request("turn/start", { threadId: st.thread.id, input: [{ type: "text", text: "go", text_elements: [] }] });
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000 && !client.events.some((e) => e.method === "turn/completed")) await new Promise((r) => setTimeout(r, 200));
    const cmd = [...client.events].reverse().find((e) => e.method === "item/completed" && e.params?.item?.type === "commandExecution")?.params.item;
    out.push({ shell: sh, command: cmd?.command?.slice(0, 120) ?? null, status: cmd?.status ?? "none", exitCode: cmd?.exitCode ?? null, output: String(cmd?.aggregatedOutput ?? "").slice(0, 100) });
  } catch (err) {
    out.push({ shell: sh, error: String(err).slice(0, 200) });
  } finally {
    client.close();
    await server.stop();
  }
  console.log(JSON.stringify(out.at(-1)));
}
await mock.close();
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "results", "s9-06-unelevated-shells.json"), JSON.stringify(out, null, 2));
