const { httpError } = require("./http");
const { normalizeText } = require("./normalize");

const DEFAULT_PROVIDER = "anthropic-default";
const PROVIDER_PRESETS = Object.freeze({
  [DEFAULT_PROVIDER]: {
    id: DEFAULT_PROVIDER,
    label: "Claude default",
    model: null,
    requiresApiKey: false,
    environment: {},
  },
  "deepseek-v4": {
    id: "deepseek-v4",
    label: "DeepSeek V4 Pro 1M",
    model: "deepseek-v4-pro[1m]",
    requiresApiKey: true,
    environment: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_MODEL: "deepseek-v4-pro[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro[1m]",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
      CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
    },
  },
  "glm-5.2": {
    id: "glm-5.2",
    label: "GLM-5.2 1M",
    model: "glm-5.2[1m]",
    requiresApiKey: true,
    environment: {
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
    },
  },
});

function resolveClaudeProvider(payload) {
  const providerId = normalizeText(payload?.presetId || payload?.preset_id || payload?.id) || DEFAULT_PROVIDER;
  const preset = PROVIDER_PRESETS[providerId];
  if (!preset) {
    throw httpError(400, "unsupported_claude_provider", `Unsupported Claude provider preset: ${providerId}`);
  }

  const apiKey = normalizeSecret(payload?.apiKey || payload?.api_key);
  if (preset.requiresApiKey && !apiKey) {
    throw httpError(400, "claude_provider_api_key_required", `${preset.label} requires an API key for this launch`);
  }

  return {
    id: preset.id,
    label: preset.label,
    model: preset.model,
    environment: preset.requiresApiKey
      ? { ...preset.environment, ANTHROPIC_AUTH_TOKEN: apiKey }
      : {},
  };
}

function normalizeSecret(value) {
  if (value === null || value === undefined) return "";
  const secret = String(value).trim();
  if (secret.length > 8192) {
    throw httpError(400, "claude_provider_api_key_too_long", "Claude provider API key is too long");
  }
  return secret;
}

module.exports = {
  DEFAULT_PROVIDER,
  PROVIDER_PRESETS,
  resolveClaudeProvider,
};
