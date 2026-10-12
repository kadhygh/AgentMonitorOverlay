// S1-12 real smoke: Host + real Codex app-server + DeepSeek in a sandbox workspace.
//   npm run build && node scripts/smoke-stage1.mjs
// 1. two real turns through the Host API (context kept across turns)
// 2. the real Codex TUI attaches with `codex --remote` (hidden console, no focus) and holds a live connection
// 3. Host restart keeping app-servers: sessions and items reload, a third turn still routes to DeepSeek
// Uses a sandbox CODEX_HOME and workspace under %TEMP%\amo-studio-sandbox; counts every real turn in budget.json.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingTerminalLauncher, startHost } from "../packages/host/dist/index.js";
import { removeTempDir, reserveModelTurn } from "../packages/testkit/dist/index.js";

const sandbox = join(tmpdir(), "amo-studio-sandbox");
mkdirSync(sandbox, { recursive: true });
const root = mkdtempSync(join(sandbox, "smoke-stage1-"));
const dataDir = join(root, "data");
const codexHome = join(root, "codex-home");
const workspaceDir = join(root, "workspace");
for (const d of [dataDir, codexHome, workspaceDir]) mkdirSync(d, { recursive: true });
writeFileSync(join(workspaceDir, "README.md"), "# Studio smoke workspace\n");

const results = { startedAt: new Date().toISOString(), steps: [] };
const step = (name, data) => {
  results.steps.push({ name, ...data });
  console.log(`${name}: ${JSON.stringify(data)}`);
};
const count = (note) => {
  const r = reserveModelTurn("deepseek", note);
  console.log(`[budget] deepseek ${r.used}/${r.limit}`);
};

async function boot() {
  return startHost({ dataDir, port: 0, codexEnv: { CODEX_HOME: codexHome }, launcher: new RecordingTerminalLauncher() });
}

async function api(host, method, path, body) {
  const res = await fetch(`${host.info.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function waitReply(host, sessionId, afterCount, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const items = await api(host, "GET", `/api/sessions/${sessionId}/items`);
    const agents = items.filter((i) => i.type === "agent" && !i.streaming);
    const session = (await api(host, "GET", "/api/state")).sessions.find((s) => s.id === sessionId);
    if (agents.length > afterCount && session.status !== "running") return { text: agents.at(-1).markdown, items, status: session.status };
    if (session.status === "error") return { text: null, items, status: "error" };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("timed out waiting for the reply");
}

function establishedTo(port, pids) {
  const script = `Get-NetTCPConnection -RemotePort ${port} -State Established -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`;
  const out = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const owners = out.split(/\s+/).filter(Boolean).map(Number);
  return owners.filter((p) => pids.includes(p)).length;
}

function descendants(pid) {
  const script = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; $ids=@(${pid}); $i=0; while ($i -lt $ids.Count) { $ids += ($all | ? { $_.ParentProcessId -eq $ids[$i] } | % { $_.ProcessId }); $i++ }; $ids -join ' '`;
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
}

let host;
let tuiPid = null;
try {
  host = await boot();
  const ws = await api(host, "POST", "/api/workspaces", { path: workspaceDir, name: "smoke" });

  // 1. Two real turns.
  count("S1-12 turn 1");
  const { task, session } = await api(host, "POST", "/api/tasks", {
    title: "Stage 1 smoke",
    scope: { kind: "workspace", workspaceId: ws.id },
    firstSession: { profileId: "codex-deepseek-flash", text: "Remember the codeword LIME-4. Reply with exactly: OK" },
  });
  const r1 = await waitReply(host, session.id, 0);
  step("turn1", { reply: r1.text, status: r1.status });
  count("S1-12 turn 2");
  await api(host, "POST", `/api/sessions/${session.id}/messages`, { text: "What codeword did I ask you to remember? Reply with the codeword only." });
  const r2 = await waitReply(host, session.id, 1);
  step("turn2", { reply: r2.text, keptContext: /LIME-4/.test(r2.text ?? "") });

  // 2. Attach the real TUI in a hidden console and check it holds a connection to the app-server.
  const attach = await api(host, "POST", `/api/sessions/${session.id}/terminal`, { launch: false });
  const port = Number(/ws:\/\/127\.0\.0\.1:(\d+)/.exec(attach.command)[1]);
  const serverToken = (await import("node:fs")).readFileSync(join(dataDir, "codex", "codex-tokens", "codex-deepseek-flash.token"), "utf8").trim();
  const ps = `$env:${attach.envVar}='${serverToken}'; $env:CODEX_HOME='${codexHome}'; $p = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','${attach.command}' -WorkingDirectory '${workspaceDir}' -WindowStyle Hidden -PassThru; $p.Id`;
  // The token only lives in this PowerShell's environment, inherited by the hidden child; it is not on any command line.
  const launched = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "-"], { input: ps, encoding: "utf8" });
  tuiPid = Number(launched.stdout.trim());
  let connected = 0;
  for (let i = 0; i < 30 && !connected; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    connected = establishedTo(port, descendants(tuiPid));
  }
  await new Promise((r) => setTimeout(r, 3000));
  const alive = descendants(tuiPid).length > 1;
  step("tui-remote", { connectedSockets: connected, stillRunningAfterConnect: alive, commandHasToken: attach.command.includes(serverToken) });

  // 3. Restart the Host but keep app-servers; data reloads and a third turn still routes to DeepSeek.
  await host.shutdown({ keepServers: true });
  host = await boot();
  const state = await api(host, "GET", "/api/state");
  const items = await api(host, "GET", `/api/sessions/${session.id}/items`);
  step("host-restart", { tasks: state.tasks.length, sessionsBack: state.sessions.some((s) => s.id === session.id), itemsBack: items.length });
  count("S1-12 turn 3");
  await api(host, "POST", `/api/sessions/${session.id}/messages`, { text: "Reply with exactly: STILL-HERE" });
  const r3 = await waitReply(host, session.id, 2);
  step("turn3-after-restart", { reply: r3.text });

  await api(host, "POST", `/api/sessions/${session.id}/archive`);
  results.ok = r1.status !== "error" && /LIME-4/.test(r2.text ?? "") && connected > 0 && alive && /STILL-HERE/.test(r3.text ?? "") && state.tasks.some((t) => t.id === task.id);
} catch (err) {
  results.ok = false;
  results.error = String(err?.stack ?? err);
  console.error(err);
} finally {
  if (tuiPid) {
    try {
      execFileSync("taskkill", ["/pid", String(tuiPid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  }
  await host?.shutdown().catch(() => {});
  results.finishedAt = new Date().toISOString();
  writeFileSync(new URL("../spikes/results/s1-12-smoke.json", import.meta.url), JSON.stringify(results, null, 2) + "\n");
  removeTempDir(root);
}
console.log(results.ok ? "PASS" : "FAIL");
process.exit(results.ok ? 0 : 1);
