import { execFileSync, execSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
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

/** The npm package's own platform binary, as its bin/codex.js would pick it (Windows x64 / arm64 only). */
const PLATFORM_PACKAGE: Record<string, string> = { "win32-x64": "codex-win32-x64", "win32-arm64": "codex-win32-arm64" };
const TARGET: Record<string, string> = { "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc" };

/**
 * Runs the native codex.exe directly instead of through bin/codex.js: the script spawns the binary without hiding
 * its window, so from the windowless Host every app-server start flashed a console window. The env matches what the
 * script sets.
 */
export function npmNativeCommand(root: string, key = `${process.platform}-${process.arch}`): CodexCommand | null {
  const pkg = PLATFORM_PACKAGE[key];
  const triple = TARGET[key];
  if (!pkg || !triple) return null;
  const codexRoot = join(root, "@openai", "codex");
  for (const base of [join(root, "@openai", pkg), join(codexRoot, "node_modules", "@openai", pkg)]) {
    const exe = join(base, "vendor", triple, "bin", "codex.exe");
    if (existsSync(exe)) {
      return { command: exe, prefixArgs: [], env: { CODEX_MANAGED_PACKAGE_ROOT: existsSync(codexRoot) ? realpathSync(codexRoot) : codexRoot, CODEX_MANAGED_BY_NPM: "1" }, source: "npm-global" };
    }
  }
  return null;
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
  const native = root && script && existsSync(script) ? npmNativeCommand(root) : null;
  cached = native ?? (script && existsSync(script) ? nodeRunner(script, "npm-global") : { command: "codex", prefixArgs: [], env: {}, source: "path" });
  return cached;
}

export function codexVersion(cmd: CodexCommand = resolveCodexCommand()): string {
  return execFileSync(cmd.command, [...cmd.prefixArgs, "--version"], { encoding: "utf8", env: { ...process.env, ...cmd.env }, windowsHide: true }).trim();
}
