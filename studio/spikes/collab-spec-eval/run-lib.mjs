// Which runner a model name uses, and which budget.json provider its turns count against (spikes/lib.mjs countTurn).
import path from "node:path";
import { ClaudeRunner, CodexRunner, DshRunner } from "./runners.mjs";

export const BUDGET = { sonnet: "claude", "gpt6.2sol": "gpt", "dxx-ds": "deepseek" };

export const MODEL_NOTES = {
  sonnet: "Claude Code（本机登录）的 sonnet，claude -p --strict-mcp-config",
  "gpt6.2sol": "DXX 站点的 gpt-6.2-sol，codex exec（自己的 CODEX_HOME）",
  "dxx-ds": "DeepSeek 内置渠道（DSH 源码 clone，ACP），不是用户的 Dxx-DS 渠道；和 cowork-scenario 一样",
};

export function makeRunner(model, { key, cwd, mcpUrl, dir, root }) {
  if (model === "sonnet") return new ClaudeRunner({ key, cwd, mcpUrl, dir, model: "sonnet" });
  if (model === "gpt6.2sol") return new CodexRunner({ key, cwd, mcpUrl, dir, codexHome: path.join(root, "codex-home") });
  if (model === "dxx-ds") return new DshRunner({ key, cwd, mcpUrl, dir, dshHome: path.join(root, "dsh-home"), dshRoot: process.env.AMO_STUDIO_DSH_CLONE || "G:\\PROJECT\\deepseek-harness" });
  throw new Error(`unknown model ${model}: ${Object.keys(BUDGET).join(", ")}`);
}
