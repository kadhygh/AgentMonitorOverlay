// S9-04: "帮我审批" (Codex's "Approve for me", approvals_reviewer = auto_review) with GPT: commands that need approval go to
// Codex's review agent instead of the person. One GPT turn in a sandbox workspace (budget: gpt 1). Reading inside the
// workspace runs in the sandbox; writing one level up has to leave it, which is what the review agent decides.
//   npm run build && node spikes/s9-04-auto-review.mjs
import fs from "node:fs";
import path from "node:path";
import { BUILTIN_PROFILES, CodexRuntime, CodexServerManager, Store, WindowsCredentialReader } from "../packages/host/dist/index.js";
import { countTurn, sandboxWorkspace } from "./lib.mjs";

const workspaceDir = sandboxWorkspace("s9-04/workspace");
fs.writeFileSync(path.join(workspaceDir, "importer.py"), "import requests\n\n\ndef fetch(url):\n    return requests.get(url, timeout=10).json()\n");
const dataDir = sandboxWorkspace(`s9-04/data-${Date.now()}`);
const store = new Store(path.join(dataDir, "studio.db"));
const credentials = new WindowsCredentialReader();
const workspace = store.addWorkspace({ path: workspaceDir, name: "s9-04" });
const task = store.createTask({ title: "S9-04", scope: { kind: "workspace", workspaceId: workspace.id } });
const manager = new CodexServerManager({ dataDir: path.join(dataDir, "codex"), profiles: BUILTIN_PROFILES, credentials, cwd: dataDir, portRange: [47940, 47949] });
const codex = new CodexRuntime({ store, servers: manager, profiles: BUILTIN_PROFILES });
const out = {};
try {
  countTurn("S9-04 GPT auto-review (Approve for me)", "gpt");
  const s = await codex.startSession({ taskId: task.id, profileId: "codex-default", workspace, options: { permission: "auto-review" }, text: `先运行命令读一下 importer.py；再在上一级目录 ${path.dirname(workspaceDir)} 里新建 review-probe.txt，内容写 ok。最后用一句话说明两步的结果。` });
  const start = Date.now();
  while (!(store.listItems(s.id).some((i) => i.type === "turn" && i.state !== "running") && !["running", "awaiting-approval"].includes(store.getSession(s.id).status))) {
    if (Date.now() - start > 300_000) throw new Error("timeout");
    if (store.getSession(s.id).status === "awaiting-approval") out.askedThePerson = true;
    await new Promise((r) => setTimeout(r, 200));
  }
  out.items = store.listItems(s.id).map((i) => (i.type === "tool" ? { type: i.type, kind: i.kind, summary: i.summary.slice(0, 80), status: i.status, reason: i.detail?.slice(0, 160) } : { type: i.type, ...(i.type === "approval" ? { state: i.state } : {}) }));
  console.log(JSON.stringify(out, null, 1));
} finally {
  await manager.stopAll();
  store.close();
}
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "results", "s9-04-auto-review.json"), JSON.stringify(out, null, 2));
