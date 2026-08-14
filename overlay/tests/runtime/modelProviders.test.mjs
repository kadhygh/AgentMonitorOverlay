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
  modelCredentialProviderId,
  normalizeClaudeProviderPresetId,
} = await vite.ssrLoadModule("/src/native/modelProviders.ts");

after(async () => {
  await vite.close();
});

test("DeepSeek V4 Pro appears above the retained Flash preset", () => {
  assert.deepEqual(
    CODEX_PROVIDER_DEFINITIONS.map((provider) => provider.id),
    ["openai-default", "deepseek-v4-pro", "deepseek-v4"],
  );
  assert.deepEqual(
    CLAUDE_PROVIDER_DEFINITIONS.map((provider) => provider.id),
    ["anthropic-default", "deepseek-v4-pro", "deepseek-v4", "glm-5.3"],
  );
});

test("DeepSeek V4 Pro and Flash share the existing secure credential", () => {
  assert.equal(modelCredentialProviderId("deepseek-v4-pro"), "deepseek-v4");
  assert.equal(modelCredentialProviderId("deepseek-v4"), "deepseek-v4");
  assert.equal(modelCredentialProviderId("glm-5.3"), "glm-coding");
  assert.equal(modelCredentialProviderId("glm-5.2"), "glm-coding");
  assert.equal(modelCredentialProviderId("openai-default"), null);
});

test("legacy GLM-5.2 defaults migrate to GLM-5.3", () => {
  assert.equal(normalizeClaudeProviderPresetId("glm-5.2"), "glm-5.3");
  assert.equal(normalizeClaudeProviderPresetId("glm-5.3"), "glm-5.3");
});

test("DeepSeek V4 Pro exposes the official client-specific model names", () => {
  const codex = CODEX_PROVIDER_DEFINITIONS.find((provider) => provider.id === "deepseek-v4-pro");
  const claude = CLAUDE_PROVIDER_DEFINITIONS.find((provider) => provider.id === "deepseek-v4-pro");
  assert.equal(codex.model, "deepseek-v4-pro");
  assert.equal(claude.model, "deepseek-v4-pro[1m]");
});
