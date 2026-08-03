const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveCodexProvider } = require("./codex-provider");

test("DeepSeek preset uses the official Responses endpoint and an environment-scoped key", () => {
  const provider = resolveCodexProvider({
    presetId: "deepseek-v4",
    apiKey: "deepseek-secret",
  });

  assert.equal(provider.id, "deepseek-v4");
  assert.equal(provider.providerId, "amo-deepseek");
  assert.equal(provider.model, "deepseek-v4-flash");
  assert.equal(provider.baseUrl, "https://api.deepseek.com/");
  assert.deepEqual(provider.environment, { DEEPSEEK_API_KEY: "deepseek-secret" });
});

test("DeepSeek Codex preset requires a key", () => {
  assert.throws(
    () => resolveCodexProvider({ presetId: "deepseek-v4" }),
    (error) => error?.code === "codex_provider_api_key_required",
  );
});

test("Codex default preserves the user's local provider configuration", () => {
  const provider = resolveCodexProvider({ presetId: "openai-default" });
  assert.equal(provider.model, null);
  assert.equal(provider.providerId, null);
  assert.deepEqual(provider.environment, {});
});
