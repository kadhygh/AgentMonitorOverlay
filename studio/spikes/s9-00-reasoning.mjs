// S9-00: do real models give the conversation what stage 9 shows — thinking, per-turn usage, tool rows?
//   npm run build && node spikes/s9-00-reasoning.mjs
// One DeepSeek Flash turn through Codex (show_raw_agent_reasoning on, as Studio launches it) and one GLM turn
// through Claude, each in a sandbox workspace with a sandbox CODEX_HOME / Claude config dir. Budget: 1 DeepSeek, 1 GLM.
// Prints what kinds of items arrived and their shape (lengths, not contents).
import fs from "node:fs";
import path from "node:path";
import {
  BUILTIN_CLAUDE_PROVIDERS,
  BUILTIN_PROFILES,
  ClaudeRuntime,
  CodexRuntime,
  CodexServerManager,
  Store,
  WindowsCredentialReader,
} from "../packages/host/dist/index.js";
import { countTurn, sandboxWorkspace } from "./lib.mjs";

const root = sandboxWorkspace("s9-00");
const workspaceDir = sandboxWorkspace("s9-00/workspace");
fs.writeFileSync(path.join(workspaceDir, "importer.py"), "import requests\n\n\ndef fetch(url):\n    return requests.get(url, timeout=10).json()\n");
const dataDir = path.join(root, `data-${Date.now()}`);
fs.mkdirSync(dataDir, { recursive: true });
const store = new Store(path.join(dataDir, "studio.db"));
const credentials = new WindowsCredentialReader();
const workspace = store.addWorkspace({ path: workspaceDir, name: "s9-00" });
const task = store.createTask({ title: "S9-00", scope: { kind: "workspace", workspaceId: workspace.id } });
const until = async (pred, label, ms = 180_000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
const shape = (items) =>
  items.map((i) => {
    switch (i.type) {
      case "turn":
        return { type: i.type, state: i.state, usage: i.usage ?? null, seconds: i.endedAt ? (Date.parse(i.endedAt) - Date.parse(i.startedAt)) / 1000 : null };
      case "reasoning":
        return { type: i.type, chars: i.text.length, durationMs: i.durationMs ?? null, streaming: i.streaming };
      case "tool":
        return { type: i.type, kind: i.kind, name: i.name, summary: i.summary.slice(0, 60), status: i.status, exitCode: i.exitCode ?? null, outChars: i.detail?.length ?? 0, files: i.files?.length ?? 0 };
      case "agent":
        return { type: i.type, chars: i.markdown.length };
      default:
        return { type: i.type };
    }
  });
const prompt = "读一下 importer.py，用两句话说说 fetch 失败时会怎样。不要修改文件。";
const out = {};

// ---- Codex + DeepSeek Flash ----
const manager = new CodexServerManager({
  dataDir: path.join(dataDir, "codex"),
  profiles: BUILTIN_PROFILES,
  credentials,
  cwd: dataDir,
  env: { CODEX_HOME: sandboxWorkspace("s9-00/codex-home") },
  portRange: [47940, 47949],
});
// Studio's own defaults (on-request, workspace-write); approvals are accepted here. ("never" + read-only made Codex
// reject every command before it ran, and a rejected command produces no item at all.)
const codex = new CodexRuntime({ store, servers: manager, profiles: BUILTIN_PROFILES });
try {
  countTurn("S9-00 DeepSeek reasoning through Codex", "deepseek");
  const s = await codex.startSession({ taskId: task.id, profileId: "codex-deepseek-flash", workspace, text: prompt });
  const approver = setInterval(() => {
    for (const a of store.listItems(s.id)) if (a.type === "approval" && a.state === "pending") void codex.respondApproval(s.id, a.approvalId, "accept").catch(() => undefined);
  }, 300);
  await until(() => store.listItems(s.id).some((i) => i.type === "turn" && i.state !== "running") && store.getSession(s.id).status !== "running", "codex turn");
  clearInterval(approver);
  out.codex = shape(store.listItems(s.id));
  console.log("codex", JSON.stringify(out.codex, null, 1));
} finally {
  await manager.stopAll();
}

// ---- Claude + GLM ----  (S9_SKIP_CLAUDE=1 runs the Codex half only)
if (process.env.S9_SKIP_CLAUDE) {
  store.close();
  process.exit(0);
}
const claude = new ClaudeRuntime({ store, profiles: BUILTIN_PROFILES, providers: BUILTIN_CLAUDE_PROVIDERS, credentials, claudeHome: sandboxWorkspace("s9-00/claude-home") });
try {
  countTurn("S9-00 GLM thinking through Claude", "glm");
  const s = await claude.startSession({ taskId: task.id, profileId: "claude-glm", workspace, text: prompt });
  // Default mode may ask before reading; approve so the turn can finish (the prompt forbids edits).
  const approver = setInterval(() => {
    for (const a of store.listItems(s.id)) if (a.type === "approval" && a.state === "pending") void claude.respondApproval(s.id, a.approvalId, "accept").catch(() => undefined);
  }, 300);
  await until(() => store.listItems(s.id).some((i) => i.type === "turn" && i.state !== "running") && store.getSession(s.id).status !== "running", "claude turn");
  clearInterval(approver);
  out.claude = shape(store.listItems(s.id));
  console.log("claude", JSON.stringify(out.claude, null, 1));
} finally {
  await claude.closeAll();
  store.close();
}
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "results", "s9-00-reasoning.json"), JSON.stringify(out, null, 2));
