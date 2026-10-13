// S9-01: the person's own subscriptions in Studio — GPT through Codex's default login, Claude through the
// subscription token saved in 设置 → 模型凭据.
//   npm run build && node spikes/s9-01-subscriptions.mjs gpt      (budget: gpt 1)
//   npm run build && node spikes/s9-01-subscriptions.mjs claude   (budget: claude 1; needs the token saved first)
// Same read-only prompt as S9-00 in a sandbox workspace; approvals are accepted (the prompt forbids edits). GPT runs
// with Codex's real home (~/.codex), as Studio does for that profile: that is where the login is. Prints item shapes
// (lengths, not contents). The Claude run also asks whether the token leaks into the commands the agent runs.
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

const which = process.argv[2];
if (which !== "gpt" && which !== "claude") throw new Error("usage: node spikes/s9-01-subscriptions.mjs gpt|claude");

const workspaceDir = sandboxWorkspace("s9-01/workspace");
fs.writeFileSync(path.join(workspaceDir, "importer.py"), "import requests\n\n\ndef fetch(url):\n    return requests.get(url, timeout=10).json()\n");
const dataDir = sandboxWorkspace(`s9-01/data-${which}-${Date.now()}`);
const store = new Store(path.join(dataDir, "studio.db"));
const credentials = new WindowsCredentialReader();
const workspace = store.addWorkspace({ path: workspaceDir, name: "s9-01" });
const task = store.createTask({ title: "S9-01", scope: { kind: "workspace", workspaceId: workspace.id } });
const until = async (pred, label, ms = 300_000) => {
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
        return { type: i.type, state: i.state, usage: i.usage ?? null, seconds: i.endedAt ? (Date.parse(i.endedAt) - Date.parse(i.startedAt)) / 1000 : null, error: i.error ?? null };
      case "reasoning":
        return { type: i.type, chars: i.text.length, durationMs: i.durationMs ?? null };
      case "tool":
        return { type: i.type, kind: i.kind, summary: i.summary.slice(0, 60), status: i.status, exitCode: i.exitCode ?? null, outChars: i.detail?.length ?? 0 };
      case "agent":
        return { type: i.type, chars: i.markdown.length };
      case "error":
      case "notice":
        return { type: i.type, message: i.message.slice(0, 200) };
      default:
        return { type: i.type };
    }
  });
const done = (id) => () => store.listItems(id).some((i) => i.type === "turn" && i.state !== "running") && !["running", "awaiting-approval"].includes(store.getSession(id).status);
const out = { which };
const prompt = process.env.S9_PROMPT ?? "读一下 importer.py，用两句话说说 fetch 失败时会怎样。不要修改文件。";

if (which === "gpt") {
  const manager = new CodexServerManager({ dataDir: path.join(dataDir, "codex"), profiles: BUILTIN_PROFILES, credentials, cwd: dataDir, portRange: [47940, 47949] });
  const codex = new CodexRuntime({ store, servers: manager, profiles: BUILTIN_PROFILES });
  try {
    countTurn("S9-01 GPT (Codex default login)", "gpt");
    const s = await codex.startSession({ taskId: task.id, profileId: "codex-default", workspace, text: prompt });
    const approver = setInterval(() => {
      for (const a of store.listItems(s.id)) if (a.type === "approval" && a.state === "pending") void codex.respondApproval(s.id, a.approvalId, "accept").catch(() => undefined);
    }, 300);
    await until(done(s.id), "gpt turn");
    clearInterval(approver);
    out.items = shape(store.listItems(s.id));
  } finally {
    await manager.stopAll();
  }
} else {
  const claude = new ClaudeRuntime({ store, profiles: BUILTIN_PROFILES, providers: BUILTIN_CLAUDE_PROVIDERS, credentials, claudeHome: sandboxWorkspace("s9-01/claude-home") });
  try {
    countTurn("S9-01 Claude subscription token", "claude");
    const text = `${prompt}\n另外运行这条命令并告诉我输出：[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo TOKEN-VISIBLE || echo TOKEN-HIDDEN`;
    const s = await claude.startSession({ taskId: task.id, profileId: "claude-subscription", workspace, text });
    const approver = setInterval(() => {
      for (const a of store.listItems(s.id)) if (a.type === "approval" && a.state === "pending") void claude.respondApproval(s.id, a.approvalId, "accept").catch(() => undefined);
    }, 300);
    await until(done(s.id), "claude turn");
    clearInterval(approver);
    out.items = shape(store.listItems(s.id));
    const command = store.listItems(s.id).find((i) => i.type === "tool" && i.kind === "command");
    out.tokenInCommands = command?.detail?.includes("TOKEN-VISIBLE") ? "visible" : command?.detail?.includes("TOKEN-HIDDEN") ? "hidden" : "not run";
  } finally {
    await claude.closeAll();
  }
}
store.close();
console.log(JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "results", `s9-01-${which}.json`), JSON.stringify(out, null, 2));
