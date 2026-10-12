// S1-00c: restart app-server on the same port and token; do clients reconnect and resume, does a per-thread provider
// survive a resume without config, and does a client that subscribes while an approval is pending get that request?
import fs from "node:fs";
import path from "node:path";
import { RpcClient, agentText, countTurn, isTurnDone, readAmoCredential, sandboxWorkspace, sleep, startAppServer } from "./lib.mjs";

// mode "thread": provider defined in thread/start config (resume first without config, then with it).
// mode "server": provider defined once with -c at app-server launch; threads only pick modelProvider.
const mode = process.argv[2] === "server" ? "server" : "thread";
const cwd = sandboxWorkspace("s1-00c");
const codexHome = sandboxWorkspace("codex-home-s1-00c");
const catalog = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "assets", "deepseek-profile-v41-flash-flash-all.models.json").replaceAll("\\", "/");
const out = { scenario: `S1-00c restart, resume, late subscriber (mode ${mode})`, steps: [] };
const log = (s, data) => { out.steps.push({ s, ...data }); console.log(s, data ? JSON.stringify(data).slice(0, 600) : ""); };
const env = { CODEX_HOME: codexHome, DEEPSEEK_API_KEY: readAmoCredential("deepseek-v4") };
const profileConfig = {
  model_providers: { "amo-ds-c": { name: "DeepSeek C", base_url: "https://api.deepseek.com/", wire_api: "responses", env_key: "DEEPSEEK_API_KEY" } },
  model_catalog_json: catalog, model_reasoning_effort: "low",
};
const isApproval = (e) => e.kind === "request" && /requestApproval$/.test(e.method);

const serverArgs = mode === "server"
  ? [
      ...Object.entries(profileConfig.model_providers["amo-ds-c"]).flatMap(([k, v]) => ["-c", `model_providers.amo-ds-c.${k}=${JSON.stringify(v)}`]),
      "-c", `model_catalog_json=${JSON.stringify(catalog)}`,
    ]
  : [];
const startParams = mode === "server"
  ? { model: "deepseek-flash", modelProvider: "amo-ds-c", config: { model_reasoning_effort: "low" } }
  : { model: "deepseek-flash", modelProvider: "amo-ds-c", config: profileConfig };
let server = await startAppServer({ port: 47912, cwd, env, configArgs: serverArgs });
const token = server.token;
let threadId, a2, b;
try {
  // Phase 1: seed a thread with a per-thread provider.
  const a1 = new RpcClient("A1", server.url, token);
  await a1.connect();
  const st = await a1.request("thread/start", { cwd, approvalPolicy: "untrusted", sandbox: "read-only", ...startParams });
  threadId = st.thread.id;
  countTurn(`S1-00c seed turn (${mode})`);
  const t1 = await a1.request("turn/start", { threadId, effort: "low", input: [{ type: "text", text: "Remember the codeword KIWI-7. Reply with exactly: OK" }] });
  await a1.waitFor(isTurnDone(t1.turn.id));
  log("seeded", { threadId, reply: agentText(a1.events, t1.turn.id) });

  // Phase 2: restart on the same port and token while A1 is still connected.
  await server.stop();
  const closed = await a1.waitFor((e) => e.kind === "closed", 5000).then(() => true, () => false);
  server = await startAppServer({ port: 47912, cwd, env, token, configArgs: serverArgs });
  log("restarted server on same port/token", { a1SawClose: closed });

  // Phase 3: fresh client resumes without config.
  a2 = new RpcClient("A2", server.url, token);
  await a2.connect();
  const loadedBefore = await a2.request("thread/loaded/list", {}).catch((e) => ({ error: e.message }));
  let rs = await a2.request("thread/resume", { threadId }).catch((e) => ({ error: e.message }));
  if (rs.error) {
    log("resume without config failed", { error: rs.error });
    rs = await a2.request("thread/resume", { threadId, modelProvider: "amo-ds-c", model: "deepseek-flash", config: profileConfig });
    log("resume with config", { loadedBefore, model: rs.model, modelProvider: rs.modelProvider, threadProvider: rs.thread?.modelProvider, turns: rs.thread?.turns?.length });
  } else log("resume without config", { loadedBefore, model: rs.model, modelProvider: rs.modelProvider, threadProvider: rs.thread?.modelProvider, turns: rs.thread?.turns?.length });

  countTurn(`S1-00c post-restart turn (${mode})`);
  const t2 = await a2.request("turn/start", { threadId, effort: "low", input: [{ type: "text", text:
    "First, use your shell tool to run exactly once: `cmd /c echo late-subscriber`. Then reply with the codeword I asked you to remember, and nothing else." }] });

  // Phase 4: wait until the approval is pending at A2, then subscribe B late.
  const reqA = await a2.waitFor(isApproval, 150000);
  await sleep(1000);
  b = new RpcClient("B", server.url, token);
  await b.connect();
  await b.request("thread/resume", { threadId });
  const replayed = await b.waitFor(isApproval, 5000).then((e) => e, () => null);
  log("late subscriber while approval pending", { bGotPendingRequest: !!replayed, sameId: replayed ? replayed.id === reqA.id : null, method: replayed?.method });
  (replayed ? b : a2).respond((replayed ?? reqA).id, { decision: "accept" });

  const done = await a2.waitFor(isTurnDone(t2.turn.id), 180000);
  const cmd = a2.events.filter((e) => e.method === "item/completed" && e.params.item?.type === "commandExecution").map((e) => ({ status: e.params.item.status, output: String(e.params.item.aggregatedOutput ?? "").trim().slice(0, 80) }));
  log("post-restart turn", { status: done.params.turn.status, error: done.params.turn.error ?? null, reply: agentText(a2.events, t2.turn.id), cmd, bSawTurnDone: b.events.some(isTurnDone(t2.turn.id)) });
  a1.close();
} catch (e) {
  log("FATAL", { error: e.message, stderr: server.state.stderr.slice(-1200) });
} finally {
  if (threadId && a2) await a2.request("thread/archive", { threadId }).catch(() => {});
  a2?.close(); b?.close();
  await server.stop();
  fs.writeFileSync(new URL(`./results/s1-00c-${mode}.json`, import.meta.url), JSON.stringify(out, null, 2) + "\n");
}
