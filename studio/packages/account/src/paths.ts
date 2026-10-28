import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Where the AMO tools keep what they share on this machine (plans/amo-lan-platform.md, 2026-10-28):
//   %APPDATA%\AMO          account.json, platform.json, programs.json (later updates.json) — small, per Windows user
//   %LOCALAPPDATA%\AMO     the platform's Chromium profile; the programs it installs live in the platform's own folder
//                          (apps\<tool>\…, packages/platform/src/self-update.ts), here only for the development build
// AMO_HOME and AMO_LOCAL_HOME move either one (tests point them at temp folders, so a test run never touches the real
// ones); every file of the set follows the variable, not only the account. AMO_LOCAL_HOME also stands in for the
// platform's folder.

export type Env = Record<string, string | undefined>;

/** %APPDATA%\AMO, or AMO_HOME. */
export function amoHome(env: Env = process.env): string {
  if (env.AMO_HOME) return resolve(env.AMO_HOME);
  return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "AMO");
}

/** %LOCALAPPDATA%\AMO, or AMO_LOCAL_HOME. */
export function amoLocalHome(env: Env = process.env): string {
  if (env.AMO_LOCAL_HOME) return resolve(env.AMO_LOCAL_HOME);
  return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "AMO");
}

/** A file of the shared set: `amoFile("programs.json")`. */
export function amoFile(name: string, env: Env = process.env): string {
  return join(amoHome(env), name);
}

export const accountFile = (env: Env = process.env) => amoFile("account.json", env);
export const platformFile = (env: Env = process.env) => amoFile("platform.json", env);
export const programsFile = (env: Env = process.env) => amoFile("programs.json", env);
