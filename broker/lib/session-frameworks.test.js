const test = require("node:test");
const assert = require("node:assert/strict");
const { canonicalFrameworkId } = require("./session-frameworks");

test("runtime aliases normalize without defining Card identity or guessing unknown providers", () => {
  for (const [alias, expected] of [[" Codex-CLI ", "codex"], ["CLAUDE CODE", "claude"], ["grok-cli", "grok"], ["something-codex-like", "unknown"], [null, "unknown"], [{ tool: "codex" }, "unknown"]]) assert.equal(canonicalFrameworkId(alias), expected);
});

test("all existing AgentTool aliases retain canonical runtime identity", () => {
  for (const [tool, expected] of [["codex", "codex"], ["codex-cli", "codex"], ["codex-app", "codex"], ["claude", "claude"], ["claude-cli", "claude"], ["grok", "grok"], ["grok-build", "grok"], ["other", "unknown"]]) assert.equal(canonicalFrameworkId(tool), expected);
});
