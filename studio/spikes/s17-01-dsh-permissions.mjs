// S17-01: when does DSH (ACP) ask for permission? DSH_PERMISSION_MODE picks the sandbox; approval is always "ask"
// except under danger-full-access. S17-00 (default workspace-write) never asked, even to delete a workspace file.
//   node spikes/s17-01-dsh-permissions.mjs [DSH clone]
// Real DeepSeek; DSH_HOME is a sandbox folder. Results in spikes/results/s17-01.json.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { countTurn, readAmoCredential, sandboxWorkspace, sleep } from "./lib.mjs";

const dshRoot = process.argv[2] ?? "G:\\PROJECT\\deepseek-harness";
const bin = path.join(dshRoot, "apps", "cli", "lib", "bin.js");
const key = readAmoCredential("deepseek-v4");
const results = [];

async function run(mode, label, text, answer, check) {
  const cwd = sandboxWorkspace(`s17-01/${label}/workspace`);
  const outside = path.join(path.dirname(cwd), "outside.txt");
  fs.rmSync(path.join(cwd, "a.txt"), { force: true });
  fs.rmSync(outside, { force: true });
  const child = spawn(process.execPath, [bin, "--profile", "acp"], {
    cwd,
    env: { ...process.env, DSH_HOME: sandboxWorkspace("s17-01/dsh-home"), DEEPSEEK_API_KEY: key, DSH_PERMISSION_MODE: mode },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stderr.pipe(fs.createWriteStream(path.join(sandboxWorkspace("s17-01"), `${label}.stderr.log`)));
  const pending = new Map();
  const permissions = [];
  const updates = [];
  let id = 1;
  let buf = "";
  const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.method === "session/update") updates.push(m.params.update);
      else if (m.method === "session/request_permission") {
        permissions.push({ title: m.params.toolCall?.title, rawInput: m.params.toolCall?.rawInput, options: m.params.options.map((o) => o.kind) });
        const opt = m.params.options.find((o) => o.kind === answer);
        send({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: opt.optionId } } });
      } else if (m.id !== undefined && m.method === undefined) pending.get(m.id)?.(m);
    }
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const n = id++;
      pending.set(n, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
      send({ jsonrpc: "2.0", id: n, method, params });
    });
  await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  const { sessionId } = await request("session/new", { cwd, mcpServers: [] });
  countTurn(`S17-01 DSH permissions: ${label}`);
  const t0 = Date.now();
  const r = await Promise.race([request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }), sleep(240_000).then(() => ({ stopReason: "spike-timeout" }))]);
  const text_ = updates.filter((u) => u.sessionUpdate === "agent_message_chunk").map((u) => u.content?.text ?? "").join("");
  const tools = updates.filter((u) => u.sessionUpdate === "tool_call").map((u) => ({ title: u.title, input: JSON.stringify(u.rawInput).slice(0, 200) }));
  const toolResults = updates.filter((u) => u.sessionUpdate === "tool_call_update" && u.status).map((u) => `${u.status}: ${JSON.stringify(u.content ?? null).slice(0, 200)}`);
  const entry = { label, mode, answer, stopReason: r.stopReason, ms: Date.now() - t0, permissions, tools, toolResults, text: text_.slice(0, 400), ...check(cwd, outside) };
  results.push(entry);
  console.log(JSON.stringify(entry, null, 1).slice(0, 1500));
  child.stdin.end();
  await Promise.race([new Promise((r) => child.on("exit", r)), sleep(10_000).then(() => child.kill())]);
}

const writeA = "Create a file named a.txt in the current directory containing the word yes, using a shell command. Do not use any other method.";
const writeOutside = "Using a shell command, create a file named outside.txt in the PARENT directory of the current directory (..\\outside.txt) containing the word yes.";
const aExists = (cwd) => ({ fileCreated: fs.existsSync(path.join(cwd, "a.txt")) });
const outsideExists = (_cwd, outside) => ({ fileCreated: fs.existsSync(outside) });
try {
  await run("read-only", "ro-allow", writeA, "allow_once", aExists);
  await run("read-only", "ro-reject", writeA, "reject_once", aExists);
  await run("read-only", "ro-read", "Run the shell command `Get-ChildItem` and tell me how many entries there are.", "reject_once", () => ({}));
  await run("workspace-write", "ww-outside-allow", writeOutside, "allow_once", outsideExists);
} finally {
  fs.mkdirSync(path.join(import.meta.dirname, "results"), { recursive: true });
  fs.writeFileSync(path.join(import.meta.dirname, "results", "s17-01.json"), JSON.stringify(results, null, 2));
}
