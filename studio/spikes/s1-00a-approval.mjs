// S1-00a: who receives approval requests when two clients follow one thread, and what happens to the late answer.
import fs from "node:fs";
import path from "node:path";
import { RpcClient, agentText, countTurn, deepseekConfigArgs, isTurnDone, readAmoCredential, sandboxWorkspace, sleep, startAppServer } from "./lib.mjs";

// Variant 1: B accepts first, A declines late; the command writes a file (blocked by the read-only sandbox).
// Variant 2: A declines first, B accepts late; the command only prints, so its output shows whether it ran.
const variant = process.argv[2] === "2" ? 2 : 1;
const cwd = sandboxWorkspace("s1-00a");
fs.rmSync(path.join(cwd, "probe.txt"), { force: true });
const server = await startAppServer({ port: 47910, cwd, configArgs: deepseekConfigArgs(), env: { DEEPSEEK_API_KEY: readAmoCredential("deepseek-v4") } });
const out = { scenario: `S1-00a approval routing, variant ${variant}`, steps: [] };
const log = (s, data) => { out.steps.push({ s, ...data }); console.log(s, data ? JSON.stringify(data).slice(0, 400) : ""); };

const a = new RpcClient("A", server.url, server.token);
const b = new RpcClient("B", server.url, server.token);
let threadId;
try {
  await a.connect(); await b.connect();
  const st = await a.request("thread/start", { cwd, approvalPolicy: "untrusted", sandbox: "read-only" });
  threadId = st.thread.id;
  countTurn(`S1-00a approval turn, variant ${variant}`);
  const t = await a.request("turn/start", { threadId, effort: "low", input: [{ type: "text", text:
    `Use your shell tool to run exactly this command once: ${variant === 1 ? '`cmd /c "echo approval-probe> probe.txt"`' : "`cmd /c echo approval-probe-2`"}. Do not try alternatives. Afterwards reply with exactly APPROVED-RAN if it ran, or DENIED if it was declined.` }] });
  const turnId = t.turn.id;
  // A fresh thread has no rollout until its first turn, so B can only subscribe once the turn has started.
  let resumeTries = 0;
  for (;;) {
    try { await b.request("thread/resume", { threadId }); break; }
    catch (e) { if (++resumeTries > 50) throw e; await sleep(200); }
  }
  log("thread started by A; B subscribed after turn/start", { threadId, resumeTries, approvalAlreadyAtA: a.events.some((e) => e.kind === "request") });

  const isApproval = (e) => e.kind === "request" && /requestApproval|Approval$/.test(e.method);
  const first = await Promise.race([a.waitFor(isApproval, 150000).then((e) => ["A", e]), b.waitFor(isApproval, 150000).then((e) => ["B", e])]);
  await sleep(1500);
  const reqA = a.events.find(isApproval), reqB = b.events.find(isApproval);
  log("approval request delivery", {
    firstTo: first[0], method: first[1].method,
    toA: !!reqA, toB: !!reqB, sameRpcId: reqA && reqB ? reqA.id === reqB.id : null,
    sameItem: reqA && reqB ? reqA.params.itemId === reqB.params.itemId : null,
    command: first[1].params.command,
  });

  const [early, earlyReq, earlyDecision, late, lateReq, lateDecision] =
    variant === 1 ? [b, reqB, "accept", a, reqA, "decline"] : [a, reqA, "decline", b, reqB, "accept"];
  if (earlyReq) early.respond(earlyReq.id, { decision: earlyDecision });
  await sleep(1500);
  const resolvedA = a.events.filter((e) => e.method === "serverRequest/resolved");
  const resolvedB = b.events.filter((e) => e.method === "serverRequest/resolved");
  log(`after ${early.name} answered ${earlyDecision}`, { resolvedSeenByA: resolvedA.map((e) => e.params), resolvedSeenByB: resolvedB.map((e) => e.params) });
  if (lateReq) late.respond(lateReq.id, { decision: lateDecision });

  await a.waitFor(isTurnDone(turnId), 180000);
  await sleep(500);
  const secondApprovals = a.events.filter(isApproval).length + b.events.filter(isApproval).length;
  log("turn completed", {
    reply: agentText(a.events, turnId),
    probeFileExists: fs.existsSync(path.join(cwd, "probe.txt")),
    approvalRequestsTotal: { A: a.events.filter(isApproval).length, B: b.events.filter(isApproval).length, sum: secondApprovals },
    errorsOrWarnings: [...a.events, ...b.events].filter((e) => e.method === "error" || e.method === "warning").map((e) => e.params).slice(0, 4),
    commandItems: a.events.filter((e) => e.method === "item/completed" && e.params.item?.type === "commandExecution").map((e) => ({ status: e.params.item.status, exit: e.params.item.exitCode, output: String(e.params.item.aggregatedOutput ?? "").slice(0, 200) })),
  });
} catch (e) {
  log("FATAL", { error: e.message, stderr: server.state.stderr.slice(-800) });
} finally {
  if (threadId) await a.request("thread/archive", { threadId }).catch(() => {});
  a.close(); b.close();
  await server.stop();
  fs.writeFileSync(new URL(`./results/s1-00a-v${variant}.json`, import.meta.url), JSON.stringify(out, null, 2) + "\n");
}
