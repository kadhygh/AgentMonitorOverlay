import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { RelayClient } from "./api.js";

export { RelayClient, RelayClientError, normalizeServer } from "./api.js";

// This machine's relay settings, for Node (the MCP, the command line, the desktop shell):
// which service, and who I am there. The settings file is the person's, shared by everything on the machine, so an
// AI's MCP speaks as the person who set it up.

export interface RelaySettings {
  /** The service, e.g. http://192.168.1.20:47120 */
  server: string;
  name: string;
  key: string;
}

/** %APPDATA%\AMO Relay (AMO_RELAY_HOME overrides, for tests and a second identity on one machine). */
export function relayHome(): string {
  if (process.env.AMO_RELAY_HOME) return process.env.AMO_RELAY_HOME;
  const appData = process.env.APPDATA ?? (process.platform === "darwin" ? join(homedir(), "Library", "Application Support") : join(homedir(), ".config"));
  return join(appData, "AMO Relay");
}

export const settingsPath = (home = relayHome()) => join(home, "settings.json");

export function readSettings(home = relayHome()): RelaySettings | null {
  const path = settingsPath(home);
  if (!existsSync(path)) return null;
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Partial<RelaySettings>;
    return s.server && s.name && s.key ? { server: s.server, name: s.name, key: s.key } : null;
  } catch {
    return null;
  }
}

export function writeSettings(settings: RelaySettings, home = relayHome()): void {
  const path = settingsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export const clientFromSettings = (s: RelaySettings): RelayClient => new RelayClient(s.server, s.key);
