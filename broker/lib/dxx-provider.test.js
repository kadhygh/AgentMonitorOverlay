const test = require("node:test");
const assert = require("node:assert/strict");
const catalog = require("../assets/codex/dxx.models.json");
const { resolveCodexProvider } = require("./codex-provider");
const { createCodexLaunchArgs } = require("./codex-launch-config");
const { buildPowerShellCommandLine } = require("./terminal-launch");

for (const [presetId, model] of [["dxx", "gpt-5.6-sol"], ["dxx-gpt-6-astra", "gpt-6-astra"]]) {
test(`${presetId} launch and resume use the selected model with shared DXX routing`, () => {
  const provider = resolveCodexProvider({ presetId, apiKey: "dxx-test-secret" });
  assert.equal(provider.id, presetId);
  assert.deepEqual(provider.environment, { DXX_API_KEY: "dxx-test-secret" });
  const args = createCodexLaunchArgs({ provider });
  assert.ok(args.includes(`model="${model}"`));
  assert.ok(args.includes('model_provider="amo-dxx"'));
  assert.ok(args.includes('model_providers.amo-dxx.base_url="https://gorilla-api.dxxapi.com"'));
  assert.ok(args.includes('model_providers.amo-dxx.wire_api="responses"'));
  assert.ok(args.includes('model_providers.amo-dxx.env_key="DXX_API_KEY"'));
  assert.ok(args.some(arg => arg.startsWith("model_catalog_json=") && arg.includes("dxx.models.json")));
  const command = buildPowerShellCommandLine({ workspacePath: "G:/PROJECT/demo", title: "DXX", command: "codex", args: [...args, "resume", "same-session"], cleanupEnvironmentKeys: Object.keys(provider.environment) });
  assert.ok(command.includes("'resume' 'same-session'"));
  assert.ok(command.includes("'Env:DXX_API_KEY'"));
  assert.ok(!command.includes("dxx-test-secret"));
  assert.ok(!command.includes("DEEPSEEK_API_KEY"));
});

test(`${presetId} rejects a missing key instead of falling back to the global account`, () => {
  assert.throws(() => resolveCodexProvider({ presetId }), e => e.code === "codex_provider_api_key_required");
});
}

test("DXX catalog exposes both models for CLI switching using gateway-compatible tools and transport", () => {
  assert.deepEqual(catalog.models.map(model => model.slug), ["gpt-5.6-sol", "gpt-6-astra"]);
  for (const model of catalog.models) {
    assert.equal(model.visibility, "list");
    assert.equal(model.supported_in_api, true);
    assert.equal(model.prefer_websockets, false);
    assert.equal(model.use_responses_lite, false);
    assert.equal(model.tool_mode, null);
    assert.ok(model.supported_reasoning_levels.some(level => level.effort === "high"));
    assert.match(model.base_instructions, /agentic coding assistant/u);
  }
});
