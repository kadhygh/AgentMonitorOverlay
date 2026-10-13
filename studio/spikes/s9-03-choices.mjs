// S9-03: what each built-in profile offers (models, efforts, permissions), asked from the CLIs, and — with `turns` —
// whether the chosen effort and model really reach the models.
//   npm run build && node spikes/s9-03-choices.mjs            (lists only: no model call, no budget)
//   npm run build && node spikes/s9-03-choices.mjs turns      (GLM 3: effort low / max, model glm-4.7; GPT 1: effort high)
// Codex runs with the person's real ~/.codex (where the GPT login is), as Studio does; workspaces are sandboxed.
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

const turns = process.argv[2] === "turns";
const workspaceDir = sandboxWorkspace("s9-03/workspace");
const dataDir = sandboxWorkspace(`s9-03/data-${Date.now()}`);
const store = new Store(path.join(dataDir, "studio.db"));
const credentials = new WindowsCredentialReader();
const workspace = store.addWorkspace({ path: workspaceDir, name: "s9-03" });
const task = store.createTask({ title: "S9-03", scope: { kind: "workspace", workspaceId: workspace.id } });
const manager = new CodexServerManager({ dataDir: path.join(dataDir, "codex"), profiles: BUILTIN_PROFILES, credentials, cwd: dataDir, portRange: [47940, 47949] });
const codex = new CodexRuntime({ store, servers: manager, profiles: BUILTIN_PROFILES });
const claude = new ClaudeRuntime({ store, profiles: BUILTIN_PROFILES, providers: BUILTIN_CLAUDE_PROVIDERS, credentials, claudeHome: sandboxWorkspace("s9-03/claude-home") });
const out = { choices: {}, turns: [] };

const until = async (pred, label, ms = 300_000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
};
const done = (id) => () => store.listItems(id).some((i) => i.type === "turn" && i.state !== "running") && !["running", "awaiting-approval"].includes(store.getSession(id).status);

try {
  for (const p of BUILTIN_PROFILES) {
    const runtime = p.runtime === "codex" ? codex : claude;
    try {
      const c = await runtime.choices(p.id);
      out.choices[p.id] = { source: c.source, models: c.models.map((m) => `${m.id}${m.isDefault ? "*" : ""} [${m.efforts.join(",")}]${m.defaultEffort ? ` default=${m.defaultEffort}` : ""}`), permissions: c.permissions.map((x) => `${x.id}${x.unavailable ? "(unavailable)" : ""}`) };
    } catch (err) {
      out.choices[p.id] = { error: String(err).slice(0, 200) };
    }
    console.log(p.id, JSON.stringify(out.choices[p.id], null, 1));
  }

  if (turns) {
    const prompt = "不用读文件，直接回答：一个导入器每次请求失败概率 20%，最多重试 3 次（共 4 次尝试），指数退避基数 0.5 秒。请推算最终仍失败的概率和最坏情况下总共等待多少秒。";
    const run = async (runtime, profileId, options, budget, note) => {
      countTurn(note, budget);
      const s = await runtime.startSession({ taskId: task.id, profileId, workspace, text: prompt, options });
      await until(done(s.id), note);
      const items = store.listItems(s.id);
      const turn = items.find((i) => i.type === "turn");
      const r = {
        note,
        options,
        state: turn?.state,
        seconds: turn?.endedAt ? (Date.parse(turn.endedAt) - Date.parse(turn.startedAt)) / 1000 : null,
        usage: turn?.usage ?? null,
        thinkingChars: items.filter((i) => i.type === "reasoning").reduce((n, i) => n + i.text.length, 0),
        answerChars: items.filter((i) => i.type === "agent").reduce((n, i) => n + i.markdown.length, 0),
        errors: items.filter((i) => i.type === "error").map((i) => i.message.slice(0, 200)),
      };
      out.turns.push(r);
      console.log(JSON.stringify(r));
    };
    await run(claude, "claude-glm", { effort: "low" }, "glm", "S9-03 GLM effort low");
    await run(claude, "claude-glm", { effort: "max" }, "glm", "S9-03 GLM effort max");
    await run(claude, "claude-glm", { model: "glm-4.7" }, "glm", "S9-03 GLM model glm-4.7");
    await run(codex, "codex-default", { effort: "high" }, "gpt", "S9-03 GPT effort high");
  }
} finally {
  await manager.stopAll();
  await claude.closeAll();
  store.close();
}
fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "results", `s9-03-choices${turns ? "-turns" : ""}.json`), JSON.stringify(out, null, 2));
