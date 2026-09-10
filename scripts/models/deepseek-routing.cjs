#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const MODES = ["flash-all", "pro-flash"];
const repoRoot = path.resolve(__dirname, "../..");
const configFile = "broker/assets/deepseek/releases.json";
const profileFile = "broker/assets/deepseek/profiles.json";
const templateFile = "broker/assets/codex/deepseek-v4-flash.models.json";
const serialize = value => `${JSON.stringify(value, null, 2)}\n`;

function validateConfig(config) {
  if (config.schemaVersion !== 1 || !MODES.includes(config.defaultMode) || !Array.isArray(config.releases)) throw new Error("Invalid DeepSeek release configuration");
  const ids = new Set();
  for (const release of config.releases) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(release.id) || ids.has(release.id)) throw new Error("Release IDs must be unique, lowercase path-safe slugs");
    ids.add(release.id);
    if (typeof release.label !== "string" || !release.label.trim()) throw new Error("Release label is required");
    for (const key of ["flashModel", "proModel", "claudeProModel"]) {
      if (!/^deepseek-[a-zA-Z0-9._-]+(?:\[1m\])?$/.test(release[key] || "")) throw new Error(`Invalid ${key} in ${release.id}`);
    }
    if (typeof release.vision !== "boolean") throw new Error("Release vision must be true or false");
  }
  if (!ids.has(config.activeRelease)) throw new Error("Active release is missing");
}

function generate(config, template) {
  validateConfig(config);
  const flashTemplate = template.models.find(model => model.slug === "deepseek-v4-flash");
  const proTemplate = template.models.find(model => model.slug === "deepseek-v4-pro");
  if (!flashTemplate || !proTemplate) throw new Error("Missing stable DeepSeek model templates");
  const files = new Map();
  const profiles = [];
  for (const release of config.releases) {
    for (const mode of MODES) {
      const id = `deepseek-profile-${release.id}-${mode}`;
      const mainModel = mode === "flash-all" ? release.flashModel : release.proModel;
      const claudeModel = mode === "flash-all" ? release.flashModel : release.claudeProModel;
      const optionLabel = `${mode === "flash-all" ? "Flash 全部" : "Pro 主任务 + Flash 子任务"} · ${release.label}`;
      const description = mode === "flash-all"
        ? `主任务、审阅和子任务全部使用 ${release.flashModel}。`
        : `主任务和审阅使用 ${release.proModel}；子任务和轻量槽位使用 ${release.flashModel}。`;
      const instructions = mode === "flash-all"
        ? `AMO DeepSeek routing mode: flash-all. Use ${release.flashModel} for all work, reviews, and every subagent. Do not select another model within this preset.`
        : `AMO DeepSeek routing mode: pro-flash. Use ${release.proModel} for main work and reviews. Use ${release.flashModel} for subagents and delegated lightweight work. Reasoning effort alone does not switch models.`;
      const models = [...new Set([mainModel, release.flashModel])].map((slug, index) => {
        const model = structuredClone(slug === release.flashModel ? flashTemplate : proTemplate);
        model.slug = slug;
        model.display_name = `${slug === release.flashModel ? "DeepSeek Flash" : "DeepSeek Pro"} · ${release.label}`;
        model.description = description;
        model.priority = index + 1;
        model.minimal_client_version = "0.153.4";
        model.input_modalities = slug === release.flashModel && release.vision ? ["text", "image"] : ["text"];
        model.auto_review_model_override = mainModel;
        model.base_instructions = `${model.base_instructions}\n\n${instructions}`;
        model.model_messages.instructions_template = `${model.model_messages.instructions_template}\n\n${instructions}`;
        return model;
      });
      const modelCatalogFile = `${id}.models.json`;
      files.set(`broker/assets/codex/${modelCatalogFile}`, serialize({ models }));
      profiles.push({
        id, releaseId: release.id, mode, label: `DeepSeek · ${optionLabel}`, optionLabel, description,
        mainModel, subagentModel: release.flashModel, reviewModel: mainModel,
        modelCatalogFile, claudeModel,
        claudeEnvironment: {
          ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
          ANTHROPIC_MODEL: claudeModel,
          ANTHROPIC_DEFAULT_OPUS_MODEL: claudeModel,
          ANTHROPIC_DEFAULT_SONNET_MODEL: claudeModel,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: release.flashModel,
          CLAUDE_CODE_SUBAGENT_MODEL: release.flashModel,
          CLAUDE_CODE_EFFORT_LEVEL: "max",
        },
      });
    }
  }
  files.set(profileFile, serialize({
    schemaVersion: 1, activeRelease: config.activeRelease, defaultMode: config.defaultMode,
    defaultPresetId: `deepseek-profile-${config.activeRelease}-${config.defaultMode}`, profiles,
  }));
  files.set(configFile, serialize(config));
  return files;
}

function nextConfig(current, args) {
  const config = structuredClone(current);
  const releaseId = args.release || config.activeRelease;
  const existing = config.releases.find(release => release.id === releaseId);
  if (existing) {
    for (const [option, field] of [["flash", "flashModel"], ["pro", "proModel"], ["claude-pro", "claudeProModel"], ["label", "label"]]) {
      if (args[option] !== undefined && args[option] !== existing[field]) throw new Error(`Release ${releaseId} is immutable. Use a new --release ID when changing ${field}.`);
    }
    if (args.vision !== undefined && args.vision !== String(existing.vision)) throw new Error("Use a new release ID when changing vision capability");
  } else {
    if (!args.flash || !args.label) throw new Error("New releases require --flash and --label");
    const baseline = config.releases.find(release => release.id === config.activeRelease);
    if (args.vision !== undefined && !["true", "false"].includes(args.vision)) throw new Error("--vision must be true or false");
    config.releases.push({
      id: releaseId, label: args.label, flashModel: args.flash,
      proModel: args.pro || baseline.proModel,
      claudeProModel: args["claude-pro"] || (args.pro ? args.pro : baseline.claudeProModel),
      vision: args.vision === "true",
    });
  }
  config.activeRelease = releaseId;
  config.defaultMode = args.mode || config.defaultMode;
  validateConfig(config);
  return config;
}

function parseArgs(argv) {
  const args = {};
  const flags = new Set(["apply", "check", "help"]);
  const values = new Set(["release", "flash", "pro", "claude-pro", "label", "mode", "vision"]);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "");
    if (!argv[i].startsWith("--") || (!flags.has(key) && !values.has(key))) throw new Error(`Unknown argument: ${argv[i]}`);
    if (Object.hasOwn(args, key)) throw new Error(`Duplicate argument: --${key}`);
    if (flags.has(key)) args[key] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Missing value for --${key}`);
      args[key] = argv[++i];
    }
  }
  if (args.check && (args.apply || Object.keys(args).some(key => values.has(key)))) throw new Error("--check cannot be combined with changes or --apply");
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("node scripts/models/deepseek-routing.cjs --release ID --flash MODEL --label LABEL --mode flash-all|pro-flash [--pro MODEL] [--claude-pro MODEL] [--vision true|false] [--apply]\nWithout --apply: preview only. --check: verify generated files. Existing release IDs are immutable. Switch --release and --mode to roll back.");
    return;
  }
  const read = file => JSON.parse(fs.readFileSync(path.join(repoRoot, file), "utf8"));
  const current = read(configFile);
  const config = args.check ? current : nextConfig(current, args);
  const files = generate(config, read(templateFile));
  const changes = [...files].filter(([file, content]) => !fs.existsSync(path.join(repoRoot, file)) || fs.readFileSync(path.join(repoRoot, file), "utf8").replace(/\r\n/g, "\n") !== content);
  if (args.check) {
    if (changes.length) throw new Error(`Generated DeepSeek files are stale: ${changes.map(([file]) => file).join(", ")}`);
    console.log("DeepSeek generated profiles and catalogs are current.");
    return;
  }
  const selected = JSON.parse(files.get(profileFile));
  console.log(JSON.stringify({ activeRelease: config.activeRelease, defaultMode: config.defaultMode, defaultPresetId: selected.defaultPresetId,
    profiles: selected.profiles.filter(profile => profile.releaseId === config.activeRelease).map(profile => ({ mode: profile.mode, main: profile.mainModel, subagent: profile.subagentModel })),
    changedFiles: changes.map(([file]) => file), apply: Boolean(args.apply) }, null, 2));
  if (!args.apply) return;
  for (const [file, content] of changes) {
    const target = path.join(repoRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { generate, nextConfig, parseArgs, validateConfig };
