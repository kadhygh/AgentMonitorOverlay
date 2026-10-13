// S12-E spike: which Claude Code CLI features reach an SDK client, measured with the real Claude Code (bundled with
// the Agent SDK) against the mock Anthropic API. No model budget is used.
//   node spikes/s12-e-claude-cli.mjs [step…]   steps: commands compact cost unknown bg progress suggest image retry
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { defaultClaudeScript, mockClaudeEnv, startMockAnthropic, TINY_PNG_BASE64 } from "../packages/testkit/dist/index.js";

const steps = new Set(process.argv.slice(2));
const want = (s) => steps.size === 0 || steps.has(s);

let failNext = 0;
const mock = await startMockAnthropic({
  script: (req) => {
    const t = req.lastUserText;
    if (t.startsWith("[SUGGESTION MODE")) return { kind: "text", text: "run the tests" };
    if (!req.afterToolOutput && req.tools.includes("Bash")) {
      const bg = /\[\[bg:\s*([^\]]+)\]\]/.exec(t);
      if (bg) return { kind: "tool_use", name: "Bash", input: { command: bg[1].trim(), description: "bg", run_in_background: true } };
      const fg = /\[\[fg:\s*([^\]]+)\]\]/.exec(t);
      if (fg) return { kind: "tool_use", name: "Bash", input: { command: fg[1].trim(), description: "fg" } };
    }
    if (!req.afterToolOutput && t.includes("[[read-image]]") && req.tools.includes("Read")) return { kind: "tool_use", name: "Read", input: { file_path: join(ws, "pic.png") } };
    return defaultClaudeScript(req);
  },
});
// Errors for the retry step: wrap the server's handler by failing the next N requests with 529.
const origEmit = mock.close;
const root = mkdtempSync(join(tmpdir(), "amo-studio-test-s12e-spike-"));
const home = join(root, "claude-home");
const ws = join(root, "ws");
mkdirSync(home, { recursive: true });
mkdirSync(ws, { recursive: true });
writeFileSync(join(ws, "pic.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/.test(k))), ...mockClaudeEnv(mock.baseUrl), CLAUDE_CONFIG_DIR: home };

const queue = [];
let wake = null;
async function* input() {
  for (;;) {
    while (queue.length) yield { type: "user", message: { role: "user", content: queue.shift() }, parent_tool_use_id: null, session_id: "" };
    await new Promise((r) => (wake = r));
  }
}
const send = (text) => {
  queue.push(text);
  wake?.();
};

const q = query({
  prompt: input(),
  options: {
    cwd: ws,
    env,
    settingSources: [],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: false,
    promptSuggestions: want("suggest"),
  },
});

const seen = [];
let results = 0;
(async () => {
  for await (const m of q) {
    if (m.type === "stream_event") continue;
    const key = m.type === "system" ? `system/${m.subtype}` : m.type;
    const brief = { ...m };
    delete brief.uuid;
    delete brief.session_id;
    if (m.type === "assistant" || m.type === "user") brief.message = JSON.stringify(m.message.content).slice(0, 400);
    if (key === "system/init") {
      console.log("init: slash_commands", JSON.stringify(m.slash_commands), "skills", JSON.stringify(m.skills));
      continue;
    }
    seen.push(key);
    console.log("MSG", key, JSON.stringify(brief).slice(0, 700));
    if (m.type === "result") results++;
  }
})();

const waitResults = async (n, ms = 60_000) => {
  const start = Date.now();
  while (results < n && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 100));
  if (results < n) console.log("TIMEOUT waiting for result", n);
};

let expected = 0;
const turn = async (label, text, waitMs) => {
  console.log(`\n===== ${label}: ${text}`);
  send(text);
  await waitResults(++expected, waitMs);
};

if (want("commands")) {
  const cmds = await q.supportedCommands();
  console.log("supportedCommands:", cmds.length);
  for (const c of cmds) console.log(`  /${c.name}${c.builtin ? " [builtin]" : ""}${c.aliases?.length ? ` (${c.aliases.join(",")})` : ""} ${c.argumentHint ?? ""} — ${c.description}`);
}
await turn("first", "hello");
if (want("cost")) await turn("cost", "/cost");
if (want("context")) await turn("context", "/context");
if (want("unknown")) await turn("unknown", "/nope-not-a-command");
if (want("compact")) await turn("compact", "/compact");
if (want("bg")) {
  await turn("bg", "[[bg: ping -n 6 127.0.0.1]]");
  await new Promise((r) => setTimeout(r, 8000));
}
if (want("progress")) await turn("progress", "[[fg: ping -n 8 127.0.0.1]]", 90_000);
if (want("image")) await turn("image", "[[read-image]]");
if (want("suggest")) await turn("suggest", "second turn for a suggestion");
if (want("refuse")) await turn("refuse", "[[refuse]] please");
if (want("retry")) await turn("retry", "[[retry]] please", 90_000);
await new Promise((r) => setTimeout(r, 3000));
console.log("\nkinds seen:", [...new Set(seen)].join(" "));
console.log("mock requests:", mock.requests.length, mock.requests.map((r) => `${r.lastUserText.slice(0, 30)}|tools=${r.tools.length}`).join(" ; "));
q.close();
await mock.close();
void origEmit;
void failNext;
process.exit(0);
