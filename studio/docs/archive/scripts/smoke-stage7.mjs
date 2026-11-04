// S7-07 real smoke: one scheduler round with GLM, then the person approves one proposal.
//   npm run build && node scripts/smoke-stage7.mjs
// Two sandbox workspaces and three todos. GLM runs the round (it may only propose); the proposals are checked and one is
// approved with the model forced to GLM and a smoke note added to the prompt (the proposal may name any profile; real
// calls in the loop only go to GLM/DeepSeek). Every approval card (e.g. a shell command) is declined. Sandbox data dir,
// CODEX_HOME and workspaces under %TEMP%\amo-studio-sandbox; Host on 47963; every real turn is counted in budget.json;
// sessions are archived at the end.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RecordingTerminalLauncher, startHost } from "../packages/host/dist/index.js";
import { removeTempDir, reserveModelTurn } from "../packages/testkit/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = join(tmpdir(), "amo-studio-sandbox");
mkdirSync(sandbox, { recursive: true });
const root = mkdtempSync(join(sandbox, "smoke-stage7-"));
const dataDir = join(root, "data");
const codexHome = join(root, "codex-home");
for (const d of [dataDir, codexHome, join(root, "alpha"), join(root, "beta")]) mkdirSync(d, { recursive: true });
writeFileSync(join(root, "alpha", "README.md"), "# alpha：小游戏玩法\n");
writeFileSync(join(root, "beta", "README.md"), "# beta：导表工具\n");

const resultsFile = join(here, "..", "spikes", "results", "s7-07-smoke.json");
const results = { startedAt: new Date().toISOString(), steps: [] };
const step = (name, data) => {
  results.steps.push({ name, ...data });
  console.log(`${name}: ${JSON.stringify(data).slice(0, 700)}`);
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

/** Waits for the session's first settled reply, declining every approval card on the way. */
async function settle(host, id, { timeoutMs = 300_000 } = {}) {
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
      if (s.status === "error" || ((s.status === "idle" || s.status === "completed") && agents(list).length > 0)) {
        return { status: s.status, reply: agents(list).at(-1)?.markdown?.slice(0, 400) ?? null, declined, tools: list.filter((i) => i.type === "tool").map((i) => `${i.name}:${i.status}`), errors: list.filter((i) => i.type === "error").map((i) => i.message) };
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`session ${id} did not settle`);
}

let host;
const created = [];
try {
  host = await startHost({ dataDir, port: 47963, codexEnv: { CODEX_HOME: codexHome }, launcher: new RecordingTerminalLauncher() });
  const alpha = await api(host, "POST", "/api/workspaces", { path: join(root, "alpha"), name: "alpha" });
  const beta = await api(host, "POST", "/api/workspaces", { path: join(root, "beta"), name: "beta" });
  const todos = [
    await api(host, "POST", "/api/todos", { text: "统一 drops.json 的字段命名", workspaceId: alpha.id }),
    await api(host, "POST", "/api/todos", { text: "清理旧的导表脚本 tools/old_export", workspaceId: beta.id }),
    await api(host, "POST", "/api/todos", { text: "整理一下文档目录" }),
  ];

  count("glm", "S7-07 scheduler round");
  const round = await api(host, "POST", "/api/scheduler/run", { profileId: "claude-glm" });
  created.push(round.session.id);
  const ran = await settle(host, round.session.id);
  const proposals = await api(host, "GET", "/api/proposals?state=pending");
  const todoText = (id) => todos.find((t) => t.id === id)?.text ?? id;
  step("round", { ...ran, proposals: proposals.map((p) => ({ todo: todoText(p.todoId), workspace: p.workspaceId === alpha.id ? "alpha" : p.workspaceId === beta.id ? "beta" : p.workspaceId, profile: p.profileId, prompt: p.prompt.slice(0, 160), reason: p.reason })) });

  if (proposals.length) {
    count("glm", "S7-07 approved proposal first turn");
    const p = proposals[0];
    const approved = await api(host, "POST", `/api/proposals/${p.id}/approve`, {
      profileId: "claude-glm",
      prompt: `${p.prompt}\n\n（冒烟测试：只用一两句话复述你接下来要做什么，不要修改文件、不要运行命令。）`,
    });
    created.push(approved.session.id);
    const first = await settle(host, approved.session.id);
    const todo = (await api(host, "GET", "/api/todos")).find((t) => t.id === p.todoId);
    step("approved", { task: approved.task.title, todoDone: todo?.done, todoTask: todo?.taskId === approved.task.id, ...first });
  }
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
