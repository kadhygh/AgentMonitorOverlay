const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const manifest = require("../assets/deepseek/profiles.json");
const releases = require("../assets/deepseek/releases.json");
const template = require("../assets/codex/deepseek-v4-flash.models.json");
const { resolveCodexProvider } = require("./codex-provider");
const { resolveClaudeProvider } = require("./claude-provider");
const { createCodexLaunchArgs } = require("./codex-launch-config");
const { generate, nextConfig, parseArgs } = require("../../scripts/models/deepseek-routing.cjs");

test("historical 0910 preset routes every Claude slot and Codex default to current Flash", () => {
  const id = "deepseek-profile-v41-flash-0910-flash-all";
  const model = "deepseek-flash";
  const profile = manifest.profiles.find(item => item.id === id);
  assert.equal(profile.mode, "flash-all");
  assert.equal(profile.mainModel, model);
  const claude = resolveClaudeProvider({ presetId: id, apiKey: "fixture-key" });
  for (const key of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) {
    assert.equal(claude.environment[key], model, key);
  }
  assert.equal(claude.environment.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  const codex = resolveCodexProvider({ presetId: id, apiKey: "fixture-key" });
  const args = createCodexLaunchArgs({ provider: codex });
  for (const key of ["model", "review_model", "agents.default_subagent_model"]) assert.ok(args.includes(`${key}="${model}"`), key);
  assert.ok(args.includes('model_providers.amo-deepseek.base_url="https://api.deepseek.com/"'));
  assert.deepEqual(codex.environment, { DEEPSEEK_API_KEY: "fixture-key" });
  assert.ok(!args.join(" ").includes("fixture-key"));
  const catalog = require(`../assets/codex/${profile.modelCatalogFile}`);
  assert.deepEqual(catalog.models.map(item => item.slug), [model]);
  assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
});

test("legacy pro-flash routes main, review and child tasks to Flash", () => {
  const profile = manifest.profiles.find(item => item.releaseId === manifest.activeRelease && item.mode === "pro-flash");
  const codex = resolveCodexProvider({ presetId: profile.id, apiKey: "fixture-key" });
  const args = createCodexLaunchArgs({ provider: codex });
  assert.ok(args.includes(`model="${profile.mainModel}"`));
  assert.ok(args.includes(`review_model="${profile.mainModel}"`));
  assert.ok(args.includes(`agents.default_subagent_model="${profile.subagentModel}"`));
  const claude = resolveClaudeProvider({ presetId: profile.id, apiKey: "fixture-key" });
  for (const key of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL"]) assert.equal(claude.environment[key], profile.claudeModel);
  assert.equal(claude.environment.CLAUDE_CODE_SUBAGENT_MODEL, profile.subagentModel);
  assert.equal(claude.environment.ANTHROPIC_DEFAULT_HAIKU_MODEL, profile.subagentModel);
});

test("every retained profile resolves in both providers, validates its catalog, and requires a key", () => {
  for (const profile of manifest.profiles) {
    assert.equal(profile.mainModel, "deepseek-flash");
    assert.equal(profile.subagentModel, "deepseek-flash");
    assert.equal(profile.reviewModel, "deepseek-flash");
    assert.equal(profile.claudeModel, "deepseek-flash");
    assert.equal(resolveCodexProvider({ presetId: profile.id, apiKey: "fixture" }).model, profile.mainModel);
    assert.equal(resolveClaudeProvider({ presetId: profile.id, apiKey: "fixture" }).model, profile.claudeModel);
    createCodexLaunchArgs({ provider: resolveCodexProvider({ presetId: profile.id, apiKey: "fixture" }) });
    assert.throws(() => resolveCodexProvider({ presetId: profile.id }), error => error.code === "codex_provider_api_key_required");
    assert.throws(() => resolveClaudeProvider({ presetId: profile.id }), error => error.code === "claude_provider_api_key_required");
  }
});

test("generator matches committed outputs and retains immutable historical releases on updates", () => {
  for (const [file, content] of generate(releases, template)) assert.equal(fs.readFileSync(path.resolve(__dirname, "../..", file), "utf8").replace(/\r\n/g, "\n"), content, file);
  const next = nextConfig(releases, { release: "fixture-next", flash: "deepseek-fixture-flash", label: "Fixture", mode: "pro-flash" });
  assert.deepEqual(next.releases.slice(0, releases.releases.length), releases.releases);
  assert.equal(next.defaultMode, "pro-flash");
  const originalProfiles = JSON.parse(generate(releases, template).get("broker/assets/deepseek/profiles.json")).profiles;
  const nextProfiles = JSON.parse(generate(next, template).get("broker/assets/deepseek/profiles.json")).profiles;
  assert.deepEqual(nextProfiles.slice(0, originalProfiles.length), originalProfiles);
  assert.throws(() => nextConfig(releases, { release: releases.activeRelease, flash: "deepseek-other" }), /immutable/);
});

test("rollback and preview/check options do not mutate the input configuration", () => {
  const before = JSON.stringify(releases);
  const rolledBack = nextConfig(releases, { release: "v4", mode: "flash-all" });
  assert.equal(rolledBack.activeRelease, "v4");
  assert.equal(JSON.stringify(releases), before);
  assert.deepEqual(parseArgs(["--mode", "flash-all"]), { mode: "flash-all" });
  assert.throws(() => parseArgs(["--check", "--apply"]));
  assert.throws(() => parseArgs(["--flash"]));
  assert.throws(() => nextConfig(releases, { release: "../outside", flash: "deepseek-flash", label: "bad" }));
});
