// S1-00b: can one app-server started without provider flags run threads whose provider is chosen in thread/start?
// CODEX_HOME points at an empty sandbox dir (no ChatGPT login), so a misrouted turn fails instead of spending GPT quota.
import fs from "node:fs";
import path from "node:path";
import { RpcClient, agentText, countTurn, isTurnDone, readAmoCredential, sandboxWorkspace, startAppServer } from "./lib.mjs";

const cwd = sandboxWorkspace("s1-00b");
const codexHome = sandboxWorkspace("codex-home-s1-00b");
const catalog = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "assets", "deepseek-profile-v41-flash-flash-all.models.json").replaceAll("\\", "/");
const out = { scenario: "S1-00b one server, provider per thread", steps: [] };
const log = (s, data) => { out.steps.push({ s, ...data }); console.log(s, data ? JSON.stringify(data).slice(0, 500) : ""); };

const provider = (id, label) => ({
  [id]: { name: label, base_url: "https://api.deepseek.com/", wire_api: "responses", env_key: "DEEPSEEK_API_KEY" },
});

const server = await startAppServer({ port: 47911, cwd, env: { CODEX_HOME: codexHome, DEEPSEEK_API_KEY: readAmoCredential("deepseek-v4") } });
const c = new RpcClient("A", server.url, server.token);
const threads = [];
try {
  await c.connect();
  const specs = [
    { id: "amo-ds-a", label: "DeepSeek A", word: "ALPHA" },
    { id: "amo-ds-b", label: "DeepSeek B", word: "BRAVO" },
  ];
  for (const spec of specs) {
    const st = await c.request("thread/start", {
      cwd, approvalPolicy: "never", sandbox: "read-only",
      model: "deepseek-flash", modelProvider: spec.id,
      config: { model_providers: provider(spec.id, spec.label), model_catalog_json: catalog, model_reasoning_effort: "low" },
    });
    threads.push(st.thread.id);
    log(`thread/start with provider ${spec.id}`, { threadId: st.thread.id, model: st.model, modelProvider: st.modelProvider, threadProvider: st.thread.modelProvider });
    spec.threadId = st.thread.id;
  }
  // Run both turns concurrently on the same server.
  const turns = await Promise.all(specs.map(async (spec) => {
    countTurn(`S1-00b turn on ${spec.id}`);
    const t = await c.request("turn/start", { threadId: spec.threadId, effort: "low", input: [{ type: "text", text: `Reply with exactly: ${spec.word}-OK` }] });
    const done = await c.waitFor(isTurnDone(t.turn.id), 180000);
    return { provider: spec.id, status: done.params.turn.status, error: done.params.turn.error ?? null, reply: agentText(c.events, t.turn.id) };
  }));
  log("concurrent turns", { turns });
  const errs = c.events.filter((e) => e.method === "error").map((e) => e.params);
  if (errs.length) log("error notifications", { errs: errs.slice(0, 3) });

  const listAll = await c.request("thread/list", { modelProviders: specs.map((s) => s.id) });
  const listDefault = await c.request("thread/list", {});
  log("thread/list", {
    withProviders: (listAll.data ?? []).map((t) => [t.id, t.modelProvider]),
    withoutFilter: (listDefault.data ?? []).map((t) => [t.id, t.modelProvider]),
  });
  const read = await c.request("thread/read", { threadId: specs[1].threadId });
  log("thread/read B", { modelProvider: read.thread?.modelProvider });
} catch (e) {
  log("FATAL", { error: e.message, stderr: server.state.stderr.slice(-1200) });
} finally {
  for (const threadId of threads) await c.request("thread/archive", { threadId }).catch(() => {});
  c.close();
  await server.stop();
  fs.writeFileSync(new URL("./results/s1-00b.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
}
