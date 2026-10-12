// S5-08 real smoke: the stage 5 MCP writes with real models, through the Host, in a sandbox.
//   npm run build && node scripts/smoke-stage5.mjs
// GLM (Claude): progress note, decision request + answer read back from mail, a canvas group that waits for approval.
// DeepSeek (Codex): mail to the GLM session (per-thread identity), a handoff summary, a canvas group approved through
// an MCP elicitation. Sandbox data dir, CODEX_HOME and workspace under %TEMP%\amo-studio-sandbox; Host on 47961; every
// real turn is counted in budget.json; sessions are archived at the end.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RecordingTerminalLauncher, startHost } from "../packages/host/dist/index.js";
import { removeTempDir, reserveModelTurn } from "../packages/testkit/dist/index.js";

const sandbox = join(tmpdir(), "amo-studio-sandbox");
mkdirSync(sandbox, { recursive: true });
const root = mkdtempSync(join(sandbox, "smoke-stage5-"));
const dataDir = join(root, "data");
const codexHome = join(root, "codex-home");
const workspaceDir = join(root, "workspace");
for (const d of [dataDir, codexHome, workspaceDir]) mkdirSync(d, { recursive: true });
writeFileSync(join(workspaceDir, "README.md"), "# Studio smoke workspace\n");

const resultsFile = join(dirname(fileURLToPath(import.meta.url)), "..", "spikes", "results", "s5-08-smoke.json");
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

/**
 * Sends `text` (unless null: the turn was started with the session) and waits for a new reply with the session
 * settled. Approves at most `approve` approval cards on the way and reports what they said.
 */
async function turn(host, id, text, { approve = 0, timeoutMs = 300_000 } = {}) {
  const before = agents(await items(host, id)).length;
  if (text !== null) await api(host, "POST", `/api/sessions/${id}/messages`, { text });
  const start = Date.now();
  const approvals = [];
  while (Date.now() - start < timeoutMs) {
    const list = await items(host, id);
    const pending = list.find((i) => i.type === "approval" && i.state === "pending");
    if (pending) {
      approvals.push(pending.summary);
      if (approvals.length > approve) throw new Error(`unexpected approval: ${pending.summary}`);
      await api(host, "POST", `/api/approvals/${encodeURIComponent(pending.approvalId)}`, { sessionId: id, decision: "accept" });
    } else {
      const s = await session(host, id);
      if (s.status === "error" || ((s.status === "idle" || s.status === "completed") && agents(list).length > before)) {
        return { status: s.status, reply: agents(list).at(-1)?.markdown?.slice(0, 300) ?? null, approvals, tools: list.filter((i) => i.type === "tool").slice(-3).map((i) => `${i.name}:${i.status}`), errors: list.filter((i) => i.type === "error").map((i) => i.message) };
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`session ${id} did not settle`);
}

let host;
const created = [];
try {
  host = await startHost({ dataDir, port: 47961, codexEnv: { CODEX_HOME: codexHome }, launcher: new RecordingTerminalLauncher() });
  const ws = await api(host, "POST", "/api/workspaces", { path: workspaceDir, name: "smoke" });
  const scope = { kind: "workspace", workspaceId: ws.id };

  // ---- GLM (Claude)
  count("glm", "S5-08 GLM note");
  const g = await api(host, "POST", "/api/tasks", {
    title: "GLM 协作冒烟",
    scope,
    firstSession: { profileId: "claude-glm", text: "Use the amo MCP tool task_note_add to record exactly this progress note: GLM smoke started. Then reply with the single word DONE." },
  });
  created.push(g.session.id);
  const note = await turn(host, g.session.id, null);
  step("glm-note", { ...note, notes: (await api(host, "GET", `/api/tasks/${g.task.id}/notes`)).map((n) => [n.kind, n.sessionId === g.session.id, n.text]) });

  count("glm", "S5-08 GLM decision");
  const asked = await turn(host, g.session.id, 'Use the amo MCP tool decision_request to ask me "Retry limit: 3 or 5?" with the options "3" and "5". Then reply with the single word ASKED.');
  const open = await api(host, "GET", "/api/decisions?state=open");
  step("glm-decision", { ...asked, open: open.map((d) => [d.question, d.options, d.sessionId === g.session.id]) });
  if (open[0]) await api(host, "POST", `/api/decisions/${open[0].id}/answer`, { answer: "3" });

  count("glm", "S5-08 GLM mailbox_read");
  step("glm-read-answer", await turn(host, g.session.id, "Use the amo MCP tool mailbox_read and tell me in one short sentence what I decided."));

  count("glm", "S5-08 GLM canvas (approval)");
  const gc = await turn(host, g.session.id, 'Use the amo MCP tool canvas_group_create to create a canvas group titled "GLM 组". Then reply DONE.', { approve: 1 });
  step("glm-canvas", { ...gc, groups: (await api(host, "GET", "/api/canvas")).groups.map((x) => x.title) });

  // ---- DeepSeek (Codex)
  count("deepseek", "S5-08 DeepSeek mail");
  const d = await api(host, "POST", "/api/tasks", {
    title: "DeepSeek 协作冒烟",
    scope,
    firstSession: { profileId: "codex-deepseek-flash", text: `Use the amo MCP tool mailbox_send to leave the message "hello from deepseek" for the session with id ${g.session.id}. Then reply with the single word SENT.` },
  });
  created.push(d.session.id);
  const mail = await turn(host, d.session.id, null, { approve: 1 });
  step("deepseek-mail", { ...mail, mail: (await api(host, "GET", `/api/mail?sessionId=${g.session.id}`)).map((m) => [m.fromSessionId === d.session.id, m.text, m.state]) });

  count("deepseek", "S5-08 DeepSeek handoff");
  const ho = await turn(host, d.session.id, "Use the amo MCP tool handoff_submit with the summary: DeepSeek smoke handoff, nothing left to do. Then reply DONE.", { approve: 1 });
  step("deepseek-handoff", { ...ho, notes: (await api(host, "GET", `/api/tasks/${d.task.id}/notes`)).map((n) => [n.kind, n.sessionId === d.session.id, n.text]) });

  count("deepseek", "S5-08 DeepSeek canvas (elicitation)");
  const dc = await turn(host, d.session.id, 'Use the amo MCP tool canvas_group_create to create a canvas group titled "DeepSeek 组". Then reply DONE.', { approve: 2 });
  step("deepseek-canvas", { ...dc, groups: (await api(host, "GET", "/api/canvas")).groups.map((x) => x.title) });
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
