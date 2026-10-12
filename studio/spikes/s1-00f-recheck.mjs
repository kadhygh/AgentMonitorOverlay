// S1-00f: re-run the S1-00 a–d checks on the npm Codex CLI (0.161) with the local mock model instead of DeepSeek.
// The checks are protocol behaviour (routing, persistence, fork provenance), so the model does not matter. No budget.
//   npx tsc -b && node studio/spikes/s1-00f-recheck.mjs
import fs from "node:fs";
import { MOCK_MODEL_CATALOG, startMockModel } from "../packages/testkit/dist/index.js";
import { codexVersion } from "../packages/host/dist/runtime/codex/command.js";
import { RpcClient, agentText, isTurnDone, sandboxWorkspace, sleep, startAppServer } from "./lib.mjs";

const mock = await startMockModel({ port: 47951 });
const version = codexVersion();
const out = { scenario: "S1-00f recheck on npm Codex with mock model", codexVersion: version, checks: {} };
const record = (key, data) => { out.checks[key] = data; console.log(key, JSON.stringify(data)); };

const providerDef = (id) => ({ [id]: { name: `Mock ${id}`, base_url: mock.baseUrl, wire_api: "responses", env_key: "AMO_MOCK_API_KEY" } });
const providerArgs = (id) => Object.entries(providerDef(id)[id]).flatMap(([k, v]) => ["-c", `model_providers.${id}.${k}=${JSON.stringify(v)}`]);
const catalogArgs = ["-c", `model_catalog_json=${JSON.stringify(MOCK_MODEL_CATALOG)}`];
const text = (t) => [{ type: "text", text: t }];
const isApproval = (e) => e.kind === "request" && /requestApproval$/.test(e.method);

let port = 47920;
async function withServer(name, configArgs, fn, { token } = {}) {
  const cwd = sandboxWorkspace(`s1-00f-${name}`);
  const codexHome = sandboxWorkspace(`codex-home-s1-00f-${name}`);
  const env = { CODEX_HOME: codexHome, AMO_MOCK_API_KEY: "mock" };
  const p = port++;
  let server = await startAppServer({ port: p, cwd, configArgs, env, token });
  const ctx = {
    cwd,
    get server() { return server; },
    async client(label) { const c = new RpcClient(label, server.url, server.token); await c.connect(); return c; },
    async restart() { const t = server.token; await server.stop(); server = await startAppServer({ port: p, cwd, configArgs, env, token: t }); },
    async turn(c, threadId, t) {
      const r = await c.request("turn/start", { threadId, input: text(t) });
      const done = await c.waitFor(isTurnDone(r.turn.id), 60000);
      return { status: done.params.turn.status, reply: agentText(c.events, r.turn.id), error: done.params.turn.error?.message?.slice(0, 160) ?? null };
    },
  };
  try {
    return await fn(ctx);
  } catch (e) {
    record(`${name}:FATAL`, { error: e.message, stderr: server.state.stderr.slice(-600) });
  } finally {
    await server.stop();
    fs.rmSync(codexHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

// a. approval routing
await withServer("a", [...providerArgs("amo-mock"), ...catalogArgs, "-c", 'model_provider="amo-mock"', "-c", 'model="mock-model"'], async (s) => {
  const a = await s.client("A"); const b = await s.client("B");
  const { thread } = await a.request("thread/start", { cwd: s.cwd, approvalPolicy: "untrusted", sandbox: "read-only" });
  await s.turn(a, thread.id, "seed");
  await b.request("thread/resume", { threadId: thread.id });
  const r = await a.request("turn/start", { threadId: thread.id, input: text("[[shell: cmd /c echo recheck-a]]") });
  const [ra, rb] = await Promise.all([a.waitFor(isApproval, 30000), b.waitFor(isApproval, 30000)]);
  b.respond(rb.id, { decision: "decline" });
  await sleep(500);
  a.respond(ra.id, { decision: "accept" });
  await a.waitFor(isTurnDone(r.turn.id), 60000);
  const cmd = a.events.filter((e) => e.method === "item/completed" && e.params.item?.type === "commandExecution").map((e) => e.params.item.status);
  const resolvedBoth = [a, b].every((c) => c.events.some((e) => e.method === "serverRequest/resolved"));
  // late subscriber while pending
  const r2 = await a.request("turn/start", { threadId: thread.id, input: text("[[shell: cmd /c echo recheck-late]]") });
  const pending = await a.waitFor((e) => isApproval(e) && e.id !== ra.id, 30000);
  const late = await s.client("late");
  await late.request("thread/resume", { threadId: thread.id });
  const replay = await late.waitFor((e) => isApproval(e) && e.id === pending.id, 5000).then(() => true, () => false);
  a.respond(pending.id, { decision: "accept" });
  await a.waitFor(isTurnDone(r2.turn.id), 60000);
  record("a.approval", { bothReceived: ra.id === rb.id, firstAnswerWins: cmd[0] === "declined", resolvedBroadcast: resolvedBoth, lateSubscriberGetsPending: replay });
  await a.request("thread/archive", { threadId: thread.id }).catch(() => {});
  [a, b, late].forEach((c) => c.close());
});

// b + c(thread mode). provider defined per thread; two providers on one server; restart; resume without config.
await withServer("bc", [...catalogArgs], async (s) => {
  const a = await s.client("A");
  const ids = {};
  for (const id of ["amo-mock-a", "amo-mock-b"]) {
    const st = await a.request("thread/start", { cwd: s.cwd, approvalPolicy: "never", sandbox: "read-only", model: "mock-model", modelProvider: id, config: { model_providers: providerDef(id) } });
    ids[id] = st.thread.id;
    const t = await s.turn(a, st.thread.id, `hello ${id}`);
    record(`b.perThread.${id}`, { provider: st.modelProvider, turn: t.status, reply: t.reply });
  }
  const listed = await a.request("thread/list", { modelProviders: Object.keys(ids) });
  const unfiltered = await a.request("thread/list", {});
  record("b.list", { withFilter: listed.data.length, withoutFilter: unfiltered.data.length });
  a.close();
  await s.restart();
  const a2 = await s.client("A2");
  const noConfig = await a2.request("thread/resume", { threadId: ids["amo-mock-a"] }).then((r) => ({ ok: true, provider: r.modelProvider }), (e) => ({ ok: false, error: e.message.slice(0, 160) }));
  record("c.threadMode.resumeWithoutConfig", noConfig);
  a2.close();
});

// c(server mode) + d. providers defined at launch; default amo-mock-x; parent on amo-mock-p.
await withServer("cd", [...providerArgs("amo-mock-x"), ...providerArgs("amo-mock-p"), ...catalogArgs, "-c", 'model_provider="amo-mock-x"', "-c", 'model="mock-model"'], async (s) => {
  const a = await s.client("A"); const b = await s.client("B");
  const st = await a.request("thread/start", { cwd: s.cwd, approvalPolicy: "never", sandbox: "read-only", model: "mock-model", modelProvider: "amo-mock-p" });
  const parentId = st.thread.id;
  await s.turn(a, parentId, "parent seed");
  await b.request("thread/resume", { threadId: parentId });
  const implicit = await a.request("thread/fork", { threadId: parentId });
  const explicit = await a.request("thread/fork", { threadId: parentId, modelProvider: "amo-mock-p", model: "mock-model" });
  await sleep(500);
  const startedAtB = b.events.filter((e) => e.method === "thread/started").map((e) => ({ id: e.params.thread.id, forkedFromId: e.params.thread.forkedFromId }));
  const implicitTurn = await s.turn(a, implicit.thread.id, "implicit fork turn");
  const list = await a.request("thread/list", { modelProviders: ["amo-mock-x", "amo-mock-p"] });
  record("d.fork", {
    implicitProvider: implicit.modelProvider, explicitProvider: explicit.modelProvider, forkedFromId: implicit.thread.forkedFromId === parentId,
    parentSubscriberSawThreadStarted: startedAtB.some((t) => t.id === implicit.thread.id && t.forkedFromId === parentId),
    implicitTurn: implicitTurn.status, listIncludesFork: list.data.some((t) => t.id === implicit.thread.id),
  });
  a.close(); b.close();
  await s.restart();
  const a2 = await s.client("A2");
  const rs = await a2.request("thread/resume", { threadId: parentId }).then((r) => ({ ok: true, provider: r.modelProvider }), (e) => ({ ok: false, error: e.message.slice(0, 160) }));
  const t = rs.ok ? await s.turn(a2, parentId, "after restart") : null;
  record("c.serverMode.resumeWithoutConfig", { ...rs, turn: t?.status ?? null });
  a2.close();
});

await mock.close();
fs.writeFileSync(new URL("./results/s1-00f.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log("codex", version, "mock requests", mock.requests.length);
