import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HostAlreadyRunningError, startHost, type StartHostOptions } from "./host-process.js";
import { StaticCredentialReader } from "./runtime/credentials.js";
import { resolveNode } from "./runtime/dsh/install.js";
import { RecordingTerminalLauncher } from "./terminal/launcher.js";
import { StoreTooNewError } from "./store/store.js";
import { HOST_START_FAILED, type HostStartFailedMessage } from "@amo-studio/protocol";

// Command-line entry: `node packages/host/dist/bin.js`. The Electron shell starts it the same way (S1-08).
// Env: AMO_STUDIO_DATA_DIR (default studio/.data), AMO_STUDIO_PORT (default 47900), AMO_STUDIO_UI_DIR,
// AMO_STUDIO_DEV_ORIGIN (allowed CORS origin for the Vite dev server).
// Test-only: AMO_STUDIO_TEST_PROVIDER_URL (+ AMO_STUDIO_TEST_CATALOG, AMO_STUDIO_TEST_CODEX_HOME) replaces every model
// profile with one mock profile, so end-to-end tests never reach a real model or the user's Codex home;
// AMO_STUDIO_TEST_CLAUDE_URL adds a Claude profile routed to the mock Anthropic API; AMO_STUDIO_TEST_DSH_AGENT (a
// script) adds a DSH profile whose sessions run that scripted ACP agent instead of a DSH clone.

const studioRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const dataDir = process.env.AMO_STUDIO_DATA_DIR ?? join(studioRoot, ".data");

// Asking Claude Code for its models against the mock API only times out, so the mock profiles list their own.
const MOCK_CLAUDE_MODELS = ["mock-claude", "mock-claude-b"].map((id) => ({ id, label: id, efforts: ["low", "medium", "high", "xhigh", "max"], ...(id === "mock-claude" ? { isDefault: true } : {}) }));

const OFFLINE = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };

function testModelOptions(): Partial<StartHostOptions> {
  const url = process.env.AMO_STUDIO_TEST_PROVIDER_URL;
  if (!url) return {};
  const claudeUrl = process.env.AMO_STUDIO_TEST_CLAUDE_URL;
  const dshAgent = process.env.AMO_STUDIO_TEST_DSH_AGENT;
  // Under Electron the Host's own executable is Electron: the agent runs on the system's Node, as DSH would.
  const node = dshAgent ? resolveNode() : null;
  return {
    profiles: [
      { id: "codex-mock", label: "Mock 模型", runtime: "codex", provider: "amo-mock", model: "mock-model", credentialId: "mock" },
      ...(claudeUrl
        ? [
            { id: "claude-mock", label: "Mock Claude", runtime: "claude" as const, provider: "mock", model: "mock-claude", credentialId: "mock" },
            // Like the Claude subscription: a token saved in 设置 → 模型凭据 (kept in memory here), sent to the mock.
            { id: "claude-subscription", label: "Claude", runtime: "claude" as const, provider: "mock-oauth", model: "mock-claude", credentialId: "claude-subscription" },
          ]
        : []),
      ...(dshAgent ? [{ id: "dsh-mock", label: "Mock DSH", runtime: "dsh" as const, provider: "deepseek-official", model: null, credentialId: "mock" }] : []),
    ],
    ...(dshAgent && node ? { dshAgent: { command: node, args: [dshAgent] } } : {}),
    // Off the network (2026-10-27): Studio's real sessions fetch the CLI's feature flags; tests must not.
    ...(claudeUrl
      ? {
          claudeProviders: {
            mock: { baseUrl: claudeUrl, models: MOCK_CLAUDE_MODELS, env: OFFLINE },
            "mock-oauth": { baseUrl: claudeUrl, auth: "oauth" as const, models: MOCK_CLAUDE_MODELS, env: OFFLINE },
          },
        }
      : {}),
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

// Written to host.log by the shell (not a terminal): every line starts with the local time, so it can be matched with
// logs/resize-trace.log and the conversations (2026-10-15).
if (!process.stdout.isTTY) {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    let lineStart = true;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk !== "string") return write(chunk, ...rest);
      const stamp = `${new Date().toLocaleString("sv-SE")} `;
      const text = (lineStart ? stamp : "") + chunk.replace(/\n(?=.)/g, `\n${stamp}`);
      lineStart = chunk.endsWith("\n");
      return write(text, ...rest);
    }) as typeof stream.write;
  }
}

// A failure no request catches (a timer, a promise nobody awaited) would otherwise end the process, and every session
// with it. Log it with its stack, tell the windows, and keep serving.
let reportTo: ((err: unknown) => void) | null = null;
const survive = (what: string) => (err: unknown) => {
  console.error(`[${new Date().toISOString()}] ${what}; the Host keeps running:`, err);
  reportTo?.(err);
};
process.on("uncaughtException", survive("uncaught exception"));
process.on("unhandledRejection", survive("unhandled promise rejection"));

// Stalls of the Host's event loop: every window waits on it meanwhile (2026-10-21, "it has felt slow these ten minutes").
if (process.env.AMO_STUDIO_TEST !== "1") {
  const TICK = 100;
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const late = now - last - TICK;
    if (late >= 500) console.log(`Host stalled ${Math.round(late)}ms (event loop)`);
    last = now;
  }, TICK).unref();
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
    // 远程 (2026-10-29): the AMO platform's login and device in %APPDATA%\AMO (AMO_HOME moves it; e2e runs set it).
    remote: {},
  });
  console.log(`AMO Studio Host listening on ${host.info.url} (data: ${dataDir})`);
  reportTo = (err) => host.service.reportError(err);
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
  if (err instanceof StoreTooNewError) {
    console.error(err.message);
    // The shell shows this message as it is (host-link.ts), not only host.log; exit once it went out (2026-10-28).
    if (process.send) process.send({ type: HOST_START_FAILED, message: err.message } satisfies HostStartFailedMessage, () => process.exit(4));
    else process.exit(4);
  } else {
    console.error(err);
    process.exit(1);
  }
}
