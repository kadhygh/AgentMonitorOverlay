import { rmSync } from "node:fs";
import { dpapi, type Protector } from "./dpapi.js";
import { readJsonFile, updateJsonFile, writeJsonFile } from "./json.js";
import { accountFile, platformFile, type Env } from "./paths.js";

// The team account, shared by the AMO tools (plans/amo-lan-platform.md, 10-28): the platform logs in to the team
// server (the relay service's /api/login; /api/register for people without an account, since the platform is the only
// place to log in) and keeps the key in %APPDATA%\AMO\account.json, encrypted for this Windows
// user. Other tools only read it (readAccount / readAccountInfo) — Studio for later remote features, the relay client
// once it moves to the platform's login. It is never handed over in environment variables: Studio passes its
// environment on to the agents' commands.
//
// account.json: { "server": "http://…:47120", "name": "…", "key": "<DPAPI-encrypted, base64>" }
// The recent servers (最近 3 个) are in platform.json beside the platform's other settings, as the contract has it.

export interface Account {
  /** Normalised: `http://host:port`, no trailing slash. */
  server: string;
  name: string;
  /** The API key: `Authorization: Bearer <key>`. */
  key: string;
}

/** What can be shown without decrypting anything. */
export type AccountInfo = Omit<Account, "key">;

export interface AccountOptions {
  env?: Env;
  /** Tests and other platforms: something other than DPAPI. */
  protector?: Protector;
  /** Tests: a fetch of their own. */
  fetch?: typeof fetch;
}

/** `conflict`: registering a name someone already has. */
export type AccountErrorCode = "unreachable" | "unauthorized" | "bad_request" | "conflict" | "server" | "not_amo";

export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface Stored {
  server?: unknown;
  name?: unknown;
  key?: unknown;
}

export const RECENT_SERVERS_MAX = 3;

/** `172.16.8.85:47120` → `http://172.16.8.85:47120`; trailing slashes go. The same rule as the relay client's. */
export function normalizeServer(server: string): string {
  const s = server.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(s) ? s : `http://${s}`;
}

/** The address as people type it: without `http://`. */
export const serverLabel = (server: string) => server.replace(/^http:\/\//i, "");

/** The account this machine is logged in with — name and server only, nothing decrypted. Synchronous, for display. */
export function readAccountInfo(options: { env?: Env } = {}): AccountInfo | null {
  const s = readJsonFile<Stored>(accountFile(options.env));
  if (!s || typeof s.server !== "string" || typeof s.name !== "string" || !s.server || !s.name) return null;
  return { server: s.server, name: s.name };
}

/** The account with its key decrypted, or null when nobody is logged in or the key cannot be decrypted here. */
export async function readAccount(options: AccountOptions = {}): Promise<Account | null> {
  const s = readJsonFile<Stored>(accountFile(options.env));
  if (!s || typeof s.server !== "string" || typeof s.name !== "string" || typeof s.key !== "string" || !s.key) return null;
  try {
    return { server: s.server, name: s.name, key: await (options.protector ?? dpapi).unprotect(s.key) };
  } catch {
    // Another Windows user's file, or copied from another machine: as good as logged out.
    return null;
  }
}

/** Saves an account (the key encrypted). */
export async function saveAccount(account: Account, options: AccountOptions = {}): Promise<void> {
  const key = await (options.protector ?? dpapi).protect(account.key);
  writeJsonFile(accountFile(options.env), { server: normalizeServer(account.server), name: account.name, key });
}

/** Forgets the account here (the server is not told: see logout). */
export function clearAccount(options: { env?: Env } = {}): void {
  rmSync(accountFile(options.env), { force: true });
}

async function call<T>(f: typeof fetch, url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    throw new AccountError("unreachable", `连不上 ${serverLabel(new URL(url).origin)}：检查地址是否正确、服务是否开着、是否在同一个网络里。（${text}）`);
  }
  const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
  if (!res.ok) {
    const message = typeof body?.message === "string" && body.message ? body.message : `服务器回了 ${res.status}`;
    throw new AccountError(res.status === 401 || res.status === 403 ? "unauthorized" : res.status === 404 ? "not_amo" : res.status === 409 ? "conflict" : res.status < 500 ? "bad_request" : "server", message);
  }
  if (!body) throw new AccountError("not_amo", "这个地址上不是 AMO 的团队服务器");
  return body as T;
}

/**
 * Logs in to a team server (`POST /api/login {name, password}` → `{name, role, key}`), saves the account and puts the
 * server first in the recent list. Throws AccountError with a message to show as it is.
 */
export async function login(input: { server: string; name: string; password: string }, options: AccountOptions = {}): Promise<Account & { role: string }> {
  const server = normalizeServer(input.server);
  if (!input.server.trim()) throw new AccountError("bad_request", "先填服务器地址");
  if (!input.name.trim()) throw new AccountError("bad_request", "先填名字");
  const r = await call<{ name?: unknown; role?: unknown; key?: unknown }>(options.fetch ?? fetch, `${server}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: input.name.trim(), password: input.password }),
  });
  return signedIn(server, r, options);
}

/** What a login or a registration hands back → the account saved, the server first in the recent list. */
async function signedIn(server: string, r: { name?: unknown; role?: unknown; key?: unknown }, options: AccountOptions): Promise<Account & { role: string }> {
  if (typeof r.key !== "string" || typeof r.name !== "string") throw new AccountError("not_amo", "这个地址上不是 AMO 的团队服务器");
  const account = { server, name: r.name, key: r.key };
  await saveAccount(account, options);
  rememberServer(server, options);
  return { ...account, role: typeof r.role === "string" ? r.role : "" };
}

export interface ServerInfo {
  /** The service's own name (e.g. 「策划组」), when it has one. */
  name: string | null;
  /** Registering there takes the invite passphrase. */
  invite: boolean;
}

/** Asks a team server about itself (`GET /api/health`, no key): its name and whether registering takes the passphrase. */
export async function serverInfo(server: string, options: AccountOptions = {}): Promise<ServerInfo> {
  if (!server.trim()) throw new AccountError("bad_request", "先填服务器地址");
  const h = await call<{ app?: unknown; name?: unknown; invite?: unknown }>(options.fetch ?? fetch, `${normalizeServer(server)}/api/health`, { method: "GET" });
  if (h.app !== "amo-relay") throw new AccountError("not_amo", "这个地址上不是 AMO 的团队服务器");
  return { name: typeof h.name === "string" && h.name ? h.name : null, invite: h.invite === true };
}

export interface RegisterInput {
  server: string;
  name: string;
  password: string;
  /** 负责什么 (may be empty): the relay's AI reads it to decide whom to ask. */
  role?: string;
  /** The invite passphrase, when the server has one (serverInfo → invite). */
  passphrase?: string;
}

/**
 * Registers on a team server (`POST /api/register {name, password, role, passphrase?}` → `{name, role, key}`, the relay
 * service's rules: name 1–32 characters, password at least 4) and, as a login does, saves the account and remembers the
 * server. Throws AccountError with the server's message (名字「…」已经有人用了 → conflict, 邀请口令不对 → unauthorized).
 */
export async function register(input: RegisterInput, options: AccountOptions = {}): Promise<Account & { role: string }> {
  const server = normalizeServer(input.server);
  if (!input.server.trim()) throw new AccountError("bad_request", "先填服务器地址");
  if (!input.name.trim()) throw new AccountError("bad_request", "先填名字");
  const passphrase = input.passphrase ?? "";
  const r = await call<{ name?: unknown; role?: unknown; key?: unknown }>(options.fetch ?? fetch, `${server}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: input.name.trim(), password: input.password, role: (input.role ?? "").trim(), ...(passphrase ? { passphrase } : {}) }),
  });
  return signedIn(server, r, options);
}

/** Logs out: tells the server to drop the key (best effort, offline is fine) and forgets the account here. */
export async function logout(options: AccountOptions = {}): Promise<void> {
  const account = await readAccount(options);
  clearAccount(options);
  if (!account) return;
  try {
    await (options.fetch ?? fetch)(`${account.server}/api/logout`, { method: "POST", headers: { authorization: `Bearer ${account.key}` }, signal: AbortSignal.timeout(5000) });
  } catch {
    // The key expires on the server some other way; here it is gone already.
  }
}

// ---- 资料 (2026-10-28, the user: editing the nickname, picture and 负责什么 moved from the relay client to the platform's
// 账号 page). The relay service's GET / PATCH /api/me (server.ts, store.setProfile), with the account's key.

/** What the team sees of an account (GET /api/me). */
export interface Profile {
  name: string;
  /** The service's name (e.g. 「策划组」), "" when it has none. */
  service: string;
  /** 负责什么: the relay's AI reads it to decide whom to ask. */
  role: string;
  /** "" for none: the account name is shown. */
  nick: string;
  /** A data: URL (PNG, JPEG or WebP), null for the initial on a colour. */
  avatar: string | null;
}

export type ProfilePatch = Partial<Pick<Profile, "nick" | "role" | "avatar">>;

/** The service's limits (store.ts: LIMITS.name for the nickname, LIMITS.role, the avatar check in setProfile). */
export const PROFILE_LIMITS = { nick: 32, role: 60, avatarChars: 96 * 1024 } as const;

/**
 * Why the service would refuse this change, in its words, or null. Checked here first so the platform can say so
 * without a round trip; the service checks again and its message is what counts.
 */
export function profileProblem(p: ProfilePatch): string | null {
  if (p.nick !== undefined) {
    const nick = p.nick.trim();
    if (nick.length > PROFILE_LIMITS.nick) return `昵称 太长（最多 ${PROFILE_LIMITS.nick} 字）`;
    if (/[\u0000-\u001f\u007f]/.test(nick)) return "昵称里不能有控制字符";
  }
  if (p.role !== undefined && p.role.trim().length > PROFILE_LIMITS.role) return `角色 太长（最多 ${PROFILE_LIMITS.role} 字）`;
  if (p.avatar && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p.avatar) || p.avatar.length > PROFILE_LIMITS.avatarChars)) return "头像要是不超过 64 KB 的 PNG、JPEG 或 WebP 图片";
  return null;
}

type KeyedAccount = Pick<Account, "server" | "key">;

/** The account's profile from its server (`GET /api/me`). Throws AccountError (unauthorized: the key no longer works). */
export async function fetchProfile(account: KeyedAccount, options: AccountOptions = {}): Promise<Profile> {
  const r = await call<{ name?: unknown; service?: unknown; role?: unknown; nick?: unknown; avatar?: unknown }>(options.fetch ?? fetch, `${account.server}/api/me`, { method: "GET", headers: { authorization: `Bearer ${account.key}` } });
  if (typeof r.name !== "string") throw new AccountError("not_amo", "这个地址上不是 AMO 的团队服务器");
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return { name: r.name, service: str(r.service), role: str(r.role), nick: str(r.nick), avatar: typeof r.avatar === "string" && r.avatar ? r.avatar : null };
}

/**
 * Changes the account's profile on its server (`PATCH /api/me`; only what is given changes, text trimmed, avatar null
 * or "" for none). Checked first with profileProblem (bad_request); then the service's message, as it says it.
 */
export async function updateProfile(account: KeyedAccount, patch: ProfilePatch, options: AccountOptions = {}): Promise<void> {
  const problem = profileProblem(patch);
  if (problem) throw new AccountError("bad_request", problem);
  const body: Record<string, unknown> = {};
  if (patch.nick !== undefined) body.nick = patch.nick.trim();
  if (patch.role !== undefined) body.role = patch.role.trim();
  if (patch.avatar !== undefined) body.avatar = patch.avatar || null;
  await call<{ ok?: unknown }>(options.fetch ?? fetch, `${account.server}/api/me`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${account.key}` }, body: JSON.stringify(body) });
}

/** Puts `server` first, without repeats, at most RECENT_SERVERS_MAX. */
export function pushRecent(list: readonly string[], server: string, max = RECENT_SERVERS_MAX): string[] {
  const s = normalizeServer(server);
  return [s, ...list.map(normalizeServer).filter((x) => x !== s)].slice(0, max);
}

/** The servers used last, newest first (platform.json → recentServers). */
export function recentServers(options: { env?: Env } = {}): string[] {
  const p = readJsonFile<{ recentServers?: unknown }>(platformFile(options.env));
  return Array.isArray(p?.recentServers) ? p.recentServers.filter((x): x is string => typeof x === "string").slice(0, RECENT_SERVERS_MAX) : [];
}

/** Makes `server` the current one and first in the recent list (platform.json; its other keys stay). */
export function rememberServer(server: string, options: { env?: Env } = {}): void {
  updateJsonFile<{ server: string; recentServers: string[] }>(platformFile(options.env), (p) => ({
    ...p,
    server: normalizeServer(server),
    recentServers: pushRecent(Array.isArray(p.recentServers) ? p.recentServers : [], server),
  }));
}
