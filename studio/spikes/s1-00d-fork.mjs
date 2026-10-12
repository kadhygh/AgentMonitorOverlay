// S1-00d: when client A forks a thread, what does client B (subscribed to the parent) see?
import fs from "node:fs";
import { RpcClient, agentText, countTurn, deepseekProviderArgs, isTurnDone, readAmoCredential, sandboxWorkspace, sleep, startAppServer } from "./lib.mjs";

const cwd = sandboxWorkspace("s1-00d");
const codexHome = sandboxWorkspace("codex-home-s1-00d");
const out = { scenario: "S1-00d fork from another client", steps: [] };
const log = (s, data) => { out.steps.push({ s, ...data }); console.log(s, data ? JSON.stringify(data).slice(0, 700) : ""); };
const summarize = (events) => events.map((e) => [e.kind === "request" ? `REQ ${e.method}` : e.method, e.params?.threadId ?? e.params?.thread?.id ?? null]);

const server = await startAppServer({ port: 47913, cwd, configArgs: deepseekProviderArgs("amo-deepseek"),
  env: { CODEX_HOME: codexHome, DEEPSEEK_API_KEY: readAmoCredential("deepseek-v4") } });
const a = new RpcClient("A", server.url, server.token);
const b = new RpcClient("B", server.url, server.token);
const threads = [];
try {
  await a.connect(); await b.connect();
  const st = await a.request("thread/start", { cwd, approvalPolicy: "never", sandbox: "read-only", model: "deepseek-flash", modelProvider: "amo-deepseek", config: { model_reasoning_effort: "low" } });
  const parentId = st.thread.id; threads.push(parentId);
  countTurn("S1-00d seed turn");
  const t1 = await a.request("turn/start", { threadId: parentId, effort: "low", input: [{ type: "text", text: "Remember the codeword PLUM-3. Reply with exactly: OK" }] });
  await a.waitFor(isTurnDone(t1.turn.id));
  await b.request("thread/resume", { threadId: parentId });
  await sleep(300);

  const bMark = b.events.length;
  const fk = await a.request("thread/fork", { threadId: parentId });
  const forkId = fk.thread.id; threads.push(forkId);
  await sleep(1500);
  log("A forked", { parentId, forkId, forkedFromIdInResponse: fk.thread.forkedFromId ?? null, forkTurns: fk.thread.turns?.length });
  log("B events during fork", { events: summarize(b.events.slice(bMark)),
    threadStartedParams: b.events.slice(bMark).filter((e) => e.method === "thread/started").map((e) => ({ id: e.params.thread?.id, forkedFromId: e.params.thread?.forkedFromId ?? null, keys: Object.keys(e.params.thread ?? {}) })) });

  const loaded = await b.request("thread/loaded/list", {});
  const read = await b.request("thread/read", { threadId: forkId });
  const list = await b.request("thread/list", { modelProviders: ["amo-deepseek"] });
  out.listRaw = (list.data ?? []).map((t) => ({ id: t.id, forkedFromId: t.forkedFromId }));
  log("B queries", {
    loadedHasFork: (loaded.data ?? []).includes(forkId), loaded: loaded.data,
    readForkedFromId: read.thread?.forkedFromId ?? null,
    listHasFork: (list.data ?? []).some((t) => t.id === forkId),
    listForkedFromId: (list.data ?? []).find((t) => t.id === forkId)?.forkedFromId ?? "absent",
  });

  // A turn on the fork: does B see it without subscribing to the fork?
  const bMark2 = b.events.length;
  countTurn("S1-00d fork turn");
  const t2 = await a.request("turn/start", { threadId: forkId, effort: "low", input: [{ type: "text", text: "What codeword did I ask you to remember? Reply with it only." }] });
  const done2 = await a.waitFor(isTurnDone(t2.turn.id));
  await sleep(500);
  const bForkEvents = b.events.slice(bMark2).filter((e) => e.params?.threadId === forkId);
  const list2 = await b.request("thread/list", { modelProviders: ["amo-deepseek"] });
  log("thread/list after fork turn", { listHasFork: (list2.data ?? []).some((t) => t.id === forkId) });
  log("turn on fork", { status: done2.params.turn.status, error: done2.params.turn.error ?? null, reply: agentText(a.events, t2.turn.id),
    aItemTypes: a.events.filter((e) => e.method === "item/completed" && e.params.threadId === forkId).map((e) => e.params.item?.type),
    aErrors: a.events.filter((e) => e.method === "error").map((e) => e.params).slice(0, 2),
    bForkEventKinds: [...new Set(bForkEvents.map((e) => e.method))], bSawForkEventsWithoutSubscribing: bForkEvents.length, bEventKinds: [...new Set(summarize(b.events.slice(bMark2)).map((x) => x[0]))] });
} catch (e) {
  log("FATAL", { error: e.message, stderr: server.state.stderr.slice(-1200) });
} finally {
  for (const threadId of threads) await a.request("thread/archive", { threadId }).catch(() => {});
  a.close(); b.close();
  await server.stop();
  fs.writeFileSync(new URL("./results/s1-00d.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
}
