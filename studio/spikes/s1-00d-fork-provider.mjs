// S1-00d follow-up: which provider does a fork get? Parent uses amo-ds-p; server default is amo-ds-x (both DeepSeek,
// distinguishable by id). Compare an implicit fork (no modelProvider) with an explicit one.
import fs from "node:fs";
import { RpcClient, agentText, countTurn, deepseekProviderArgs, isTurnDone, readAmoCredential, sandboxWorkspace, startAppServer } from "./lib.mjs";

const cwd = sandboxWorkspace("s1-00d");
const codexHome = sandboxWorkspace("codex-home-s1-00d");
const out = { scenario: "S1-00d fork provider inheritance", steps: [] };
const log = (s, data) => { out.steps.push({ s, ...data }); console.log(s, data ? JSON.stringify(data).slice(0, 600) : ""); };

const server = await startAppServer({ port: 47913, cwd,
  configArgs: [...deepseekProviderArgs("amo-ds-x"), ...deepseekProviderArgs("amo-ds-p").slice(0, -2),
    "-c", 'model_provider="amo-ds-x"', "-c", 'model="deepseek-flash"'],
  env: { CODEX_HOME: codexHome, DEEPSEEK_API_KEY: readAmoCredential("deepseek-v4") } });
const a = new RpcClient("A", server.url, server.token);
const threads = [];
const runTurn = async (threadId, note, text) => {
  countTurn(note);
  const t = await a.request("turn/start", { threadId, effort: "low", input: [{ type: "text", text }] });
  const done = await a.waitFor(isTurnDone(t.turn.id));
  return { status: done.params.turn.status, error: done.params.turn.error?.message?.slice(0, 160) ?? null, reply: agentText(a.events, t.turn.id) };
};
try {
  await a.connect();
  const st = await a.request("thread/start", { cwd, approvalPolicy: "never", sandbox: "read-only", model: "deepseek-flash", modelProvider: "amo-ds-p", config: { model_reasoning_effort: "low" } });
  const parentId = st.thread.id; threads.push(parentId);
  log("parent", { modelProvider: st.modelProvider, seed: await runTurn(parentId, "S1-00d-2 seed", "Remember the codeword PLUM-3. Reply with exactly: OK") });

  const implicit = await a.request("thread/fork", { threadId: parentId });
  threads.push(implicit.thread.id);
  log("implicit fork", { modelProvider: implicit.modelProvider, threadProvider: implicit.thread.modelProvider, model: implicit.model,
    turn: await runTurn(implicit.thread.id, "S1-00d-2 implicit fork turn", "What codeword did I ask you to remember? Reply with it only.") });

  const explicit = await a.request("thread/fork", { threadId: parentId, modelProvider: "amo-ds-p", model: "deepseek-flash" });
  threads.push(explicit.thread.id);
  log("explicit fork", { modelProvider: explicit.modelProvider, threadProvider: explicit.thread.modelProvider, forkedFromId: explicit.thread.forkedFromId,
    turn: await runTurn(explicit.thread.id, "S1-00d-2 explicit fork turn", "What codeword did I ask you to remember? Reply with it only.") });
} catch (e) {
  log("FATAL", { error: e.message, stderr: server.state.stderr.slice(-1200) });
} finally {
  for (const threadId of threads) await a.request("thread/archive", { threadId }).catch(() => {});
  a.close();
  await server.stop();
  fs.writeFileSync(new URL("./results/s1-00d-provider.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
}
