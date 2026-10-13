import { query } from "@anthropic-ai/claude-agent-sdk";
import { BUILTIN_CLAUDE_PROVIDERS, BUILTIN_PROFILES, WindowsCredentialReader, claudeEnv } from "../packages/host/dist/index.js";
import { sandboxWorkspace } from "./lib.mjs";
const profile = BUILTIN_PROFILES.find((p) => p.id === "claude-glm");
const env = claudeEnv(profile, BUILTIN_CLAUDE_PROVIDERS, new WindowsCredentialReader(), sandboxWorkspace("probe/claude-home"));
let stop; const gate = new Promise((r) => (stop = r));
async function* input() { await gate; }
const t = Date.now();
const q = query({ prompt: input(), options: { cwd: sandboxWorkspace("probe/ws"), env, settingSources: [], permissionMode: "default" } });
const models = await q.supportedModels();
console.log("ms", Date.now() - t);
console.log(JSON.stringify(models.map((m) => ({ value: m.value, name: m.displayName, effort: m.supportedEffortLevels, resolved: m.resolvedModel })), null, 0));
stop(); q.close();
