// S4-08 real smoke: Claude sessions on GLM and a Codex session on DeepSeek, through the Host, in a sandbox.
//   npm run build && node scripts/smoke-stage4.mjs
// GLM (Claude Agent SDK): approval of a command that changes files, the AMO MCP (canvas_read), a branch, a subagent.
// DeepSeek (Codex): the AMO MCP with tool_search turned off in the model catalog (spikes/RESULTS.md section i).
// Sandbox data dir, CODEX_HOME and workspace under %TEMP%\amo-studio-sandbox; Host on port 47960; every real turn is
// counted in budget.json; sessions are archived at the end.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RecordingTerminalLauncher, startHost } from "../packages/host/dist/index.js";
import { removeTempDir, reserveModelTurn } from "../packages/testkit/dist/index.js";

const sandbox = join(tmpdir(), "amo-studio-sandbox");
mkdirSync(sandbox, { recursive: true });
const root = mkdtempSync(join(sandbox, "smoke-stage4-"));
const dataDir = join(root, "data");
const codexHome = join(root, "codex-home");
const workspaceDir = join(root, "workspace");
for (const d of [dataDir, codexHome, workspaceDir]) mkdirSync(d, { recursive: true });
writeFileSync(join(workspaceDir, "README.md"), "# Studio smoke workspace\n");

const resultsFile = join(dirname(fileURLToPath(import.meta.url)), "..", "spikes", "results", "s4-08-smoke.json");
const results = { startedAt: new Date().toISOString(), steps: [] };
const step = (name, data) => {
  results.steps.push({ name, ...data });
  console.log(`${name}: ${JSON.stringify(data).slice(0, 600)}`);
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

/**
 * Waits for a new reply and for the session to settle; approves at most `approve` pending approvals on the way.
 * A Codex session only turns "running" when turn/started arrives, so "idle" alone does not mean the turn is over.
 */
async function settle(host, id, { approve = 0, timeoutMs = 240_000, before = 0 } = {}) {
  const start = Date.now();
  let approved = 0;
  while (Date.now() - start < timeoutMs) {
    const s = await session(host, id);
    const list = await items(host, id);
    const pending = list.find((i) => i.type === "approval" && i.state === "pending");
    if (pending) {
      if (approved >= approve) throw new Error(`unexpected approval: ${pending.summary}`);
      await api(host, "POST", `/api/approvals/${encodeURIComponent(pending.approvalId)}`, { sessionId: id, decision: "accept" });
      approved++;
    } else if (s.status === "error" || ((s.status === "idle" || s.status === "completed") && list.filter((i) => i.type === "agent" && !i.streaming).length > before)) {
      const agents = list.filter((i) => i.type === "agent" && !i.streaming);
      return { status: s.status, reply: agents.at(-1)?.markdown ?? null, approved, items: list };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`session ${id} did not settle`);
}

const brief = (r) => ({ status: r.status, approved: r.approved, reply: r.reply?.slice(0, 300), tools: r.items.filter((i) => i.type === "tool").map((i) => `${i.name}:${i.summary}:${i.status}`), errors: r.items.filter((i) => i.type === "error").map((i) => i.message) });

let host;
const created = [];
try {
  host = await startHost({ dataDir, port: 47960, codexEnv: { CODEX_HOME: codexHome }, launcher: new RecordingTerminalLauncher() });
  const ws = await api(host, "POST", "/api/workspaces", { path: workspaceDir, name: "smoke" });
  const canvas = await api(host, "GET", "/api/canvas");
  await api(host, "PUT", "/api/canvas", { ...canvas, groups: [{ id: "g1", title: "掉落表校验", workspaceId: ws.id, rect: { x: 0, y: 0, w: 400, h: 300 } }] });
  const scope = { kind: "workspace", workspaceId: ws.id };
  // SMOKE_ONLY=deepseek skips the GLM part (re-checks without spending GLM turns).
  const only = process.env.SMOKE_ONLY ?? "";
  let task = null;
  if (only !== "deepseek") {
  // GLM 1: a command that changes files waits for approval.
  count("glm", "S4-08 GLM approval");
  const created1 = await api(host, "POST", "/api/tasks", {
    title: "GLM 冒烟",
    scope,
    firstSession: { profileId: "claude-glm", text: "Use the Bash tool to run exactly `mkdir smoke-approved` once (do not try alternatives), then reply with the single word DONE." },
  });
  task = created1.task;
  const main = created1.session;
  created.push(main.id);
  const approval = await settle(host, main.id, { approve: 1 });
  step("glm-approval", { ...brief(approval), dirCreated: existsSync(join(workspaceDir, "smoke-approved")) });

  // GLM 2: the AMO MCP, in-process.
  count("glm", "S4-08 GLM mcp");
  await api(host, "POST", `/api/sessions/${main.id}/messages`, { text: "Call the amo MCP tool canvas_read and reply with only the title of the first canvas group." });
  step("glm-mcp", brief(await settle(host, main.id, { before: 1 })));

  // GLM 3: a branch carries the context.
  const fork = await api(host, "POST", `/api/sessions/${main.id}/fork`, {});
  created.push(fork.id);
  count("glm", "S4-08 GLM fork");
  await api(host, "POST", `/api/sessions/${fork.id}/messages`, { text: "In one short sentence: what folder did you create earlier in this conversation?" });
  step("glm-fork", brief(await settle(host, fork.id, { before: 0 })));

  // GLM 4: a subagent becomes a child session.
  count("glm", "S4-08 GLM subagent");
  await api(host, "POST", `/api/sessions/${main.id}/messages`, { text: "Use the Agent tool to start one general-purpose subagent whose only job is to reply with exactly SUB-OK. Then tell me what it returned." });
  const sub = await settle(host, main.id, { before: 2 });
  const children = (await api(host, "GET", "/api/state")).sessions.filter((s) => s.parentId === main.id && s.kind === "sub");
  step("glm-subagent", { ...brief(sub), subSessions: await Promise.all(children.map(async (c) => ({ title: c.title, status: c.status, items: (await items(host, c.id)).map((i) => i.type) }))) });
  }

  // DeepSeek: a Codex session reads the canvas through the AMO MCP over HTTP.
  count("deepseek", "S4-08 DeepSeek mcp");
  const ds = await api(host, "POST", "/api/tasks", {
    title: "DeepSeek MCP 冒烟",
    scope,
    firstSession: { profileId: "codex-deepseek-flash", text: "Call the amo MCP tool canvas_read and reply with only the title of the first canvas group." },
  });
  created.push(ds.session.id);
  const dsResult = await settle(host, ds.session.id, { approve: 2 });
  step("deepseek-mcp", { ...brief(dsResult), itemTypes: dsResult.items.map((i) => `${i.type}${i.type === "notice" || i.type === "error" ? `:${i.message}` : ""}`) });
  results.taskId = task?.id ?? ds.task.id;
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
