const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const {
  CODEX_MODEL_CATALOG_PATH,
  createCodexLaunchArgs,
} = require("./codex-launch-config");

const deepSeekProvider = {
  id: "deepseek-v4-pro",
  label: "DeepSeek V4 Pro",
  model: "deepseek-v4-pro",
  providerId: "amo-deepseek",
  baseUrl: "https://api.deepseek.com/",
};

test("shared Codex model catalog is shipped beside the Broker runtime", () => {
  assert.equal(path.isAbsolute(CODEX_MODEL_CATALOG_PATH), true);
  assert.equal(fs.existsSync(CODEX_MODEL_CATALOG_PATH), true);

  const catalog = JSON.parse(fs.readFileSync(CODEX_MODEL_CATALOG_PATH, "utf8"));
  assert.deepEqual(catalog.models.map((model) => model.slug), [
    "deepseek-v4-pro",
    "deepseek-v4-flash",
  ]);
  assert.equal(catalog.models[0].display_name, "DeepSeek-V4-Pro-0813");
  assert.equal(catalog.models[0].minimal_client_version, "0.144.0");
  assert.match(catalog.models[0].base_instructions, /agentic coding assistant/u);
});

test("one-launch Codex overrides route DeepSeek without storing the secret", () => {
  const args = createCodexLaunchArgs({ provider: deepSeekProvider });
  const serialized = args.join(" ");
  const portableCatalogPath = CODEX_MODEL_CATALOG_PATH.replace(/\\/gu, "/");

  assert.equal(args.filter((value) => value === "-c").length, 8);
  assert.match(serialized, /model="deepseek-v4-pro"/u);
  assert.match(serialized, /model_provider="amo-deepseek"/u);
  assert.equal(args.includes(`model_catalog_json=${JSON.stringify(portableCatalogPath)}`), true);
  assert.match(serialized, /model_providers\.amo-deepseek\.base_url="https:\/\/api\.deepseek\.com\/"/u);
  assert.match(serialized, /model_providers\.amo-deepseek\.wire_api="responses"/u);
  assert.match(serialized, /model_providers\.amo-deepseek\.env_key="DEEPSEEK_API_KEY"/u);
  assert.doesNotMatch(serialized, /--profile|config\.toml|deepseek-secret/u);
});

test("default Codex launch does not add model overrides", () => {
  assert.deepEqual(createCodexLaunchArgs({
    provider: { id: "openai-default", providerId: null },
  }), []);
});

test("missing or mismatched shared catalogs fail before spawning Codex", () => {
  assert.throws(
    () => createCodexLaunchArgs({ provider: deepSeekProvider, modelCatalogPath: "missing.models.json" }),
    /model catalog is unavailable/u,
  );
  assert.throws(
    () => createCodexLaunchArgs({
      provider: { ...deepSeekProvider, model: "not-in-catalog" },
    }),
    /does not contain not-in-catalog/u,
  );
});
