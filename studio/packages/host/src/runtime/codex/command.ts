import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// Which Codex binary the Host runs. On this machine a bare `codex` resolves differently per caller: Node's spawn
// (no shell) finds the Codex desktop app's bundled codex.exe (0.144.x), while terminals run the npm package (0.161.x).
// The app-server must match the CLI the user attaches with `codex --remote`, so prefer the npm package explicitly.

export interface CodexCommand {
  command: string;
  /** Leading args before the Codex subcommand (e.g. the codex.js path when running through node). */
  prefixArgs: string[];
  /** Extra env needed to run the command (e.g. ELECTRON_RUN_AS_NODE when the host runs inside Electron). */
  env: Record<string, string>;
  /** Where the command came from, for logs and the settings UI. */
  source: "env" | "npm-global" | "path";
}

export function nodeRunner(scriptPath: string, source: CodexCommand["source"]): CodexCommand {
  // Inside Electron, process.execPath is electron.exe; ELECTRON_RUN_AS_NODE turns it into plain Node.
  const env: Record<string, string> = process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {};
  return { command: process.execPath, prefixArgs: [scriptPath], env, source };
}

function npmGlobalRoot(): string | null {
  try {
    // Fixed command string; npm is a .cmd shim on Windows, so it has to go through the shell.
    return execSync("npm root -g", { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

let cached: CodexCommand | undefined;

/**
 * Resolution order: AMO_STUDIO_CODEX (a codex.js or an executable), the global npm package @openai/codex,
 * then `codex` on PATH.
 */
export function resolveCodexCommand(env: NodeJS.ProcessEnv = process.env): CodexCommand {
  const explicit = env.AMO_STUDIO_CODEX;
  if (explicit) return explicit.endsWith(".js") ? nodeRunner(explicit, "env") : { command: explicit, prefixArgs: [], env: {}, source: "env" };
  if (cached) return cached;
  const root = npmGlobalRoot();
  const script = root ? join(root, "@openai", "codex", "bin", "codex.js") : null;
  cached = script && existsSync(script) ? nodeRunner(script, "npm-global") : { command: "codex", prefixArgs: [], env: {}, source: "path" };
  return cached;
}

export function codexVersion(cmd: CodexCommand = resolveCodexCommand()): string {
  return execFileSync(cmd.command, [...cmd.prefixArgs, "--version"], { encoding: "utf8", env: { ...process.env, ...cmd.env }, windowsHide: true }).trim();
}
