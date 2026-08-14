const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveClaudeProvider } = require("./claude-provider");

test("GLM-5.3 preset uses the official 1M Claude Code mapping", () => {
  const provider = resolveClaudeProvider({
    presetId: "glm-5.3",
    apiKey: "glm-secret",
  });

  assert.equal(provider.id, "glm-5.3");
  assert.equal(provider.model, "glm-5.3[1m]");
  assert.deepEqual(provider.environment, {
    ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
    ANTHROPIC_MODEL: "glm-5.3[1m]",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.7",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.3[1m]",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.3[1m]",
    CLAUDE_CODE_SUBAGENT_MODEL: "glm-4.7",
    CLAUDE_CODE_EFFORT_LEVEL: "max",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    API_TIMEOUT_MS: "3000000",
    ANTHROPIC_AUTH_TOKEN: "glm-secret",
  });
});

test("legacy GLM-5.2 launch requests migrate to GLM-5.3", () => {
  const provider = resolveClaudeProvider({ presetId: "glm-5.2", apiKey: "glm-secret" });
  assert.equal(provider.id, "glm-5.3");
  assert.equal(provider.model, "glm-5.3[1m]");
});

test("DeepSeek V4 Pro preset uses the official mixed Claude Code mapping", () => {
  const provider = resolveClaudeProvider({
    presetId: "deepseek-v4-pro",
    apiKey: "deepseek-secret",
  });

  assert.equal(provider.id, "deepseek-v4-pro");
  assert.equal(provider.model, "deepseek-v4-pro[1m]");
  assert.equal(provider.environment.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(provider.environment.ANTHROPIC_MODEL, "deepseek-v4-pro[1m]");
  assert.equal(provider.environment.ANTHROPIC_DEFAULT_OPUS_MODEL, "deepseek-v4-pro[1m]");
  assert.equal(provider.environment.ANTHROPIC_DEFAULT_SONNET_MODEL, "deepseek-v4-pro[1m]");
  assert.equal(provider.environment.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek-v4-flash");
  assert.equal(provider.environment.CLAUDE_CODE_SUBAGENT_MODEL, "deepseek-v4-flash");
  assert.equal(provider.environment.CLAUDE_CODE_EFFORT_LEVEL, "max");
  assert.equal(provider.environment.ANTHROPIC_AUTH_TOKEN, "deepseek-secret");
});

test("DeepSeek preset routes every Claude model slot to V4 Flash", () => {
  const provider = resolveClaudeProvider({
    presetId: "deepseek-v4",
    apiKey: "deepseek-secret",
  });

  assert.equal(provider.model, "deepseek-v4-flash");
  assert.equal(provider.environment.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(provider.environment.ANTHROPIC_MODEL, "deepseek-v4-flash");
  assert.equal(provider.environment.ANTHROPIC_DEFAULT_OPUS_MODEL, "deepseek-v4-flash");
  assert.equal(provider.environment.ANTHROPIC_DEFAULT_SONNET_MODEL, "deepseek-v4-flash");
  assert.equal(provider.environment.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek-v4-flash");
  assert.equal(provider.environment.CLAUDE_CODE_SUBAGENT_MODEL, "deepseek-v4-flash");
  assert.equal(provider.environment.ANTHROPIC_AUTH_TOKEN, "deepseek-secret");
});

test("third-party Claude presets require a key", () => {
  assert.throws(
    () => resolveClaudeProvider({ presetId: "glm-5.3" }),
    (error) => error?.code === "claude_provider_api_key_required",
  );
});

test("Claude default keeps the local Claude Code configuration", () => {
  const provider = resolveClaudeProvider({ presetId: "anthropic-default" });
  assert.equal(provider.model, null);
  assert.deepEqual(provider.environment, {});
});
