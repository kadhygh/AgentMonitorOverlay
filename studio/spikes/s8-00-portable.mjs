// S8-00: does the portable build run? Starts the packaged exe in test mode (off-screen window, never focused) with a
// sandbox data dir and the mock models, then drives it through the Host API: a Claude (mock) and a Codex (mock)
// session each answer once. Measures startup time. Never touches real projects or real models.
//   node scripts/package-portable.mjs <dir> && node spikes/s8-00-portable.mjs <dir>
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MOCK_MODEL_CATALOG, removeTempDir, startMockAnthropic, startMockModel } from "../packages/testkit/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const built = process.argv[2];
if (!built) throw new Error("usage: node spikes/s8-00-portable.mjs <package output dir>");
const exe = join(built, "AMO Studio", "AMO Studio.exe");
if (!existsSync(exe)) throw new Error(`${exe} not found`);

const sandbox = join(tmpdir(), "amo-studio-sandbox");
mkdirSync(sandbox, { recursive: true });
const root = mkdtempSync(join(sandbox, "s8-00-run-"));
// --portable-default: no AMO_STUDIO_DATA_DIR, so the build must pick data/ next to its exe (S8-01).
const portableDefault = process.argv.includes("--portable-default");
const dataDir = portableDefault ? join(built, "AMO Studio", "data") : join(root, "data");
const codexHome = join(root, "codex-home");
const ws = join(root, "workspace");
for (const d of [dataDir, codexHome, ws]) mkdirSync(d, { recursive: true });

const results = { startedAt: new Date().toISOString(), exe: exe.replace(tmpdir(), "%TEMP%"), dataDir: dataDir.replace(tmpdir(), "%TEMP%") };
if (portableDefault) delete process.env.AMO_STUDIO_DATA_DIR;
const mock = await startMockModel();
const claudeMock = await startMockAnthropic();
const t0 = Date.now();
const child = spawn(exe, [], {
  env: {
    ...process.env,
    AMO_STUDIO_TEST: "1",
    ...(portableDefault ? {} : { AMO_STUDIO_DATA_DIR: dataDir }),
    AMO_STUDIO_PORT: "0",
    AMO_STUDIO_TEST_PROVIDER_URL: mock.baseUrl,
    AMO_STUDIO_TEST_CATALOG: MOCK_MODEL_CATALOG,
    AMO_STUDIO_TEST_CODEX_HOME: codexHome,
    AMO_STUDIO_TEST_CLAUDE_URL: claudeMock.baseUrl,
  },
  stdio: "ignore",
  windowsHide: true,
});

const until = async (pred, label, ms = 60_000) => {
  const start = Date.now();
  for (;;) {
    const v = await pred().catch(() => undefined);
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
async function api(method, path, body) {
  const info = JSON.parse(readFileSync(join(dataDir, "host.json"), "utf8"));
  const token = readFileSync(join(dataDir, "host-token"), "utf8").trim();
  const res = await fetch(`${info.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", connection: "close" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const reply = (sessionId) =>
  until(async () => (await api("GET", `/api/sessions/${sessionId}/items`)).find((i) => i.type === "agent" && !i.streaming)?.markdown, `reply in ${sessionId}`);

try {
  const state = await until(async () => (existsSync(join(dataDir, "host.json")) ? await api("GET", "/api/state") : undefined), "host up");
  results.hostUpMs = Date.now() - t0;
  results.profiles = state.profiles.map((p) => p.id);
  const w = await api("POST", "/api/workspaces", { path: ws });
  const claude = await api("POST", "/api/tasks", { title: "claude", scope: { kind: "workspace", workspaceId: w.id }, firstSession: { profileId: "claude-mock", text: "hello from portable" } });
  results.claudeReply = await reply(claude.session.id);
  const codex = await api("POST", "/api/tasks", { title: "codex", scope: { kind: "workspace", workspaceId: w.id }, firstSession: { profileId: "codex-mock", text: "hello codex" } });
  results.codexReply = await reply(codex.session.id);
  // The UI is served by the packaged Host.
  const info = JSON.parse(readFileSync(join(dataDir, "host.json"), "utf8"));
  results.uiServed = (await (await fetch(`${info.url}/`, { headers: { connection: "close" } })).text()).includes("<div id=\"root\"");
} catch (err) {
  results.error = String(err?.message ?? err);
  process.exitCode = 1;
} finally {
  // Stop the app we started (and its Host and app-servers): our own process tree only.
  try {
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } catch {}
  await mock.close();
  await claudeMock.close();
  results.finishedAt = new Date().toISOString();
  writeFileSync(join(here, "results", portableDefault ? "s8-01-portable-default.json" : "s8-00-portable.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  await new Promise((r) => setTimeout(r, 1500));
  removeTempDir(root);
}
