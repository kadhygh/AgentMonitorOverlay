import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect as tcpConnect, createServer } from "node:net";
import { join } from "node:path";
import type { ModelProfile } from "@amo-studio/protocol";
import type { CredentialReader } from "../credentials.js";
import { lowerAgentPriority } from "../priority.js";
import { codexServerSpec, type CodexProviderDef } from "../profiles.js";
import { resolveCodexCommand, type CodexCommand } from "./command.js";
import { CodexRpcClient } from "./rpc-client.js";

// One `codex app-server` per Codex profile (studio/spikes/RESULTS.md, sections c and d). Port and token persist in
// the data dir so a restarted server, or a restarted Host, comes back at the same address and attached TUIs reconnect.

export const CODEX_PORT_RANGE = [47910, 47949] as const;

interface PersistedServer {
  port: number;
  /** Process id of the server (or of its node launcher), used to stop a server adopted after a Host restart. */
  pid: number | null;
}

export interface CodexServerHandle {
  profileId: string;
  url: string;
  port: number;
  /** Capability token. Only ever passed to clients and, through an env var, to attached TUIs. */
  token: string;
  client: CodexRpcClient;
}

export interface CodexServerManagerEvents {
  /** A server is reachable again after a crash or restart; re-subscribe threads with the new client. */
  ready: [CodexServerHandle];
  /** A server went away; it will be restarted with backoff unless the manager is stopping. */
  down: [{ profileId: string; reason: string }];
  log: [string];
}

export interface CodexServerManagerOptions {
  dataDir: string;
  profiles: readonly ModelProfile[];
  credentials: CredentialReader;
  /** Working directory for app-server processes; threads set their own cwd. */
  cwd: string;
  /** Extra env for every server, e.g. CODEX_HOME for tests. */
  env?: Record<string, string>;
  providers?: Record<string, CodexProviderDef>;
  codexCommand?: CodexCommand;
  portRange?: readonly [number, number];
  /** Backoff after a crash: first delay and cap, in ms. */
  backoffMs?: { first: number; max: number };
  /** Where app-servers reach the AMO MCP; read when a server starts (the Host's address is known only later). */
  mcp?: () => { url: string; token: string } | null;
}

interface Entry {
  profileId: string;
  port: number;
  token: string;
  child: ChildProcess | null;
  pid: number | null;
  handle: CodexServerHandle | null;
  starting: Promise<CodexServerHandle> | null;
  failures: number;
  restartTimer: NodeJS.Timeout | null;
  healthyTimer: NodeJS.Timeout | null;
  /** Tail of the current process's stderr, for error messages. */
  stderr: string;
}

export class CodexServerManager extends EventEmitter<CodexServerManagerEvents> {
  private readonly entries = new Map<string, Entry>();
  private readonly stateFile: string;
  private readonly tokenDir: string;
  private stopping = false;

  constructor(private readonly options: CodexServerManagerOptions) {
    super();
    mkdirSync(options.dataDir, { recursive: true });
    this.stateFile = join(options.dataDir, "codex-servers.json");
    this.tokenDir = join(options.dataDir, "codex-tokens");
    mkdirSync(this.tokenDir, { recursive: true });
  }

  /** Returns a connected handle for the profile, adopting a still-running server from a previous Host if possible. */
  ensure(profileId: string): Promise<CodexServerHandle> {
    this.stopping = false;
    const entry = this.entry(profileId);
    if (entry.handle?.client.isOpen) return Promise.resolve(entry.handle);
    if (!entry.starting) {
      entry.starting = this.start(entry).finally(() => {
        entry.starting = null;
      });
    }
    return entry.starting;
  }

  handle(profileId: string): CodexServerHandle | null {
    const h = this.entries.get(profileId)?.handle;
    return h?.client.isOpen ? h : null;
  }

  /** Stops one server and forgets its pid; port and token are kept for the next start. */
  async stop(profileId: string): Promise<void> {
    const entry = this.entries.get(profileId);
    if (!entry) return;
    this.clearTimers(entry);
    entry.handle?.client.close();
    entry.handle = null;
    if (entry.child) await killTree(entry.child, null);
    else if (entry.pid && isOurServer(entry.pid, this.tokenFile(entry.profileId))) await killTree(null, entry.pid);
    entry.child = null;
    entry.pid = null;
    // The launcher may exit before codex.exe releases the socket; wait until nothing listens any more.
    await waitPortClosed(entry.port, 5000);
    this.persist();
  }

  async stopAll(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id)));
  }

  /**
   * Closes connections but leaves server processes running, so the next Host can adopt them and sessions survive.
   * Servers this Host spawned stay alive only if the platform does not kill children with the parent.
   */
  detachAll(): void {
    this.stopping = true;
    for (const entry of this.entries.values()) {
      this.clearTimers(entry);
      entry.handle?.client.close();
      entry.handle = null;
      entry.child?.removeAllListeners("exit");
      entry.child?.unref();
    }
    this.persist();
  }

  /** Simulates a crash in tests: kills the process without going through `stop`. */
  killForTest(profileId: string): void {
    const entry = this.entries.get(profileId);
    if (entry?.child?.pid) killTreeSync(entry.child.pid);
  }

  private entry(profileId: string): Entry {
    let entry = this.entries.get(profileId);
    if (entry) return entry;
    const profile = this.options.profiles.find((p) => p.id === profileId);
    if (!profile || profile.runtime !== "codex") throw new Error(`unknown Codex profile ${profileId}`);
    const saved = this.readState()[profileId];
    entry = {
      profileId,
      port: saved?.port ?? 0,
      token: this.loadToken(profileId),
      child: null,
      pid: saved?.pid ?? null,
      handle: null,
      starting: null,
      failures: 0,
      restartTimer: null,
      healthyTimer: null,
      stderr: "",
    };
    this.entries.set(profileId, entry);
    return entry;
  }

  private async start(entry: Entry): Promise<CodexServerHandle> {
    // A server left running by a previous Host keeps its sessions alive; reuse it when it answers on our token.
    if (entry.port && !entry.child) {
      const adopted = await this.connect(entry, 1500).catch(() => null);
      if (adopted) {
        this.emit("log", `adopted running app-server for ${entry.profileId} on port ${entry.port}`);
        return adopted;
      }
      // Only kill a leftover pid when its command line proves it is our server (pids get reused).
      if (entry.pid && isOurServer(entry.pid, this.tokenFile(entry.profileId))) await killTree(null, entry.pid);
      entry.pid = null;
    }
    for (let attempt = 1; ; attempt++) {
      // Keep the address when we can: attached TUIs reconnect to it. A killed server's socket can take a moment to be
      // released (seen under load), so wait briefly for it before moving to another port.
      if (!entry.port || !(await portFreeWithin(entry.port, attempt === 1 ? PORT_RELEASE_WAIT_MS : 0))) entry.port = await this.pickPort(entry.profileId);
      this.spawnServer(entry);
      this.persist();
      try {
        return await this.waitReady(entry);
      } catch (err) {
        // An early exit is usually a socket still held by the previous process; retry a few times.
        if (attempt >= 3 || entry.child) throw err;
        this.emit("log", `app-server for ${entry.profileId} exited during startup, retrying (${attempt})`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  private spawnServer(entry: Entry): void {
    const profile = this.options.profiles.find((p) => p.id === entry.profileId)!;
    const spec = codexServerSpec(profile, this.options.profiles, this.options.credentials, { providers: this.options.providers, mcp: this.options.mcp?.() ?? null });
    const cmd = this.options.codexCommand ?? resolveCodexCommand();
    const tokenFile = this.tokenFile(entry.profileId);
    const args = [...cmd.prefixArgs, "app-server", ...spec.configArgs, "--listen", `ws://127.0.0.1:${entry.port}`, "--ws-auth", "capability-token", "--ws-token-file", tokenFile];
    const child = spawn(cmd.command, args, {
      cwd: this.options.cwd,
      env: withoutWindowsApps({ ...process.env, ...cmd.env, ...this.options.env, ...spec.env }),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    lowerAgentPriority(child.pid);
    entry.stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      entry.stderr = (entry.stderr + d.toString()).slice(-4000);
    });
    entry.child = child;
    entry.pid = child.pid ?? null;
    child.once("exit", (code) => {
      if (entry.child !== child) return;
      entry.child = null;
      entry.pid = null;
      entry.handle?.client.close();
      entry.handle = null;
      this.persist();
      if (this.stopping) return;
      this.emit("down", { profileId: entry.profileId, reason: `exited with code ${code}: ${entry.stderr.slice(-300)}` });
      this.scheduleRestart(entry);
    });
  }

  private async waitReady(entry: Entry): Promise<CodexServerHandle> {
    const deadline = Date.now() + 30_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      if (!entry.child && !this.stopping) throw new Error(`app-server for ${entry.profileId} exited during startup: ${entry.stderr.slice(-600)}`);
      try {
        return await this.connect(entry, 2000);
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    throw new Error(`app-server for ${entry.profileId} did not become ready: ${String(lastError)}`);
  }

  private async connect(entry: Entry, timeoutMs: number): Promise<CodexServerHandle> {
    const url = `ws://127.0.0.1:${entry.port}`;
    const client = await CodexRpcClient.connect({ url, token: entry.token, connectTimeoutMs: timeoutMs });
    const handle: CodexServerHandle = { profileId: entry.profileId, url, port: entry.port, token: entry.token, client };
    entry.handle = handle;
    client.once("close", () => {
      if (entry.handle === handle) entry.handle = null;
      // An adopted server has no child to report its exit; treat a dropped connection as going down.
      if (!entry.child && !this.stopping) {
        this.emit("down", { profileId: entry.profileId, reason: "connection lost" });
        this.scheduleRestart(entry);
      }
    });
    if (entry.healthyTimer) clearTimeout(entry.healthyTimer);
    entry.healthyTimer = setTimeout(() => {
      entry.failures = 0;
    }, 60_000);
    entry.healthyTimer.unref();
    this.emit("ready", handle);
    return handle;
  }

  private scheduleRestart(entry: Entry): void {
    if (entry.restartTimer || this.stopping) return;
    const { first, max } = this.options.backoffMs ?? { first: 1000, max: 30_000 };
    const delay = Math.min(max, first * 2 ** entry.failures);
    entry.failures += 1;
    this.emit("log", `restarting app-server for ${entry.profileId} in ${delay} ms`);
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      this.ensure(entry.profileId).catch((err: unknown) => {
        this.emit("log", `restart failed for ${entry.profileId}: ${String(err)}`);
        this.scheduleRestart(entry);
      });
    }, delay);
  }

  private clearTimers(entry: Entry): void {
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    if (entry.healthyTimer) clearTimeout(entry.healthyTimer);
    entry.restartTimer = null;
    entry.healthyTimer = null;
  }

  private async pickPort(profileId: string): Promise<number> {
    const [lo, hi] = this.options.portRange ?? CODEX_PORT_RANGE;
    const taken = new Set([...this.entries.values()].filter((e) => e.profileId !== profileId).map((e) => e.port));
    // From a random place in the range: Hosts starting together (parallel e2e runs) all took the lowest free port, and
    // all but one of their servers exited with "address in use" (os error 10048).
    const size = hi - lo + 1;
    const from = Math.floor(Math.random() * size);
    for (let i = 0; i < size; i++) {
      const port = lo + ((from + i) % size);
      if (!taken.has(port) && (await portFree(port))) return port;
    }
    throw new Error(`no free port in ${lo}-${hi}`);
  }

  private tokenFile(profileId: string): string {
    return join(this.tokenDir, `${profileId}.token`);
  }

  private loadToken(profileId: string): string {
    const file = this.tokenFile(profileId);
    if (existsSync(file)) {
      const token = readFileSync(file, "utf8").trim();
      if (token) return token;
    }
    const token = randomBytes(32).toString("hex");
    writeFileSync(file, token, { mode: 0o600 });
    return token;
  }

  private readState(): Record<string, PersistedServer> {
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf8")) as Record<string, PersistedServer>;
    } catch {
      return {};
    }
  }

  private persist(): void {
    const state = this.readState();
    for (const e of this.entries.values()) state[e.profileId] = { port: e.port, pid: e.pid };
    const tmp = `${this.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.stateFile);
  }

  /** Removes stored token and port, e.g. when a profile is deleted. */
  forget(profileId: string): void {
    rmSync(this.tokenFile(profileId), { force: true });
    const state = this.readState();
    delete state[profileId];
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    this.entries.delete(profileId);
  }
}

/** True when `pid` is alive and its command line references our token file, i.e. it is a server we started. */
function isOurServer(pid: number, tokenFile: string): boolean {
  if (process.platform !== "win32") return false;
  try {
    // On stdin, not as an encoded command (10-28: an antivirus took encoded PowerShell in Studio for a trojan). UTF-8 out,
    // so a token file under a folder with a Chinese name still matches.
    const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); (Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine\n`;
    const commandLine = execFileSync("powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], { encoding: "utf8", windowsHide: true, input: script, stdio: ["pipe", "pipe", "ignore"] });
    return commandLine.includes("app-server") && commandLine.toLowerCase().includes(tokenFile.toLowerCase());
  } catch {
    return false;
  }
}

/** Resolves once connecting to the port is refused (or the timeout passes). */
async function waitPortClosed(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = tcpConnect({ port, host: "127.0.0.1" });
      socket.once("connect", () => (socket.destroy(), resolve(true)));
      socket.once("error", () => resolve(false));
    });
    if (!open) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const PORT_RELEASE_WAIT_MS = 3000;

async function portFreeWithin(port: number, waitMs: number): Promise<boolean> {
  const until = Date.now() + waitMs;
  for (;;) {
    if (await portFree(port)) return true;
    if (Date.now() >= until) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

function killTreeSync(pid: number): void {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

async function killTree(child: ChildProcess | null, pid: number | null): Promise<void> {
  const target = child?.pid ?? pid;
  if (!target) return;
  const exited = child && child.exitCode === null ? new Promise<void>((r) => child.once("exit", () => r())) : Promise.resolve();
  killTreeSync(target);
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
}

/**
 * The app-server's PATH without WindowsApps. Codex prefers `pwsh` from there (the Store PowerShell 7, an app execution
 * alias), which cannot start inside Codex's Windows sandbox ("CreateProcessAsUserW failed: 5"); without it Codex uses
 * Windows PowerShell 5 and sandboxed commands run (spikes/RESULTS.md s9-06). Agent commands then do not see the Store
 * aliases (pwsh, python3, winget) either.
 */
export function withoutWindowsApps(env: NodeJS.ProcessEnv, platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== "win32") return env;
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() !== "path" || !out[key]) continue;
    out[key] = out[key]!.split(";").filter((dir) => dir && !/\\WindowsApps(\\|$)/i.test(dir)).join(";");
  }
  return out;
}
