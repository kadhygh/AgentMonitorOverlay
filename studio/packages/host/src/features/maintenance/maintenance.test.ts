import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaintenanceInfo, MaintenanceTerminalResult, ModelProfile } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { CodexServerManager } from "../../runtime/codex/server-manager.js";
import { StaticCredentialReader } from "../../runtime/credentials.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { RecordingTerminalLauncher } from "../../terminal/launcher.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startHostServer, type HostServer } from "../../http/server.js";

// 设置 → 维护 (2026-10-20): how Studio was started, and a model's CLI in a terminal at the repo. Launches are recorded.

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });
const PROFILES: ModelProfile[] = [
  { id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model", credentialId: "ds" },
  { id: "p-hidden", label: "Hidden", runtime: "codex", provider: "amo-ds", model: "ds-model", hidden: true },
  { id: "p-dsh", label: "DSH", runtime: "dsh", provider: "deepseek-official", model: null },
];
const PROVIDERS = { "amo-ds": { name: "DS Flash", baseUrl: "https://ds.example/", wireApi: "responses" as const, envKey: "DS_API_KEY" } };
const TOKEN = "test-host-token";

/** FakeServers plus the TUI command, as the real manager builds it. */
class TerminalServers extends FakeServers {
  terminal(profileId: string) {
    return { command: `& 'codex' --profile ${profileId}`, env: { DS_API_KEY: "secret" } };
  }
}

let root: string;
let store: Store;
let servers: TerminalServers;
let launcher: RecordingTerminalLauncher;
let http: HostServer;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-maintenance-"));
  store = new Store(join(root, "studio.db"));
  servers = new TerminalServers(PROFILES);
  launcher = new RecordingTerminalLauncher();
  const service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { launcher });
  http = await startHostServer({ service, token: TOKEN, allowedOrigins: [] });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await http.close();
  await servers.close();
  store.close();
  removeTempDir(root);
});

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${http.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, data: (await res.json()) as T };
}

describe("maintenance", () => {
  it("tells this checkout apart from the portable build and lists the models with a CLI", async () => {
    const { status, data } = await api<MaintenanceInfo>("GET", "/api/maintenance");
    expect(status).toBe(200);
    expect(data.mode).toBe("source");
    expect(existsSync(join(data.source!.repoRoot, ".git"))).toBe(true);
    expect(existsSync(join(data.source!.repoRoot, "studio", "package.json"))).toBe(true);
    expect(data.source!.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(data.profiles).toEqual([{ profileId: "p-ds", label: "DS", runtime: "codex" }]);
  });

  it("opens the profile's CLI at the repo with its key in the environment only, and none of the Host's own", async () => {
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    vi.stubEnv("AMO_STUDIO_DATA_DIR", "D:\\data");
    const { status, data } = await api<MaintenanceTerminalResult>("POST", "/api/maintenance/terminal", { profileId: "p-ds" });
    expect(status).toBe(200);
    expect(launcher.launches).toHaveLength(1);
    const launch = launcher.launches[0]!;
    expect(launch).toMatchObject({ command: "& 'codex' --profile p-ds", cwd: data.cwd, envMode: "replace" });
    expect(existsSync(join(launch.cwd, ".git"))).toBe(true);
    expect(launch.env.DS_API_KEY).toBe("secret");
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(launch.env.AMO_STUDIO_DATA_DIR).toBeUndefined();
    expect(data.command).not.toContain("secret");
  });

  it("refuses a model without a CLI of its own here", async () => {
    expect((await api("POST", "/api/maintenance/terminal", { profileId: "p-dsh" })).status).toBe(400);
    expect((await api("POST", "/api/maintenance/terminal", {})).status).toBe(400);
    expect(launcher.launches).toHaveLength(0);
  });
});

describe("Codex TUI command", () => {
  it("passes the profile's provider in single-quoted TOML that Windows PowerShell keeps intact", () => {
    const manager = new CodexServerManager({
      dataDir: join(root, "servers"),
      profiles: PROFILES,
      credentials: new StaticCredentialReader({ ds: "ds-key" }),
      cwd: root,
      providers: PROVIDERS,
      codexCommand: { command: "C:\\Tools\\codex.exe", prefixArgs: [], env: { CODEX_MANAGED_BY_NPM: "1" }, source: "env" },
    });
    const { command, env } = manager.terminal("p-ds");
    expect(command.startsWith("& 'C:\\Tools\\codex.exe' '-c' ")).toBe(true);
    expect(command).toContain("'model_providers.amo-ds.name=''DS Flash'''");
    expect(command).toContain("'model_provider=''amo-ds'''");
    expect(command).not.toContain('"');
    expect(command).not.toContain("ds-key");
    expect(command).not.toContain("mcp_servers");
    expect(env).toMatchObject({ DS_API_KEY: "ds-key", CODEX_MANAGED_BY_NPM: "1" });
  });
});
