const { httpError } = require("./http");
const { normalizeText } = require("./normalize");

const DEFAULT_PROVIDER = "openai-default";
const PROVIDER_PRESETS = Object.freeze({
  [DEFAULT_PROVIDER]: {
    id: DEFAULT_PROVIDER,
    label: "Codex default",
    model: null,
    requiresApiKey: false,
    providerId: null,
    baseUrl: null,
    environment: {},
  },
  "deepseek-v4": {
    id: "deepseek-v4",
    label: "DeepSeek V4 Flash",
    model: "deepseek-v4-flash",
    requiresApiKey: true,
    providerId: "amo-deepseek",
    baseUrl: "https://api.deepseek.com/",
    environment: {
      DEEPSEEK_API_KEY: null,
    },
  },
});

function resolveCodexProvider(payload) {
  const providerId = normalizeText(payload?.presetId || payload?.preset_id || payload?.id) || DEFAULT_PROVIDER;
  const preset = PROVIDER_PRESETS[providerId];
  if (!preset) {
    throw httpError(400, "unsupported_codex_provider", `Unsupported Codex provider preset: ${providerId}`);
  }

  const apiKey = normalizeSecret(payload?.apiKey || payload?.api_key);
  if (preset.requiresApiKey && !apiKey) {
    throw httpError(400, "codex_provider_api_key_required", `${preset.label} requires an API key for this launch`);
  }

  return {
    id: preset.id,
    label: preset.label,
    model: preset.model,
    providerId: preset.providerId,
    baseUrl: preset.baseUrl,
    environment: preset.requiresApiKey
      ? { DEEPSEEK_API_KEY: apiKey }
      : {},
  };
}

function normalizeSecret(value) {
  if (value === null || value === undefined) return "";
  const secret = String(value).trim();
  if (secret.length > 8192) {
    throw httpError(400, "codex_provider_api_key_too_long", "Codex provider API key is too long");
  }
  return secret;
}

module.exports = {
  DEFAULT_PROVIDER,
  PROVIDER_PRESETS,
  resolveCodexProvider,
};
