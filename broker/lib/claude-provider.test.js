const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveClaudeProvider } = require("./claude-provider");

test("GLM preset overrides user-level model routing for the launch", () => {
  const provider = resolveClaudeProvider({
    presetId: "glm-5.2",
    apiKey: "glm-secret",
  });

  assert.equal(provider.id, "glm-5.2");
  assert.equal(provider.model, "glm-5.2[1m]");
  assert.deepEqual(provider.environment, {
    ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
    ANTHROPIC_MODEL: "glm-5.2[1m]",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.7",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2[1m]",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5.2[1m]",
    CLAUDE_CODE_SUBAGENT_MODEL: "glm-4.7",
    CLAUDE_CODE_EFFORT_LEVEL: "max",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    API_TIMEOUT_MS: "3000000",
    ANTHROPIC_AUTH_TOKEN: "glm-secret",
  });
});

test("DeepSeek preset carries its full one-launch routing", () => {
  const provider = resolveClaudeProvider({
    presetId: "deepseek-v4",
    apiKey: "deepseek-secret",
  });

  assert.equal(provider.model, "deepseek-v4-pro[1m]");
  assert.equal(provider.environment.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(provider.environment.ANTHROPIC_MODEL, "deepseek-v4-pro[1m]");
  assert.equal(provider.environment.ANTHROPIC_DEFAULT_HAIKU_MODEL, "deepseek-v4-flash");
  assert.equal(provider.environment.CLAUDE_CODE_SUBAGENT_MODEL, "deepseek-v4-flash");
  assert.equal(provider.environment.ANTHROPIC_AUTH_TOKEN, "deepseek-secret");
});

test("third-party Claude presets require a key", () => {
  assert.throws(
    () => resolveClaudeProvider({ presetId: "glm-5.2" }),
    (error) => error?.code === "claude_provider_api_key_required",
  );
});

test("Claude default keeps the local Claude Code configuration", () => {
  const provider = resolveClaudeProvider({ presetId: "anthropic-default" });
  assert.equal(provider.model, null);
  assert.deepEqual(provider.environment, {});
});