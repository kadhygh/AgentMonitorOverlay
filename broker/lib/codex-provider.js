const { httpError } = require("./http");
const { normalizeText } = require("./normalize");
const { codexProfiles } = require("./deepseek-profiles");

const DEFAULT_PROVIDER = "openai-default";
const PROVIDER_PRESETS = Object.freeze({
  ...codexProfiles,
  [DEFAULT_PROVIDER]: {
    id: DEFAULT_PROVIDER,
    label: "GPT-Official",
    model: null,
    requiresApiKey: false,
    providerId: null,
    baseUrl: null,
    environment: {},
  },
  "dxx": {
    id: "dxx",
    label: "GPT-Dxx",
    model: "gpt-5.6-sol",
    requiresApiKey: true,
    providerId: "amo-dxx",
    baseUrl: "https://gorilla-api.dxxapi.com",
    envKey: "DXX_API_KEY",
    modelCatalogFile: "dxx.models.json",
  },
  "dxx-gpt-6-astra": {
    id: "dxx-gpt-6-astra",
    label: "DXX · GPT-6 Astra",
    model: "gpt-6-astra",
    requiresApiKey: true,
    providerId: "amo-dxx",
    baseUrl: "https://gorilla-api.dxxapi.com",
    envKey: "DXX_API_KEY",
    modelCatalogFile: "dxx.models.json",
  },
  "deepseek-v4-pro": {
    id: "deepseek-v4-pro",
    label: "DeepSeek Flash",
    model: "deepseek-flash",
    subagentModel: "deepseek-flash",
    reviewModel: "deepseek-flash",
    requiresApiKey: true,
    providerId: "amo-deepseek",
    baseUrl: "https://api.deepseek.com/",
    environment: {
      DEEPSEEK_API_KEY: null,
    },
  },
  "deepseek-v4": {
    id: "deepseek-v4",
    label: "DeepSeek Flash",
    model: "deepseek-flash",
    subagentModel: "deepseek-flash",
    reviewModel: "deepseek-flash",
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
    envKey: preset.envKey || "DEEPSEEK_API_KEY",
    modelCatalogFile: preset.modelCatalogFile,
    subagentModel: preset.subagentModel,
    reviewModel: preset.reviewModel,
    reasoningEffort: preset.reasoningEffort,
    environment: preset.requiresApiKey
      ? { [preset.envKey || "DEEPSEEK_API_KEY"]: apiKey }
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
