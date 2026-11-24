// One turn per model against this spike's MCP server: does the model see only the simulated 协作 tools (not Studio's),
// does a tool call reach the server, which built-in tools and instruction files come along, what usage comes back.
//   node spikes/collab-spec-eval/smoke.mjs [sonnet|gpt6.2sol|dxx-ds …]
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { countTurn, SANDBOX_ROOT } from "../lib.mjs";
import { Collab } from "./collab.mjs";
import { startMcp } from "./mcp.mjs";
import { makeRunner, BUDGET } from "./run-lib.mjs";

try {
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
} catch {}
const models = process.argv.slice(2).length ? process.argv.slice(2) : ["sonnet", "gpt6.2sol", "dxx-ds"];
const root = path.join(SANDBOX_ROOT, `collab-spec-smoke-${Date.now()}`);
mkdirSync(path.join(root, "ws"), { recursive: true });
const C = new Collab(path.join(root, "state.json"), { title: "冒烟", ref: "cowork:smoke", goal: "只看工具能不能用", decisions: [], people: { 小王: { side: "W" } } });
C.addAgent({ key: "WM", name: "小王的主控", role: "lead", side: "W", person: "小王" });
const mcp = await startMcp({ collab: C, hooks: { roleCard: () => "你是小王的主控（冒烟）。" }, log: console.log });
const out = {};
for (const model of models) {
  const r = makeRunner(model, { key: "WM", cwd: path.join(root, "ws"), mcpUrl: `${mcp.url}/mcp/WM`, dir: root, root });
  countTurn(`collab-spec-eval smoke ${model}`, BUDGET[model]);
  const t = await r.turn("调用 cowork_read（不带参数），用一句话说出协作的标题。然后列出你现在能调用的全部工具名（内置的和 MCP 的都列）。最后：你的上下文里有没有 CLAUDE.md、AGENTS.md 或别的项目/用户说明？有就引用第一行，没有就说没有。");
  await r.close();
  out[model] = { text: t.text, usage: t.usage, error: t.error, tools: t.tools, init: t.init, calls: C.s.calls.length };
  console.log(model, JSON.stringify(out[model], null, 1).slice(0, 3000));
}
writeFileSync(path.join(root, "smoke.json"), JSON.stringify(out, null, 1));
await mcp.close();
console.log("sandbox", root);
process.exit(0);
