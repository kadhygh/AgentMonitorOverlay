import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { accountFile, readAccount, type AccountOptions } from "@amo-studio/account";
import { RelayClient } from "./api.js";

export { RelayClient, RelayClientError, normalizeServer } from "./api.js";

// This machine's relay settings, for Node (the MCP, the command line, the desktop shell):
// which service, and who I am there. The settings file is the person's, shared by everything on the machine, so an
// AI's MCP speaks as the person who set it up.
//
// Signed in through AMO 平台 (2026-11-04, the 11-03 audit, AGENTS.md rule 7): the file names the platform's account
// instead of holding its key — { "server", "name", "account": "platform" } — and loadSettings reads the key from
// %APPDATA%\AMO\account.json (DPAPI-encrypted for this Windows user) when asked. Before, the key sat in this file in
// plain text, where any command an agent runs could print it. A login of its own (`amo-relay login`, a client unpacked
// by hand without the platform) still writes its key here.

export interface RelaySettings {
  /** The service, e.g. http://192.168.1.20:47120 */
  server: string;
  name: string;
  key: string;
}

/** What the file holds: an identity with its key, or one that points at the platform's account. */
type Stored = Partial<RelaySettings> & { account?: "platform" };

/** %APPDATA%\AMO Relay (AMO_RELAY_HOME overrides, for tests and a second identity on one machine). */
export function relayHome(): string {
  if (process.env.AMO_RELAY_HOME) return process.env.AMO_RELAY_HOME;
  const appData = process.env.APPDATA ?? (process.platform === "darwin" ? join(homedir(), "Library", "Application Support") : join(homedir(), ".config"));
  return join(appData, "AMO Relay");
}

export const settingsPath = (home = relayHome()) => join(home, "settings.json");

function readStored(home: string): Stored | null {
  const path = settingsPath(home);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Stored;
  } catch {
    return null;
  }
}

/** An identity with its key written in the file; null for none, and for one that points at the platform (loadSettings). */
export function readSettings(home = relayHome()): RelaySettings | null {
  const s = readStored(home);
  return s && s.account !== "platform" && s.server && s.name && s.key ? { server: s.server, name: s.name, key: s.key } : null;
}

/** Whether the file points at the platform's account (who, without the key). */
export function platformSettings(home = relayHome()): { server: string; name: string } | null {
  const s = readStored(home);
  return s?.account === "platform" && s.server && s.name ? { server: s.server, name: s.name } : null;
}

// Decrypting starts PowerShell (about half a second): an MCP asks before every tool call, so the answer is kept until
// either file changes.
let cached: { stamp: string; settings: RelaySettings | null } | null = null;
const mtime = (path: string) => (existsSync(path) ? statSync(path).mtimeMs : 0);

/** This machine's identity with its key: the file's own, or the platform's account the file points at. */
export async function loadSettings(home = relayHome(), account: AccountOptions = {}): Promise<RelaySettings | null> {
  const own = readSettings(home);
  if (own) return own;
  if (!platformSettings(home)) return null;
  const stamp = `${settingsPath(home)}:${mtime(settingsPath(home))}|${accountFile(account.env)}:${mtime(accountFile(account.env))}`;
  if (cached?.stamp === stamp) return cached.settings;
  const a = await readAccount(account).catch(() => null);
  // The platform's account is the one to use (the shell follows it); logged out there: not joined here either.
  const settings = a ? { server: a.server, name: a.name, key: a.key } : null;
  cached = { stamp, settings };
  return settings;
}

export function writeSettings(settings: RelaySettings | { server: string; name: string; account: "platform" }, home = relayHome()): void {
  const path = settingsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export const clientFromSettings = (s: RelaySettings): RelayClient => new RelayClient(s.server, s.key);
