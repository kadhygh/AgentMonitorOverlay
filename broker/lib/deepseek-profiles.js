const manifest = require("../assets/deepseek/profiles.json");

const codexProfiles = Object.fromEntries(manifest.profiles.map(profile => [profile.id, {
  id: profile.id,
  label: profile.label,
  model: profile.mainModel,
  subagentModel: profile.subagentModel,
  reviewModel: profile.reviewModel,
  reasoningEffort: "max",
  requiresApiKey: true,
  providerId: "amo-deepseek",
  baseUrl: "https://api.deepseek.com/",
  envKey: "DEEPSEEK_API_KEY",
  modelCatalogFile: profile.modelCatalogFile,
}]));

const claudeProfiles = Object.fromEntries(manifest.profiles.map(profile => [profile.id, {
  id: profile.id,
  label: profile.label,
  model: profile.claudeModel,
  requiresApiKey: true,
  environment: profile.claudeEnvironment,
}]));

module.exports = { codexProfiles, claudeProfiles };
