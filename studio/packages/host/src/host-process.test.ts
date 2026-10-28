import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, Session, Task, TerminalAttach, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { HostAlreadyRunningError, hostPaths, readHostInfo, startHost, type RunningHost, type StartHostOptions } from "./host-process.js";
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

async function boot(extra: Partial<StartHostOptions> = {}) {
  servers = new FakeServers(PROFILES);
  const host = await startHost({ dataDir, port: 0, profiles: PROFILES, servers: Object.assign(servers, { stopAll: () => servers.close() }), launcher, ...extra });
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
    expect(await health()).toEqual({ ok: true, pid: process.pid, running: 0, version: "dev" });
    const ws = await call<Workspace>(host, "POST", "/api/workspaces", { path: join(root, "ws") });
    const { session } = await call<{ task: Task; session: Session }>(host, "POST", "/api/tasks", { workspaceId: ws.id, firstSession: { profileId: "p-ds" } });
    expect(await health()).toEqual({ ok: true, pid: process.pid, running: 0, version: "dev" });
    // Counted as the board's 进行中 counts them (sessionMoving): running, or waiting for the person mid-turn.
    host.service.store.updateSession(session.id, { status: "running" });
    expect(await health()).toEqual({ ok: true, pid: process.pid, running: 1, version: "dev" });
    host.service.store.updateSession(session.id, { status: "awaiting-approval" });
    expect((await health()).running).toBe(1);
    host.service.store.updateSession(session.id, { status: "idle" });
    expect((await health()).running).toBe(0);
  });

  it("/api/health says the version of the Studio that started the Host (2026-10-29)", async () => {
    const host = await boot({ version: "0.9.4" });
    const res = await fetch(`${host.info.url}/api/health`);
    expect(await res.json()).toEqual({ ok: true, pid: process.pid, running: 0, version: "0.9.4" });
  });

  it("POST /api/shutdown needs the token, refuses while sessions are at work unless told to interrupt them, then stops the Host and marks why (2026-10-29)", async () => {
    let exited = 0;
    const host = await boot({ exit: () => exited++ });
    const shutdown = (body: unknown, token: string | null = host.token) =>
      fetch(`${host.info.url}/api/shutdown`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    // Never without the token (POST is never open), not even with nothing at work.
    expect((await shutdown({}, null)).status).toBe(401);
    expect((await shutdown({}, "wrong")).status).toBe(401);
    const ws = await call<Workspace>(host, "POST", "/api/workspaces", { path: join(root, "ws") });
    const { session } = await call<{ task: Task; session: Session }>(host, "POST", "/api/tasks", { workspaceId: ws.id, firstSession: { profileId: "p-ds" } });
    host.service.store.updateSession(session.id, { status: "running" });
    // A session at work: refused, with how many, and the Host goes on.
    const refused = await shutdown({});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, running: 1 });
    expect((await shutdown({ interrupt: "yes" })).status).toBe(409);
    await new Promise((r) => setTimeout(r, 200));
    expect(exited).toBe(0);
    expect(existsSync(hostPaths(dataDir).exit)).toBe(false);
    expect(((await (await fetch(`${host.info.url}/api/health`)).json()) as { ok: boolean }).ok).toBe(true);
    // Told to interrupt it: accepted, then the Host stops — the mark, host.json and the lock gone, exit called.
    const accepted = await shutdown({ interrupt: true });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, running: 1 });
    await expect.poll(() => exited, { timeout: 5000 }).toBe(1);
    expect(JSON.parse(readFileSync(hostPaths(dataDir).exit, "utf8"))).toMatchObject({ pid: process.pid, reason: "shutdown" });
    expect(readHostInfo(dataDir)).toBeNull();
    expect(existsSync(hostPaths(dataDir).lock)).toBe(false);
    await expect(fetch(`${host.info.url}/api/health`)).rejects.toThrow();
    running.splice(running.indexOf(host), 1);
    // The next Host clears the mark: it has not been asked to stop.
    await boot();
    expect(existsSync(hostPaths(dataDir).exit)).toBe(false);
  });

  it("POST /api/shutdown with nothing at work stops the Host without asking to interrupt (2026-10-29)", async () => {
    let exited = 0;
    const host = await boot({ exit: () => exited++ });
    expect(await call(host, "POST", "/api/shutdown", {})).toEqual({ ok: true, running: 0 });
    await expect.poll(() => exited, { timeout: 5000 }).toBe(1);
    expect(readHostInfo(dataDir)).toBeNull();
    running.splice(running.indexOf(host), 1);
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
