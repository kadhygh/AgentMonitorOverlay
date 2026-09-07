const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveCodexProvider } = require("./codex-provider");
const { createCodexLaunchArgs } = require("./codex-launch-config");
const { buildPowerShellCommandLine } = require("./terminal-launch");

test("DXX launch and resume use their own endpoint, model, catalog, and secret environment", () => {
  const provider = resolveCodexProvider({ presetId: "dxx", apiKey: "dxx-test-secret" });
  assert.deepEqual(provider.environment, { DXX_API_KEY: "dxx-test-secret" });
  const args = createCodexLaunchArgs({ provider });
  assert.ok(args.includes('model="gpt-5.6-sol"'));
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

test("DXX rejects a missing key instead of falling back to the global account", () => {
  assert.throws(() => resolveCodexProvider({ presetId: "dxx" }), e => e.code === "codex_provider_api_key_required");
});
