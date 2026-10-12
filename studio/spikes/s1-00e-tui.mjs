// S1-00e (needs the user): what does a Studio-side client see when the real Codex TUI, attached with --remote,
// runs /fork or opens a side chat, and does the TUI get back to the same thread after the server restarts?
//
//   node studio/spikes/s1-00e-tui.mjs          # interactive, follow the printed steps
//   node studio/spikes/s1-00e-tui.mjs --dry    # start and stop the server only, no model calls
//
// The server uses the DeepSeek profile as its default provider and a sandbox CODEX_HOME, so anything the TUI does
// stays on DeepSeek. Every turn the observer sees is counted against studio/budget.json.
import fs from "node:fs";
import path from "node:path";
import { RpcClient, agentText, countTurn, deepseekProviderArgs, isTurnDone, readAmoCredential, sandboxWorkspace, sleep, startAppServer } from "./lib.mjs";

const dry = process.argv.includes("--dry");
const cwd = sandboxWorkspace("s1-00e");
const codexHome = sandboxWorkspace("codex-home-s1-00e");
const resultFile = new URL("./results/s1-00e.log", import.meta.url);
const say = (s) => { const line = `${new Date().toISOString().slice(11, 19)} ${s}`; console.log(line); if (!dry) fs.appendFileSync(resultFile, line + "\n"); };

const serverArgs = [...deepseekProviderArgs("amo-deepseek"), "-c", 'model_provider="amo-deepseek"', "-c", 'model="deepseek-flash"', "-c", 'model_reasoning_effort="low"'];
const env = { CODEX_HOME: codexHome, DEEPSEEK_API_KEY: readAmoCredential("deepseek-v4") };
let server = await startAppServer({ port: 47920, cwd, env, configArgs: serverArgs });
const token = server.token;
if (dry) { say(`dry run: server started at ${server.url}`); await server.stop(); say("dry run: server stopped"); process.exit(0); }

const counted = new Set();
const seen = new Map(); // threadId -> { forkedFromId, provider }
let amo;
async function attach() {
  amo = new RpcClient("studio", server.url, token);
  await amo.connect();
}
function watch(client) {
  let cursor = 0;
  const timer = setInterval(() => {
    for (const e of client.events.slice(cursor)) {
      if (e.method === "thread/started") {
        const t = e.params.thread;
        seen.set(t.id, { forkedFromId: t.forkedFromId, provider: t.modelProvider });
        say(`thread/started id=${t.id} forkedFromId=${t.forkedFromId ?? "-"} parentThreadId=${t.parentThreadId ?? "-"} provider=${t.modelProvider} source=${JSON.stringify(t.source)} ephemeral=${t.ephemeral}`);
        client.request("thread/resume", { threadId: t.id }).catch((err) => say(`resume ${t.id} failed: ${err.message}`));
      } else if (e.method === "turn/started" && !counted.has(e.params.turn.id)) {
        counted.add(e.params.turn.id);
        countTurn(`S1-00e TUI turn on ${e.params.threadId}`);
        say(`turn/started thread=${e.params.threadId}`);
      } else if (e.method === "item/completed" && ["userMessage", "agentMessage"].includes(e.params.item?.type)) {
        const text = e.params.item.type === "userMessage" ? JSON.stringify(e.params.item.content).slice(0, 120) : e.params.item.text.slice(0, 120);
        say(`${e.params.item.type} thread=${e.params.threadId}: ${text}`);
        if (e.params.item.type === "userMessage" && text.includes("AMO-RESTART")) restartSoon = true;
      } else if (e.kind === "request") {
        say(`server request ${e.method} thread=${e.params?.threadId} (left for the TUI to answer)`);
      } else if (e.kind === "closed") {
        say("studio connection closed");
        clearInterval(timer);
      }
    }
    cursor = client.events.length;
  }, 200);
}

let restartSoon = false;
let threadId;
process.on("SIGINT", async () => {
  say("stopping");
  for (const id of [threadId, ...seen.keys()].filter(Boolean)) await amo?.request("thread/archive", { threadId: id }).catch(() => {});
  await server.stop();
  process.exit(0);
});
try {
  await attach();
  watch(amo);
  const st = await amo.request("thread/start", { cwd, approvalPolicy: "on-request", sandbox: "read-only", model: "deepseek-flash", modelProvider: "amo-deepseek" });
  threadId = st.thread.id;
  await amo.request("thread/name/set", { threadId, name: "AMO Studio S1-00e" });
  const t = await amo.request("turn/start", { threadId, input: [{ type: "text", text: "Remember the codeword FIG-9. Reply with exactly: OK, ready." }] });
  await amo.waitFor(isTurnDone(t.turn.id));
  say(`seeded thread ${threadId}`);

  const cmdFile = path.join(cwd, "attach-command.txt");
  fs.writeFileSync(cmdFile, `cd '${cwd}'; $env:AMO_STUDIO_TOKEN='${token}'; codex --remote ${server.url} --remote-auth-token-env AMO_STUDIO_TOKEN resume ${threadId}\n`);
  console.log(`\n在另一个 PowerShell 窗口里粘贴执行 ${cmdFile} 里的命令，然后按顺序：
  1. 在 TUI 里随便说一句话，确认能对话；
  2. 执行 /fork（如果有 side chat，也打开一次并说一句话）；
  3. 回到原会话，发送一句包含 AMO-RESTART 的话。这一轮结束后脚本会重启 server（同端口同 token）；
  4. 等 TUI 显示重连成功后，再说一句话；
  5. 退出 TUI，在这个窗口按 Ctrl+C。结果写在 studio/spikes/results/s1-00e.log。\n`);

  for (;;) {
    await sleep(500);
    if (!restartSoon) continue;
    restartSoon = false;
    await sleep(15000); // let the AMO-RESTART turn finish
    say("restarting server on the same port and token");
    await server.stop();
    server = await startAppServer({ port: 47920, cwd, env, token, configArgs: serverArgs });
    await attach();
    watch(amo);
    for (const id of [threadId, ...seen.keys()]) await amo.request("thread/resume", { threadId: id }).catch((err) => say(`re-resume ${id} failed: ${err.message}`));
    say("server restarted; studio re-subscribed. Waiting for the TUI to reconnect and send a message");
  }
} catch (e) {
  say(`FATAL ${e.message} ${server.state.stderr.slice(-600)}`);
} finally {
  await server.stop();
}

