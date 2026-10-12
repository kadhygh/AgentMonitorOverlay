// S6-07 real smoke: extension packs with real models, through the Host, in a sandbox.
//   npm run build && node scripts/smoke-stage6.mjs
// The example pack (studio/examples/packs/demo) is copied into a sandbox workspace. For GLM (Claude) and DeepSeek
// (Codex) each: a task from the pack's template, a session from a preset draft (the preset's prompt plus a smoke
// instruction, as a person would edit it), the agent reads a pack document with pack_doc, then ticks a step of its
// own task's checklist with checklist_check. Any other approval (e.g. a shell command) is declined. Sandbox data dir,
// CODEX_HOME and workspace under %TEMP%\amo-studio-sandbox; Host on 47962; every real turn is counted in budget.json;
// sessions are archived at the end.
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RecordingTerminalLauncher, startHost } from "../packages/host/dist/index.js";
import { removeTempDir, reserveModelTurn } from "../packages/testkit/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = join(tmpdir(), "amo-studio-sandbox");
mkdirSync(sandbox, { recursive: true });
const root = mkdtempSync(join(sandbox, "smoke-stage6-"));
const dataDir = join(root, "data");
const codexHome = join(root, "codex-home");
const workspaceDir = join(root, "workspace");
for (const d of [dataDir, codexHome, workspaceDir]) mkdirSync(d, { recursive: true });
writeFileSync(join(workspaceDir, "README.md"), "# Studio smoke workspace\n");
cpSync(join(here, "..", "examples", "packs", "demo"), join(workspaceDir, ".amo", "packs", "demo"), { recursive: true });

const resultsFile = join(here, "..", "spikes", "results", "s6-07-smoke.json");
const results = { startedAt: new Date().toISOString(), steps: [] };
const step = (name, data) => {
  results.steps.push({ name, ...data });
  console.log(`${name}: ${JSON.stringify(data).slice(0, 500)}`);
  writeFileSync(resultsFile, JSON.stringify(results, null, 2));
};
const count = (provider, note) => {
  const r = reserveModelTurn(provider, note);
  console.log(`[budget] ${provider} ${r.used}/${r.limit}`);
};

async function api(host, method, path, body) {
  const res = await fetch(`${host.info.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json", connection: "close" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const session = async (host, id) => (await api(host, "GET", "/api/state")).sessions.find((s) => s.id === id);
const items = (host, id) => api(host, "GET", `/api/sessions/${id}/items`);
const agents = (list) => list.filter((i) => i.type === "agent" && !i.streaming);

/** Sends `text` (unless null) and waits for a new settled reply. Declines every approval and reports it. */
async function turn(host, id, text, { timeoutMs = 300_000 } = {}) {
  const before = agents(await items(host, id)).length;
  if (text !== null) await api(host, "POST", `/api/sessions/${id}/messages`, { text });
  const start = Date.now();
  const declined = [];
  while (Date.now() - start < timeoutMs) {
    const list = await items(host, id);
    const pending = list.find((i) => i.type === "approval" && i.state === "pending");
    if (pending) {
      declined.push(pending.summary);
      await api(host, "POST", `/api/approvals/${encodeURIComponent(pending.approvalId)}`, { sessionId: id, decision: "decline" });
    } else {
      const s = await session(host, id);
      if (s.status === "error" || ((s.status === "idle" || s.status === "completed") && agents(list).length > before)) {
        return { status: s.status, reply: agents(list).at(-1)?.markdown?.slice(0, 300) ?? null, declined, tools: list.filter((i) => i.type === "tool").slice(-3).map((i) => `${i.name}:${i.status}`), errors: list.filter((i) => i.type === "error").map((i) => i.message) };
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`session ${id} did not settle`);
}

const SMOKE_NOTE =
  "\n\n（冒烟测试，请不要改代码、不要运行命令：只用 amo MCP 的 pack_doc 工具读扩展包 demo 里的文档 pitfalls（workspace 填 smoke），然后用一句话说出第一条坑。）";

async function run(host, ws, { provider, profileId, presetId, label }) {
  const created = await api(host, "POST", "/api/tasks", {
    title: `${label} 冒烟`,
    scope: { kind: "workspace", workspaceId: ws.id },
    firstSession: { profileId },
    template: { workspaceId: ws.id, pack: "demo", template: "gameplay" },
  });
  const sessions = [created.session.id];
  const checklist = await api(host, "GET", `/api/checklist?taskId=${created.task.id}`);
  const draft = await api(host, "POST", `/api/workspaces/${ws.id}/packs/demo/presets/${presetId}/draft`, { taskId: created.task.id });
  step(`${label}-template-and-draft`, { title: created.task.title, steps: checklist.length, draftProfile: draft.profileId, warnings: draft.warnings, files: draft.contextFiles });

  count(provider, `S6-07 ${label} pack_doc`);
  const s = await api(host, "POST", `/api/tasks/${created.task.id}/sessions`, { profileId: draft.profileId ?? profileId, text: draft.text + SMOKE_NOTE });
  sessions.push(s.id);
  step(`${label}-pack-doc`, await turn(host, s.id, null));

  count(provider, `S6-07 ${label} checklist_check`);
  const ticked = await turn(host, s.id, `Use the amo MCP tool checklist_check with itemId "${checklist[0].id}" to tick the first step of your task's checklist. Do nothing else. Then reply with the single word DONE.`);
  const after = await api(host, "GET", `/api/checklist?taskId=${created.task.id}`);
  step(`${label}-checklist`, { ...ticked, first: { done: after[0].done, bySession: after[0].doneBySessionId === s.id } });
  return sessions;
}

let host;
const created = [];
try {
  host = await startHost({ dataDir, port: 47962, codexEnv: { CODEX_HOME: codexHome }, launcher: new RecordingTerminalLauncher() });
  const ws = await api(host, "POST", "/api/workspaces", { path: workspaceDir, name: "smoke" });
  const packs = await api(host, "GET", `/api/workspaces/${ws.id}/packs`);
  step("packs", { packs: packs.map((p) => [p.dirName, p.manifest?.title, p.errors.length]) });
  created.push(...(await run(host, ws, { provider: "glm", profileId: "claude-glm", presetId: "review", label: "GLM" })));
  created.push(...(await run(host, ws, { provider: "deepseek", profileId: "codex-deepseek-flash", presetId: "implement", label: "DeepSeek" })));
} catch (err) {
  step("failed", { error: String(err?.message ?? err).split(/\r?\n/)[0] });
  process.exitCode = 1;
} finally {
  if (host) {
    for (const id of created) await api(host, "POST", `/api/sessions/${id}/archive`).catch(() => undefined);
    await host.shutdown();
  }
  results.finishedAt = new Date().toISOString();
  writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  removeTempDir(root);
}
