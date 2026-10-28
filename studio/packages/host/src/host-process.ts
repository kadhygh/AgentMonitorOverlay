import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_DEFAULT_PORT, type ModelProfile } from "@amo-studio/protocol";
import { startHostServer, type HostServer } from "./http/server.js";
import { CodexRuntime, type CodexServers } from "./runtime/codex/codex-runtime.js";
import { BUILTIN_CLAUDE_PROVIDERS, type ClaudeProviderDef } from "./runtime/claude/claude-env.js";
import { ClaudeRuntime } from "./runtime/claude/claude-runtime.js";
import { CLAUDE_CODE_MISSING, findClaudeCode } from "./runtime/claude/executable.js";
import { DshRuntime } from "./runtime/dsh/dsh-runtime.js";
import type { FolderAccess } from "./runtime/dsh/folder-access.js";
import { dshUnavailable } from "./runtime/dsh/install.js";
import { localClaudeHome as localClaudeHomeOf } from "./runtime/claude/claude-login.js";
import { RuntimeRouter } from "./runtime/runtime.js";
import { AMO_MCP_INSTRUCTIONS, amoToolsFor } from "./mcp/tools.js";
import { recordRole, roleCard, roleCardFor } from "./features/guide/role.js";
import { McpIdentities } from "./mcp/identity.js";
import { CodexServerManager } from "./runtime/codex/server-manager.js";
import { WindowsCredentialReader, type CredentialReader } from "./runtime/credentials.js";
import { BUILTIN_BALANCES, BUILTIN_PROFILES, CODEX_PROVIDERS, type CodexProviderDef } from "./runtime/profiles.js";
import { ChannelRegistry } from "./runtime/channels.js";
import { HostService } from "./service.js";
import type { RemoteOptions } from "./features/remote/service.js";
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
  /** Anthropic-compatible endpoints for Claude profiles (default: GLM). Tests point one at the mock. */
  claudeProviders?: Record<string, ClaudeProviderDef>;
  /** Variables Claude processes start from (default: process.env). */
  claudeBaseEnv?: NodeJS.ProcessEnv;
  /** The person's Claude Code config dir for the local login (default: their CLAUDE_CONFIG_DIR or ~/.claude). */
  localClaudeHome?: string;
  /** Tests: the ACP agent DSH sessions run (a fake one) instead of the DSH clone set in 设置 → 模型. */
  dshAgent?: { command: string; args: readonly string[] };
  /** Variables DSH processes start from (default: process.env). */
  dshEnv?: NodeJS.ProcessEnv;
  /** Tests: what reads and fixes a DSH session's folder permissions (folder-access.ts); null for none. */
  dshFolderAccess?: FolderAccess | null;
  /** Tests: the wait between a set-up folder's scans after write turns. */
  dshFolderScanMs?: number;
  /**
   * 远程 (2026-10-29): connect to the team server as this computer's device with the AMO platform's login. Studio's
   * Host (bin.ts) turns it on; the Reviewer and tests that start a Host leave it off, so they never reach a server.
   */
  remote?: RemoteOptions;
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

/** Host events kept in the log (a window catching up needs only the newest). */
const EVENTS_KEPT = 5000;

export const hostPaths = (dataDir: string) => ({
  lock: join(dataDir, "host.lock"),
  info: join(dataDir, "host.json"),
  token: join(dataDir, "host-token"),
  mcpToken: join(dataDir, "mcp-token"),
  db: join(dataDir, "studio.db"),
  codex: join(dataDir, "codex"),
  claudeHome: join(dataDir, "claude-home"),
  dsh: join(dataDir, "dsh"),
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
  let claude: ClaudeRuntime | undefined;
  let dsh: DshRuntime | undefined;
  try {
    const token = loadOrCreateToken(paths.token);
    // Agents get a token that opens the read-only MCP only, never the writable REST API.
    const mcpToken = loadOrCreateToken(paths.mcpToken);
    let mcp: { url: string; token: string } | null = null;
    store = new Store(paths.db);
    const liveKv = store;
    // The event log only serves windows catching up: its newest part is kept, now and every hour (2026-10-20).
    store.pruneEvents(EVENTS_KEPT);
    const pruneStore = store;
    const pruning = setInterval(() => pruneStore.pruneEvents(EVENTS_KEPT), 60 * 60_000);
    pruning.unref();
    // One reader for everything, so a token saved in 设置 is what the next Claude session reads.
    const credentials = options.credentials ?? new WindowsCredentialReader();
    // All saved keys in one run that does not hold up the event loop, before anything reads one.
    if (credentials instanceof WindowsCredentialReader) await credentials.preload();
    // The built-in profiles plus the person's own channels (设置 → 模型). The list and the provider tables are changed
    // in place when a channel is added or edited, so every runtime below sees it at once.
    const channels = new ChannelRegistry({
      kv: store,
      credentials,
      builtins: options.profiles ?? BUILTIN_PROFILES,
      codexProviders: { ...(options.providers ?? CODEX_PROVIDERS) },
      claudeProviders: { ...(options.claudeProviders ?? BUILTIN_CLAUDE_PROVIDERS) },
      dshProviders: {},
      ...(options.profiles ? {} : { builtinBalance: BUILTIN_BALANCES }),
      // DSH sessions need a built clone (设置 → 模型), Claude sessions a Claude Code (the portable build ships none); until
      // then the profile stays out of the pickers.
      unavailable: (p) =>
        p.runtime === "dsh" && !options.dshAgent ? (dshUnavailable(liveKv) ?? undefined) : p.runtime === "claude" && !findClaudeCode() ? CLAUDE_CODE_MISSING : undefined,
    });
    const profiles = channels.profiles;
    manager = options.servers
      ? undefined
      : new CodexServerManager({
          dataDir: paths.codex,
          profiles,
          credentials,
          cwd: options.dataDir,
          ...(options.codexEnv ? { env: options.codexEnv } : {}),
          providers: channels.codexProviders,
          mcp: () => mcp,
        });
    const servers = options.servers ?? manager!;
    // Only app-servers Studio launches have the AMO MCP configured; threads then name their session to it.
    const identities = new McpIdentities(store);
    const codex = new CodexRuntime({
      store,
      servers,
      profiles,
      ...(manager ? { identities } : {}),
      roleInstructions: (draft): string | undefined => {
        try {
          // The AMO MCP server's own instructions say the rest.
          return roleCardFor(service, { ...draft, kind: "main", runtime: "codex" });
        } catch {
          return undefined;
        }
      },
      roleGiven: (sessionId): void => {
        try {
          recordRole(service, sessionId);
        } catch {
          // Its card is still what amo_whoami says.
        }
      },
    });
    // Managed Claude sessions keep their transcripts in Studio's own config dir, unless the person chose the local login
    // (设置 → 模型): then sessions started with it use their Claude Code login and ~/.claude.
    const localClaudeHome = options.localClaudeHome ?? localClaudeHomeOf(options.claudeBaseEnv ?? process.env);
    claude = new ClaudeRuntime({
      store,
      profiles,
      providers: channels.claudeProviders,
      credentials,
      claudeHome: paths.claudeHome,
      ...(options.claudeBaseEnv ? { baseEnv: options.claudeBaseEnv } : {}),
      // Only an explicit dir is passed down: otherwise the CLI is left to find ~/.claude (and ~/.claude.json) itself.
      ...(options.localClaudeHome ? { localClaudeHome: options.localClaudeHome } : {}),
      mcpTools: (sessionId) => amoToolsFor(service, { sessionId }),
      mcpInstructions: (sessionId): string => {
        try {
          const card = roleCard(service, sessionId);
          recordRole(service, sessionId);
          return `${AMO_MCP_INSTRUCTIONS}\n\n${card}`;
        } catch {
          return AMO_MCP_INSTRUCTIONS;
        }
      },
    });
    dsh = new DshRuntime({
      store,
      profiles,
      credentials,
      providers: channels.dshProviders,
      dir: paths.dsh,
      mcp: () => mcp,
      identities,
      ...(options.dshAgent ? { agent: options.dshAgent } : {}),
      ...(options.dshEnv ? { env: options.dshEnv } : {}),
      ...(options.dshFolderAccess !== undefined ? { folderAccess: options.dshFolderAccess } : {}),
      ...(options.dshFolderScanMs !== undefined ? { folderScanEveryMs: options.dshFolderScanMs } : {}),
    });
    const runtime = new RuntimeRouter(store, profiles, { codex, claude, dsh });
    const liveStore = store;
    const service = new HostService(store, runtime, profiles, {
      launcher: options.launcher ?? new WindowsTerminalLauncher(),
      credentials,
      localClaudeHome,
      channels,
      dsh,
      // A Codex channel's address or key is fixed when its app-server starts: restart it, unless a session on it is busy.
      restartProfileServer: async (profileId) => {
        if (!manager?.handle(profileId)) return true;
        const busy = liveStore.listSessions().some((s) => s.profileId === profileId && (s.status === "running" || s.status === "awaiting-approval" || s.status === "awaiting-answer"));
        if (busy) return false;
        await manager.stop(profileId);
        return true;
      },
    });
    http = await startHostServer({
      service,
      token,
      mcpToken,
      mcpIdentities: identities,
      port: options.port ?? HOST_DEFAULT_PORT,
      ...(options.uiDir ? { uiDir: options.uiDir } : {}),
      ...(options.allowedOrigins ? { allowedOrigins: options.allowedOrigins } : {}),
    });
    mcp = { url: `${http.url}/mcp`, token: mcpToken };
    if (options.remote) service.remote.start(options.remote);
    const info: HostInfo = { url: http.url, port: http.port, pid: process.pid, startedAt: new Date().toISOString() };
    writeFileSync(paths.info, JSON.stringify(info, null, 2));

    let stopped = false;
    const finalStore = store;
    const finalHttp = http;
    const finalManager = manager;
    const finalClaude = claude;
    const finalDsh = dsh;
    // 2026-10-27: DSH turns that ended without their tokens and speed get them from DSH's logs, once the Host settled.
    setTimeout(() => {
      if (stopped) return;
      void finalDsh
        .backfillStats()
        .then((n) => n && console.log(`DSH: filled in the tokens and speed of ${n} turns from DSH's logs`))
        .catch((err: unknown) => console.log(`DSH stats backfill failed: ${String(err)}`))
        // Claude subagents' tokens and speed from Claude Code's transcripts (2026-10-27), after DSH's.
        .then(() => (stopped ? 0 : finalClaude.backfillSubagentStats()))
        .then((n) => n && console.log(`Claude: filled in the tokens and speed of ${n} subagents from Claude Code's transcripts`))
        .catch((err: unknown) => console.log(`Claude subagent stats backfill failed: ${String(err)}`));
    }, 20_000).unref();
    return {
      info,
      token,
      service,
      async shutdown({ keepServers = false } = {}) {
        if (stopped) return;
        stopped = true;
        clearInterval(pruning);
        service.remote.stop();
        await finalHttp.close();
        await finalClaude.closeAll();
        await finalDsh.closeAll();
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
    await dsh?.closeAll();
    await manager?.stopAll();
    store?.close();
    release();
    throw err;
  }
}
