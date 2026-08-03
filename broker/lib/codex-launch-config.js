const fs = require("fs");
const path = require("path");

const CODEX_MODEL_CATALOG_PATH = path.resolve(
  __dirname,
  "..",
  "assets",
  "codex",
  "deepseek-v4-flash.models.json",
);

function createCodexLaunchArgs({ provider, modelCatalogPath = CODEX_MODEL_CATALOG_PATH } = {}) {
  if (!provider?.providerId || provider.id === "openai-default") return [];

  const providerId = validateProviderId(provider.providerId);
  const resolvedCatalogPath = path.resolve(modelCatalogPath);
  validateModelCatalog(resolvedCatalogPath, provider.model);
  const providerKey = `model_providers.${providerId}`;

  return [
    "-c", `model=${tomlString(provider.model)}`,
    "-c", `model_provider=${tomlString(providerId)}`,
    "-c", 'model_reasoning_effort="high"',
    "-c", `model_catalog_json=${tomlString(toPortablePath(resolvedCatalogPath))}`,
    "-c", `${providerKey}.name=${tomlString(provider.label)}`,
    "-c", `${providerKey}.base_url=${tomlString(provider.baseUrl)}`,
    "-c", `${providerKey}.wire_api="responses"`,
    "-c", `${providerKey}.env_key="DEEPSEEK_API_KEY"`,
  ];
}

function validateModelCatalog(filePath, expectedModel) {
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`AMO Codex model catalog is unavailable at ${filePath}: ${error.message || error}`);
  }

  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  if (!models.some((model) => model?.slug === expectedModel)) {
    throw new Error(`AMO Codex model catalog does not contain ${expectedModel}`);
  }
}

function validateProviderId(value) {
  const providerId = String(value || "").trim();
  if (!providerId || !/^[A-Za-z0-9_-]+$/u.test(providerId)) {
    throw new Error("Codex provider ID is invalid");
  }
  return providerId;
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function toPortablePath(value) {
  return String(value).replace(/\\/gu, "/");
}

module.exports = {
  CODEX_MODEL_CATALOG_PATH,
  createCodexLaunchArgs,
};
