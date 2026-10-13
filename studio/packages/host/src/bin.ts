import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HostAlreadyRunningError, startHost, type StartHostOptions } from "./host-process.js";
import { StaticCredentialReader } from "./runtime/credentials.js";
import { RecordingTerminalLauncher } from "./terminal/launcher.js";

// Command-line entry: `node packages/host/dist/bin.js`. The Electron shell starts it the same way (S1-08).
// Env: AMO_STUDIO_DATA_DIR (default studio/.data), AMO_STUDIO_PORT (default 47900), AMO_STUDIO_UI_DIR,
// AMO_STUDIO_DEV_ORIGIN (allowed CORS origin for the Vite dev server).
// Test-only: AMO_STUDIO_TEST_PROVIDER_URL (+ AMO_STUDIO_TEST_CATALOG, AMO_STUDIO_TEST_CODEX_HOME) replaces every model
// profile with one mock profile, so end-to-end tests never reach a real model or the user's Codex home;
// AMO_STUDIO_TEST_CLAUDE_URL adds a Claude profile routed to the mock Anthropic API.

const studioRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const dataDir = process.env.AMO_STUDIO_DATA_DIR ?? join(studioRoot, ".data");

// Asking Claude Code for its models against the mock API only times out, so the mock profiles list their own.
const MOCK_CLAUDE_MODELS = ["mock-claude", "mock-claude-b"].map((id) => ({ id, label: id, efforts: ["low", "medium", "high", "xhigh", "max"], ...(id === "mock-claude" ? { isDefault: true } : {}) }));

function testModelOptions(): Partial<StartHostOptions> {
  const url = process.env.AMO_STUDIO_TEST_PROVIDER_URL;
  if (!url) return {};
  const claudeUrl = process.env.AMO_STUDIO_TEST_CLAUDE_URL;
  return {
    profiles: [
      { id: "codex-mock", label: "Mock 模型", runtime: "codex", provider: "amo-mock", model: "mock-model", credentialId: "mock" },
      ...(claudeUrl
        ? [
            { id: "claude-mock", label: "Mock Claude", runtime: "claude" as const, provider: "mock", model: "mock-claude", credentialId: "mock" },
            // Like the Claude subscription: a token saved in 设置 → 模型凭据 (kept in memory here), sent to the mock.
            { id: "claude-subscription", label: "Claude 订阅", runtime: "claude" as const, provider: "mock-oauth", model: "mock-claude", credentialId: "claude-subscription" },
          ]
        : []),
    ],
    ...(claudeUrl ? { claudeProviders: { mock: { baseUrl: claudeUrl, models: MOCK_CLAUDE_MODELS }, "mock-oauth": { baseUrl: claudeUrl, auth: "oauth" as const, models: MOCK_CLAUDE_MODELS } } } : {}),
    providers: {
      "amo-mock": {
        name: "Mock",
        baseUrl: url,
        wireApi: "responses",
        envKey: "AMO_MOCK_API_KEY",
        ...(process.env.AMO_STUDIO_TEST_CATALOG ? { catalog: process.env.AMO_STUDIO_TEST_CATALOG } : {}),
      },
    },
    credentials: new StaticCredentialReader({ mock: "mock-key" }),
    ...(process.env.AMO_STUDIO_TEST_CODEX_HOME ? { codexEnv: { CODEX_HOME: process.env.AMO_STUDIO_TEST_CODEX_HOME } } : {}),
  };
}

try {
  const host = await startHost({
    dataDir,
    ...(process.env.AMO_STUDIO_PORT ? { port: Number(process.env.AMO_STUDIO_PORT) } : {}),
    ...(process.env.AMO_STUDIO_UI_DIR ? { uiDir: process.env.AMO_STUDIO_UI_DIR } : {}),
    ...(process.env.AMO_STUDIO_DEV_ORIGIN ? { allowedOrigins: [process.env.AMO_STUDIO_DEV_ORIGIN] } : {}),
    ...testModelOptions(),
    // Test runs never open terminal windows (LOOP_RULES red line 7); launches are only recorded.
    ...(process.env.AMO_STUDIO_TEST === "1" ? { launcher: new RecordingTerminalLauncher() } : {}),
  });
  console.log(`AMO Studio Host listening on ${host.info.url} (data: ${dataDir})`);
  const stop = (keepServers: boolean) => {
    void host.shutdown({ keepServers }).then(() => process.exit(0));
  };
  process.on("SIGINT", () => stop(false));
  process.on("SIGTERM", () => stop(false));
  // Over an IPC channel the shell can ask for a plain shutdown or a restart that keeps app-servers (and sessions) alive.
  process.on("message", (msg) => {
    if (msg === "shutdown") stop(false);
    if (msg === "restart") stop(true);
  });
} catch (err) {
  if (err instanceof HostAlreadyRunningError) {
    console.error(err.message);
    process.exit(3);
  }
  console.error(err);
  process.exit(1);
}
