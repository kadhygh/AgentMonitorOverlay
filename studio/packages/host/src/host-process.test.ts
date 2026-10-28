import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, Session, Task, TerminalAttach, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { HostAlreadyRunningError, hostPaths, readHostInfo, startHost, type RunningHost } from "./host-process.js";
import { FakeServers } from "./runtime/codex/fake-servers.test-support.js";
import { TERMINAL_TOKEN_ENV } from "./service.js";
import { MIGRATIONS } from "./store/migrations.js";
import { StoreTooNewError } from "./store/store.js";
import { RecordingTerminalLauncher } from "./terminal/launcher.js";

// Each test boots a fresh server, and the OS may hand out a port that a closed server just used. A pooled keep-alive
// socket to that old server would then fail ("fetch failed"), so test requests never reuse connections.
const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let dataDir: string;
let servers: FakeServers;
let launcher: RecordingTerminalLauncher;
const running: RunningHost[] = [];

async function boot() {
  servers = new FakeServers(PROFILES);
  const host = await startHost({ dataDir, port: 0, profiles: PROFILES, servers: Object.assign(servers, { stopAll: () => servers.close() }), launcher });
  running.push(host);
  return host;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-host-"));
  dataDir = join(root, "data");
  mkdirSync(join(root, "ws"));
  launcher = new RecordingTerminalLauncher();
});

afterEach(async () => {
  for (const h of running.splice(0)) await h.shutdown();
  removeTempDir(root);
});

async function call<T>(host: RunningHost, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${host.info.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json()) as T;
  if (res.status !== 200) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

describe("Host process", () => {
  it("writes host.json and a token, and refuses a second instance on the same data dir", async () => {
    const host = await boot();
    expect(readHostInfo(dataDir)).toMatchObject({ url: host.info.url, pid: process.pid });
    expect(readFileSync(hostPaths(dataDir).token, "utf8").trim()).toBe(host.token);
    // The lock belongs to this live process, so another start must fail rather than share the database.
    await expect(startHost({ dataDir, port: 0, profiles: PROFILES, servers: new FakeServers(PROFILES), launcher })).rejects.toBeInstanceOf(HostAlreadyRunningError);
  });

  it("releases the lock on shutdown and keeps the token across restarts", async () => {
    const first = await boot();
    const token = first.token;
    await first.shutdown();
    running.splice(running.indexOf(first), 1);
    expect(existsSync(hostPaths(dataDir).lock)).toBe(false);
    expect(readHostInfo(dataDir)).toBeNull();
    const second = await boot();
    expect(second.token).toBe(token);
  });

  it("does not start on data a newer Studio migrated, and leaves the data dir free (2026-10-28)", async () => {
    const first = await boot();
    first.service.store.db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(MIGRATIONS.length + 1, "2026-10-28T00:00:00.000Z");
    await first.shutdown();
    running.splice(running.indexOf(first), 1);
    await expect(startHost({ dataDir, port: 0, profiles: PROFILES, servers: new FakeServers(PROFILES), launcher })).rejects.toBeInstanceOf(StoreTooNewError);
    expect(existsSync(hostPaths(dataDir).lock)).toBe(false);
    expect(readHostInfo(dataDir)).toBeNull();
  });

  it("answers /api/health without the token, with the number of sessions at work and nothing else (2026-10-28)", async () => {
    const host = await boot();
    const health = async () => (await (await fetch(`${host.info.url}/api/health`)).json()) as Record<string, unknown>;
    expect(await health()).toEqual({ ok: true, pid: process.pid, running: 0 });
    const ws = await call<Workspace>(host, "POST", "/api/workspaces", { path: join(root, "ws") });
    const { session } = await call<{ task: Task; session: Session }>(host, "POST", "/api/tasks", { workspaceId: ws.id, firstSession: { profileId: "p-ds" } });
    expect(await health()).toEqual({ ok: true, pid: process.pid, running: 0 });
    // Counted as the board's 进行中 counts them (sessionMoving): running, or waiting for the person mid-turn.
    host.service.store.updateSession(session.id, { status: "running" });
    expect(await health()).toEqual({ ok: true, pid: process.pid, running: 1 });
    host.service.store.updateSession(session.id, { status: "awaiting-approval" });
    expect((await health()).running).toBe(1);
    host.service.store.updateSession(session.id, { status: "idle" });
    expect((await health()).running).toBe(0);
  });

  it("clears a stale lock left by a dead process", async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(hostPaths(dataDir).lock, "999999");
    const host = await boot();
    expect(readFileSync(hostPaths(dataDir).lock, "utf8")).toBe(String(process.pid));
    expect(host.info.pid).toBe(process.pid);
  });
});

describe("terminal attach", () => {
  async function session(host: RunningHost) {
    const ws = await call<Workspace>(host, "POST", "/api/workspaces", { path: join(root, "ws") });
    return call<{ task: Task; session: Session }>(host, "POST", "/api/tasks", {
      workspaceId: ws.id,
      firstSession: { profileId: "p-ds", text: "seed" },
    });
  }

  it("returns the remote command without the token and launches only on request", async () => {
    const host = await boot();
    const { session: s } = await session(host);
    const dry = await call<TerminalAttach>(host, "POST", `/api/sessions/${s.id}/terminal`, { launch: false });
    const fake = servers.fakes.get("p-ds")!;
    expect(dry).toEqual({
      command: `codex --remote ${fake.url} --remote-auth-token-env ${TERMINAL_TOKEN_ENV} resume ${s.runtimeRef}`,
      envVar: TERMINAL_TOKEN_ENV,
      launched: false,
    });
    expect(dry.command).not.toContain(fake.token);
    expect(launcher.launches).toHaveLength(0);

    const launched = await call<TerminalAttach>(host, "POST", `/api/sessions/${s.id}/terminal`, { launch: true });
    expect(launched.launched).toBe(true);
    expect(launcher.launches).toHaveLength(1);
    expect(launcher.launches[0]).toMatchObject({ command: dry.command, cwd: join(root, "ws"), env: { [TERMINAL_TOKEN_ENV]: fake.token } });
    expect(host.service.store.getSession(s.id)!.writer).toBe("terminal-shared");

    // Codex sharing keeps the workbench writable; reclaim just records that the terminal is gone.
    expect(await call(host, "POST", `/api/sessions/${s.id}/messages`, { text: "still writable" })).toMatchObject({ mode: expect.any(String) });
    expect((await call<Session>(host, "POST", `/api/sessions/${s.id}/reclaim`)).writer).toBe("workbench");
  });

  it("refuses to attach an archived session", async () => {
    const host = await boot();
    const { session: s } = await session(host);
    await call(host, "POST", `/api/sessions/${s.id}/archive`);
    const res = await fetch(`${host.info.url}/api/sessions/${s.id}/terminal`, {
      method: "POST",
      headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ launch: true }),
    });
    expect(res.status).toBe(409);
    expect(launcher.launches).toHaveLength(0);
  });
});
