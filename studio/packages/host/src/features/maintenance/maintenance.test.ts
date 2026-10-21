import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaintenanceInfo, MaintenanceTerminalResult, ModelProfile } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { installedClaudeExe } from "../../runtime/claude/transcripts.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { RecordingTerminalLauncher } from "../../terminal/launcher.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { startHostServer, type HostServer } from "../../http/server.js";

// 设置 → 维护 (2026-10-20): how Studio was started, and the person's own claude in a terminal at the repo. Launches are
// recorded.

const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });
const PROFILES: ModelProfile[] = [
  { id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model", credentialId: "ds" },
  { id: "p-hidden", label: "Hidden", runtime: "codex", provider: "amo-ds", model: "ds-model", hidden: true },
  { id: "p-dsh", label: "DSH", runtime: "dsh", provider: "deepseek-official", model: null },
];
const TOKEN = "test-host-token";

let root: string;
let store: Store;
let servers: FakeServers;
let launcher: RecordingTerminalLauncher;
let http: HostServer;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-maintenance-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
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
  it("tells this checkout apart from the portable build and says which claude the terminal runs", async () => {
    const { status, data } = await api<MaintenanceInfo>("GET", "/api/maintenance");
    expect(status).toBe(200);
    expect(data.mode).toBe("source");
    expect(existsSync(join(data.source!.repoRoot, ".git"))).toBe(true);
    expect(existsSync(join(data.source!.repoRoot, "studio", "package.json"))).toBe(true);
    expect(data.source!.commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(data.claude).toMatch(/claude\.(exe|cmd)$/);
  });

  it("opens the person's own claude at the repo, as a terminal of their own: nothing of Studio's or of a Claude that started it", async () => {
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    vi.stubEnv("AMO_STUDIO_DATA_DIR", "D:\data");
    // What a Claude Code session leaves in the environment of a Studio it restarted (2026-10-21).
    vi.stubEnv("CLAUDECODE", "1");
    vi.stubEnv("CLAUDE_CODE_CHILD_SESSION", "1");
    vi.stubEnv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://elsewhere.example/");
    vi.stubEnv("AMO_TEST_KEPT", "kept");
    const { status, data } = await api<MaintenanceTerminalResult>("POST", "/api/maintenance/terminal");
    expect(status).toBe(200);
    expect(launcher.launches).toHaveLength(1);
    const launch = launcher.launches[0]!;
    expect(launch).toMatchObject({ command: data.command, cwd: data.cwd, envMode: "replace" });
    expect(data.command).toMatch(/^& '.*claude\.(exe|cmd)'$/);
    expect(existsSync(join(launch.cwd, ".git"))).toBe(true);
    expect(Object.keys(launch.env).filter((k) => /^(CLAUDE|ANTHROPIC_|ELECTRON_RUN_AS_NODE|AMO_STUDIO_)/i.test(k))).toEqual([]);
    expect(launch.env.AMO_TEST_KEPT).toBe("kept");
  });
});

describe("Claude CLI for the terminal", () => {
  it("takes the person's own claude from PATH, in PATH order, and nothing when there is none", () => {
    const empty = join(root, "empty");
    const npm = join(root, "npm");
    const native = join(root, "native");
    for (const d of [empty, npm, native]) mkdirSync(d);
    writeFileSync(join(npm, "claude.cmd"), "");
    writeFileSync(join(native, "claude.exe"), "");
    expect(installedClaudeExe({ PATH: [empty, native, npm].join(delimiter) })).toBe(join(native, "claude.exe"));
    expect(installedClaudeExe({ Path: [empty, npm, native].join(delimiter) })).toBe(join(npm, "claude.cmd"));
    expect(installedClaudeExe({ PATH: empty })).toBeNull();
  });
});
