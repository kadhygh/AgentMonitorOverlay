import { platformFile, readJsonFile, RECENT_SERVERS_MAX, updateJsonFile, type Env } from "@amo-studio/account";
import type { Channel } from "./view.js";

// %APPDATA%\AMO\platform.json (the contract): the server, the 3 recent ones (written by the account module's
// rememberServer), the channel, Studio's data dir, starting with Windows, the platform's folder. Unknown keys are kept
// as they are.

export interface PlatformSettings {
  server: string | null;
  recentServers: string[];
  channel: Channel;
  studioDataDir: string | null;
  openAtLogin: boolean;
  /** The name last logged in with, for the login form. */
  lastName: string | null;
  /** The platform's folder (self-update.ts's root: its entry and apps\), as the platform last ran. Only a record, for other programs. */
  root: string | null;
}

export function readSettings(env: Env = process.env): PlatformSettings {
  const p = readJsonFile<Record<string, unknown>>(platformFile(env)) ?? {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    server: str(p.server),
    recentServers: Array.isArray(p.recentServers) ? p.recentServers.filter((x): x is string => typeof x === "string").slice(0, RECENT_SERVERS_MAX) : [],
    channel: p.channel === "test" ? "test" : "stable",
    studioDataDir: str(p.studioDataDir),
    openAtLogin: p.openAtLogin === true,
    lastName: str(p.lastName),
    root: str(p.root),
  };
}

export function updateSettings(patch: Partial<Omit<PlatformSettings, "recentServers">>, env: Env = process.env): PlatformSettings {
  updateJsonFile<Record<string, unknown>>(platformFile(env), (p) => ({ ...p, ...patch }));
  return readSettings(env);
}

/** `--channel test` / `--channel=stable`: overrides the setting for this run. */
export function channelFromArgs(argv: readonly string[]): Channel | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = a === "--channel" ? argv[i + 1] : a.startsWith("--channel=") ? a.slice(10) : undefined;
    if (value === "test" || value === "stable") return value;
  }
  return null;
}
