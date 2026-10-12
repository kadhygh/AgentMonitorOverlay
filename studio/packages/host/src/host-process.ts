import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_DEFAULT_PORT, type ModelProfile } from "@amo-studio/protocol";
import { startHostServer, type HostServer } from "./http/server.js";
import { CodexRuntime, type CodexServers } from "./runtime/codex/codex-runtime.js";
import { CodexServerManager } from "./runtime/codex/server-manager.js";
import { WindowsCredentialReader, type CredentialReader } from "./runtime/credentials.js";
import { BUILTIN_PROFILES, type CodexProviderDef } from "./runtime/profiles.js";
import { HostService } from "./service.js";
import { Store } from "./store/store.js";
import { WindowsTerminalLauncher, type TerminalLauncher } from "./terminal/launcher.js";

// The resident Host: one per data dir, guarded by a lock file. It writes host.json (url, port, pid) so the Electron
// shell can find it, and keeps its API token in host-token (read by the shell, never logged).

export interface HostInfo {
  url: string;
  port: number;
  pid: number;
  startedAt: string;
}

export interface StartHostOptions {
  dataDir: string;
  port?: number;
  uiDir?: string;
  allowedOrigins?: readonly string[];
  profiles?: readonly ModelProfile[];
  credentials?: CredentialReader;
  /** Extra env for app-servers (tests: CODEX_HOME). */
  codexEnv?: Record<string, string>;
  providers?: Record<string, CodexProviderDef>;
  /** Tests: replace the real app-server manager. */
  servers?: CodexServers & { stopAll?: () => Promise<void>; detachAll?: () => void };
  launcher?: TerminalLauncher;
}

export interface RunningHost {
  info: HostInfo;
  token: string;
  service: HostService;
  /** `keepServers`: leave app-servers running so a restarted Host can adopt them (sessions keep going). */
  shutdown(options?: { keepServers?: boolean }): Promise<void>;
}

export class HostAlreadyRunningError extends Error {
  constructor(readonly info: HostInfo | null) {
    super(`AMO Studio Host is already running${info ? ` at ${info.url} (pid ${info.pid})` : ""}`);
    this.name = "HostAlreadyRunningError";
  }
}

export const hostPaths = (dataDir: string) => ({
  lock: join(dataDir, "host.lock"),
  info: join(dataDir, "host.json"),
  token: join(dataDir, "host-token"),
  db: join(dataDir, "studio.db"),
  codex: join(dataDir, "codex"),
});

export function readHostInfo(dataDir: string): HostInfo | null {
  try {
    return JSON.parse(readFileSync(hostPaths(dataDir).info, "utf8")) as HostInfo;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes the lock, clearing it when the owner is gone. Returns a release function. */
function acquireLock(dataDir: string): () => void {
  const { lock } = hostPaths(dataDir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(lock, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = Number(readFileSync(lock, "utf8").trim());
      if (owner && pidAlive(owner)) throw new HostAlreadyRunningError(readHostInfo(dataDir));
      rmSync(lock, { force: true });
    }
  }
  throw new HostAlreadyRunningError(readHostInfo(dataDir));
}

function loadOrCreateToken(file: string): string {
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    if (token) return token;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export async function startHost(options: StartHostOptions): Promise<RunningHost> {
  mkdirSync(options.dataDir, { recursive: true });
  const paths = hostPaths(options.dataDir);
  const release = acquireLock(options.dataDir);
  let store: Store | undefined;
  let http: HostServer | undefined;
  let manager: CodexServerManager | undefined;
  try {
    const profiles = options.profiles ?? BUILTIN_PROFILES;
    const token = loadOrCreateToken(paths.token);
    store = new Store(paths.db);
    manager = options.servers
      ? undefined
      : new CodexServerManager({
          dataDir: paths.codex,
          profiles,
          credentials: options.credentials ?? new WindowsCredentialReader(),
          cwd: options.dataDir,
          ...(options.codexEnv ? { env: options.codexEnv } : {}),
          ...(options.providers ? { providers: options.providers } : {}),
        });
    const servers = options.servers ?? manager!;
    const runtime = new CodexRuntime({ store, servers, profiles });
    const service = new HostService(store, runtime, profiles, { launcher: options.launcher ?? new WindowsTerminalLauncher() });
    http = await startHostServer({
      service,
      token,
      port: options.port ?? HOST_DEFAULT_PORT,
      ...(options.uiDir ? { uiDir: options.uiDir } : {}),
      ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
    });
    const info: HostInfo = { url: http.url, port: http.port, pid: process.pid, startedAt: new Date().toISOString() };
    writeFileSync(paths.info, JSON.stringify(info, null, 2));

    let stopped = false;
    const finalStore = store;
    const finalHttp = http;
    const finalManager = manager;
    return {
      info,
      token,
      service,
      async shutdown({ keepServers = false } = {}) {
        if (stopped) return;
        stopped = true;
        await finalHttp.close();
        const s = finalManager ?? options.servers;
        if (keepServers) s?.detachAll?.();
        else await s?.stopAll?.();
        finalStore.close();
        rmSync(paths.info, { force: true });
        release();
      },
    };
  } catch (err) {
    await http?.close();
    await manager?.stopAll();
    store?.close();
    release();
    throw err;
  }
}
