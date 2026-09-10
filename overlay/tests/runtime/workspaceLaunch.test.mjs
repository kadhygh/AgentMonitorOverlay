import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  appType: "custom", configFile: false,
  root: fileURLToPath(new URL("../..", import.meta.url)),
  optimizeDeps: { noDiscovery: true }, server: { hmr: false, middlewareMode: true, ws: false },
});
const { launchWorkspaceTool } = await vite.ssrLoadModule("/src/api/workspaceLaunch.ts");
const { CODEX_PROVIDER_DEFINITIONS } = await vite.ssrLoadModule("/src/native/modelProviders.ts");
after(() => vite.close());

const workspacePath = "G:/PROJECT/game";
const inspection = { workspacePath, supportedAdapters: ["codex-cli", "claude-cli", "grok-build"].map(id => ({ id, deploymentStatus: "deployed" })) };
const request = { workspacePath, inspection, launchMode: "managed", selection: { adapterId: "codex-cli", codexProvider: { presetId: "dxx-gpt-6-astra" } } };
function fixture(overrides = {}) {
  const calls = { posts: [], credentials: [], uris: [], remembered: [] };
  const deps = {
    resolveCredential: async id => { calls.credentials.push(id); return "fixture-secret"; },
    launchPreference: () => ({ launchEnvironment: "alacritty-powershell7" }),
    postLaunch: async payload => { calls.posts.push(payload); return { ok: true, workspacePath, message: "started", uri: "chatgpt://fixture" }; },
    openUri: async uri => { calls.uris.push(uri); return { ok: true }; },
    rememberPath: path => calls.remembered.push(path),
    ...overrides,
  };
  return { calls, deps };
}

for (const presetId of ["dxx", "dxx-gpt-6-astra", "deepseek-v4-pro", "deepseek-v4", ...CODEX_PROVIDER_DEFINITIONS.filter(model => model.id.startsWith("deepseek-profile-")).map(model => model.id)]) {
  test(`center and card use identical launch settings for ${presetId}`, async () => {
    const center = fixture(), card = fixture();
    const input = { ...request, selection: { adapterId: "codex-cli", codexProvider: { presetId } } };
    await launchWorkspaceTool(input, center.deps);
    await launchWorkspaceTool({ ...input, sourceCardSessionId: "game-task" }, card.deps);
    const { sourceCardSessionId, ...cardPayload } = card.calls.posts[0];
    assert.equal(sourceCardSessionId, "game-task");
    assert.deepEqual(cardPayload, center.calls.posts[0]);
    assert.equal(cardPayload.codexProvider.presetId, presetId);
    assert.equal(cardPayload.launchEnvironment, "alacritty-powershell7");
    assert.deepEqual(center.calls.credentials, [presetId.startsWith("dxx") ? "dxx" : "deepseek-v4"]);
  });
}

test("one-launch key overrides stored key and irrelevant client credentials are discarded", async () => {
  const { calls, deps } = fixture();
  await launchWorkspaceTool({ ...request, selection: {
    adapterId: "claude-cli", claudeProvider: { presetId: "glm-5.3", apiKey: "  override-key  " },
    codexProvider: { presetId: "dxx", apiKey: "wrong-client-secret" },
  } }, deps);
  assert.deepEqual(calls.credentials, []);
  assert.deepEqual(calls.posts[0].claudeProvider, { presetId: "glm-5.3", apiKey: "override-key" });
  assert.equal(calls.posts[0].codexProvider, undefined);
});

test("official and Grok launches do not resolve or forward API keys", async () => {
  for (const adapterId of ["codex-cli", "claude-cli", "grok-build"]) {
    const { calls, deps } = fixture();
    await launchWorkspaceTool({ ...request, selection: { adapterId,
      codexProvider: { presetId: "openai-default", apiKey: "unused" },
      claudeProvider: { presetId: "anthropic-default", apiKey: "unused" },
    } }, deps);
    assert.deepEqual(calls.credentials, []);
    assert.ok(!JSON.stringify(calls.posts[0]).includes("unused"));
  }
});

test("ordinary CLI needs no enrollment and does not attach a managed source card", async () => {
  const { calls, deps } = fixture();
  await launchWorkspaceTool({ ...request, inspection: null, launchMode: "cli-only", sourceCardSessionId: "game-task" }, deps);
  assert.equal(calls.posts[0].launchMode, "cli-only");
  assert.equal(calls.posts[0].sourceCardSessionId, undefined);
  assert.deepEqual(calls.remembered, [workspacePath]);
});

test("invalid managed context and preset fail before accessing credentials or submitting", async () => {
  const invalid = [
    { workspacePath: " " }, { inspection: null },
    { inspection: { ...inspection, workspacePath: "G:/PROJECT/different" } },
    { inspection: { ...inspection, supportedAdapters: [] } },
    { selection: { adapterId: "codex-cli", codexProvider: { presetId: "invalid" } } },
    { launchMode: "cli-only", selection: { adapterId: "codex-app" } },
  ];
  for (const extra of invalid) {
    const { calls, deps } = fixture();
    await assert.rejects(launchWorkspaceTool({ ...request, ...extra }, deps));
    assert.deepEqual(calls.credentials, []);
    assert.deepEqual(calls.posts, []);
  }
});

test("credential failures never submit and backend failures remain retryable", async () => {
  const unavailable = fixture({ resolveCredential: async () => { throw new Error("credential unavailable"); } });
  await assert.rejects(launchWorkspaceTool(request, unavailable.deps), /credential unavailable/);
  assert.deepEqual(unavailable.calls.posts, []);
  const empty = fixture({ resolveCredential: async () => "" });
  await assert.rejects(launchWorkspaceTool(request, empty.deps), /缺少 API Key/);
  assert.deepEqual(empty.calls.posts, []);
  const failure = fixture({ postLaunch: async () => { throw new Error("terminal unavailable"); } });
  await assert.rejects(launchWorkspaceTool(request, failure.deps), /terminal unavailable/);
  const retry = fixture();
  await launchWorkspaceTool(request, retry.deps);
  assert.equal(retry.calls.posts.length, 1);
});

test("ChatGPT URI handling is shared and reports native opening failures", async () => {
  const { calls, deps } = fixture();
  await launchWorkspaceTool({ ...request, selection: { adapterId: "codex-app" } }, deps);
  assert.deepEqual(calls.uris, ["chatgpt://fixture"]);
  assert.deepEqual(calls.credentials, []);
  const missing = fixture({ postLaunch: async () => ({ ok: true }) });
  await assert.rejects(launchWorkspaceTool({ ...request, selection: { adapterId: "codex-app" } }, missing.deps), /URI/);
  const failed = fixture({ openUri: async () => ({ ok: false, message: "native open failed" }) });
  await assert.rejects(launchWorkspaceTool({ ...request, selection: { adapterId: "codex-app" } }, failed.deps), /native open failed/);
});
