import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root: fileURLToPath(new URL("../..", import.meta.url)),
  optimizeDeps: { noDiscovery: true },
  server: { hmr: false, middlewareMode: true },
});
const {
  CLAUDE_PROVIDER_DEFINITIONS,
  CODEX_PROVIDER_DEFINITIONS,
  GROK_PROVIDER_DEFINITIONS,
  modelCredentialProviderId,
  isCodexProviderPresetId,
  loadDefaultCodexProvider,
  saveDefaultCodexProvider,
  normalizeClaudeProviderPresetId,
  DEEPSEEK_DEFAULT_PRESET_ID,
  loadDefaultClaudeProvider,
  saveDefaultClaudeProvider,
} = await vite.ssrLoadModule("/src/native/modelProviders.ts");
const { workspaceLaunchRoutes, workspaceLaunchModelLabel } = await vite.ssrLoadModule("/src/domain/workspaceLaunchRoutes.ts");

after(async () => {
  await vite.close();
});

test("DeepSeek legacy preset IDs remain accepted", () => {
  assert.deepEqual(
    CODEX_PROVIDER_DEFINITIONS.filter(provider => !provider.id.startsWith("deepseek-profile-")).map((provider) => provider.id),
    ["openai-default", "dxx", "dxx-gpt-6-astra", "deepseek-v4-pro", "deepseek-v4"],
  );
  assert.deepEqual(
    CLAUDE_PROVIDER_DEFINITIONS.filter(provider => !provider.id.startsWith("deepseek-profile-")).map((provider) => provider.id),
    ["anthropic-default", "deepseek-v4-pro", "deepseek-v4", "glm-5.3"],
  );
});

test("DeepSeek V4 Pro and Flash share the existing secure credential", () => {
  assert.equal(modelCredentialProviderId("deepseek-v4-pro"), "deepseek-v4");
  assert.equal(modelCredentialProviderId("deepseek-v4"), "deepseek-v4");
  assert.equal(modelCredentialProviderId("glm-5.3"), "glm-coding");
  assert.equal(modelCredentialProviderId("glm-5.2"), "glm-coding");
  assert.equal(modelCredentialProviderId("openai-default"), null);
  assert.equal(modelCredentialProviderId("dxx"), "dxx");
  assert.equal(CODEX_PROVIDER_DEFINITIONS.find(p => p.id === "dxx").model, "gpt-5.6-sol");
});

test("workspace routes group models without changing launch and resume preset IDs", () => {
  const routes = workspaceLaunchRoutes("codex-cli");
  assert.equal(routes.find(route => route.id === "dxx").title, "GPT-Dxx");
  assert.deepEqual(routes.find(route => route.id === "dxx").models.map(model => model.id), ["dxx", "dxx-gpt-6-astra"]);
  assert.deepEqual(routes.flatMap(route => route.models.map(model => model.id)), CODEX_PROVIDER_DEFINITIONS.filter(model => !model.hidden).map(model => model.id));
  assert.deepEqual(workspaceLaunchRoutes("claude-cli").flatMap(route => route.models.map(model => model.id)), CLAUDE_PROVIDER_DEFINITIONS.filter(model => !model.hidden).map(model => model.id));
  const deepseek = routes.find(route => route.id === "deepseek-v4");
  assert.equal(deepseek.models.length, 1);
  assert.equal(deepseek.models[0].id, DEEPSEEK_DEFAULT_PRESET_ID);
  for (const model of deepseek.models) {
    assert.equal(modelCredentialProviderId(model.id), "deepseek-v4");
    assert.equal(isCodexProviderPresetId(model.id), true);
  }
  assert.equal(workspaceLaunchRoutes("grok-build").length, 1);
  assert.equal(workspaceLaunchModelLabel("gpt-6-astra"), "GPT-6 Astra");
  assert.equal(workspaceLaunchModelLabel("Local Codex configuration"), "沿用本机配置");
});

test("DXX Sol and Astra share credentials and remain valid saved launch/resume presets", t => {
  const storage = new Map();
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  });
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else delete globalThis.localStorage;
  });
  storage.set("amo.models.defaultCodexProvider", "dxx");
  assert.equal(loadDefaultCodexProvider(), "dxx-gpt-6-astra");
  assert.equal(storage.get("amo.models.defaultCodexProvider"), "dxx-gpt-6-astra");
  saveDefaultCodexProvider("deepseek-v4");
  saveDefaultClaudeProvider("deepseek-v4-pro");
  assert.equal(loadDefaultCodexProvider(), DEEPSEEK_DEFAULT_PRESET_ID);
  assert.equal(loadDefaultClaudeProvider(), DEEPSEEK_DEFAULT_PRESET_ID);
  const activeMixed = "deepseek-profile-v41-flash-pro-flash";
  saveDefaultCodexProvider(activeMixed);
  assert.equal(loadDefaultCodexProvider(), DEEPSEEK_DEFAULT_PRESET_ID);
  for (const [presetId, model] of [["dxx", "gpt-5.6-sol"], ["dxx-gpt-6-astra", "gpt-6-astra"]]) {
    assert.equal(isCodexProviderPresetId(presetId), true);
    assert.equal(modelCredentialProviderId(presetId), "dxx");
    assert.equal(CODEX_PROVIDER_DEFINITIONS.find(p => p.id === presetId).model, model);
    saveDefaultCodexProvider(presetId);
    assert.equal(loadDefaultCodexProvider(), presetId);
  }
});

test("legacy GLM-5.2 defaults migrate to GLM-5.3", () => {
  assert.equal(normalizeClaudeProviderPresetId("glm-5.2"), "glm-5.3");
  assert.equal(normalizeClaudeProviderPresetId("glm-5.3"), "glm-5.3");
});

test("DeepSeek V4 Pro legacy preset exposes deepseek-flash in both clients", () => {
  const codex = CODEX_PROVIDER_DEFINITIONS.find((provider) => provider.id === "deepseek-v4-pro");
  const claude = CLAUDE_PROVIDER_DEFINITIONS.find((provider) => provider.id === "deepseek-v4-pro");
  assert.equal(codex.model, "deepseek-flash");
  assert.equal(claude.model, "deepseek-flash");
});

test("Grok Build exposes only the local Grok Default route", () => {
  assert.deepEqual(GROK_PROVIDER_DEFINITIONS, [
    {
      id: "grok-default",
      title: "Grok Default",
      detail: "Use the existing local Grok Build account, model, and configuration.",
      model: "Local Grok Build configuration",
    },
  ]);
});
