// S12-E spike: what the real `codex app-server` sends for compaction, review mode, skills and retries, against the
// mock Responses model (no model budget). Prints every notification and the item types seen.
//   node spikes/s12-e-codex-cli.mjs [step…]   steps: compact review skills retry
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultScript, mockCodexProvider, startMockModel } from "../packages/testkit/dist/index.js";
import { CodexServerManager } from "../packages/host/dist/runtime/codex/server-manager.js";
import { StaticCredentialReader } from "../packages/host/dist/runtime/credentials.js";

const steps = new Set(process.argv.slice(2));
const want = (s) => steps.size === 0 || steps.has(s);

let failures = 0;
const mock = await startMockModel({
  script: (req) => {
    if (req.lastUserText.includes("[[retry]]") && failures < 2) {
      failures++;
      throw new Error("mock overloaded");
    }
    const view = /\[\[view-image\]\]/.exec(req.lastUserText);
    if (view && !req.afterToolOutput && req.tools.includes("view_image")) return { kind: "function_call", name: "view_image", arguments: { path: join(ws, "pic.png") } };
    return defaultScript(req);
  },
});
const root = mkdtempSync(join(tmpdir(), "amo-studio-test-s12e-codex-"));
const ws = join(root, "ws");
mkdirSync(join(root, "codex-home"), { recursive: true });
mkdirSync(join(ws, ".agents", "skills", "hello-skill"), { recursive: true });
writeFileSync(join(ws, ".agents", "skills", "hello-skill", "SKILL.md"), "---\nname: hello-skill\ndescription: Says hello for tests\n---\n\nSay hello.\n");
writeFileSync(join(ws, "a.txt"), "one\n");
execFileSync("git", ["init", "-q"], { cwd: ws });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: ws });
execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: ws });
writeFileSync(join(ws, "a.txt"), "one\ntwo\n");

const PROFILES = [{ id: "codex-mock", label: "Mock", runtime: "codex", provider: "amo-mock", model: "mock-model", credentialId: "mock" }];
const manager = new CodexServerManager({
  dataDir: join(root, "data"),
  profiles: PROFILES,
  credentials: new StaticCredentialReader({ mock: "mock-key" }),
  cwd: root,
  env: { CODEX_HOME: join(root, "codex-home") },
  providers: { "amo-mock": mockCodexProvider(mock.baseUrl) },
  portRange: [47940, 47949],
});
const h = await manager.ensure("codex-mock");
const seen = new Map();
let turnDone = 0;
h.client.on("notification", (n) => {
  const p = n.params ?? {};
  const key = n.method === "item/started" || n.method === "item/completed" ? `${n.method}:${p.item?.type}` : n.method;
  seen.set(key, (seen.get(key) ?? 0) + 1);
  if (/delta/i.test(n.method)) return;
  console.log("NOTE", key, JSON.stringify(p).slice(0, 500));
  if (n.method === "turn/completed") turnDone++;
});
h.client.on("request", (r) => console.log("REQ", r.method, JSON.stringify(r.params).slice(0, 300)));

const started = await h.client.request("thread/start", { cwd: ws, approvalPolicy: "never", sandbox: "danger-full-access", modelProvider: "amo-mock", model: "mock-model" });
const threadId = started.thread.id;
const waitTurns = async (n, ms = 60_000) => {
  const t0 = Date.now();
  while (turnDone < n && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
  if (turnDone < n) console.log("TIMEOUT waiting for turn", n);
};
let turns = 0;
const turn = async (text, extra = []) => {
  console.log(`\n===== turn: ${text}`);
  await h.client.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }, ...extra] });
  await waitTurns(++turns);
};

await turn("hello");
if (want("skills")) {
  const r = await h.client.request("skills/list", { cwds: [ws] });
  console.log("skills/list", JSON.stringify(r).slice(0, 1500));
  const skill = r.data?.[0]?.skills?.find((s) => s.name === "hello-skill");
  if (skill) await turn("$hello-skill please", [{ type: "skill", name: skill.name, path: skill.path }]);
  const last = mock.requests.at(-1);
  console.log("skill request input tail:", JSON.stringify(last.body.input).slice(-800));
}
if (want("compact")) {
  console.log("\n===== thread/compact/start");
  console.log("->", JSON.stringify(await h.client.request("thread/compact/start", { threadId })));
  await waitTurns(++turns);
}
if (want("review")) {
  console.log("\n===== review/start");
  console.log("->", JSON.stringify(await h.client.request("review/start", { threadId, target: { type: "uncommittedChanges" } })).slice(0, 400));
  await waitTurns(++turns, 90_000);
}
if (want("retry")) await turn("[[retry]] please");
if (want("spawn")) await turn("[[spawn: helper: say hi]]");
if (want("image")) {
  writeFileSync(join(ws, "pic.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  await turn("[[view-image]]");
}
await new Promise((r) => setTimeout(r, 1500));
console.log("\nseen:", JSON.stringify(Object.fromEntries(seen)));
console.log("mock requests:", mock.requests.length, mock.requests.map((r) => r.lastUserText.slice(0, 40)).join(" | "));
await manager.stopAll();
await mock.close();
process.exit(0);
