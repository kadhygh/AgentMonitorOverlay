import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { safeParts } from "./manifest.js";

// Starting a tool the platform installed, the way the tools already support (AGENTS.md, constraint 1): Studio gets
// AMO_STUDIO_DATA_DIR (its data stays outside the program folder, so an update never touches it); AMO 中转 gets the
// team server's address (--server, used when it has none saved); the Reviewer and the 便签 start as they are. Detached: closing the platform leaves them running. Started from the real version folder,
// not through `current`, so switching `current` later never finds a folder in use by them.

export interface LaunchSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export type LaunchPlan = { ok: true; spec: LaunchSpec } | { ok: false; reason: "need-studio-dir" | "not-installed"; message: string };

/** Environment the platform has that a tool must not inherit. */
const DROP = /^(ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|AMO_PLATFORM_.*|AMO_STUDIO_DATA_DIR)$/i;

/** The platform's environment without what a program it starts must not inherit (a tool, or the platform restarted). */
export function startEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !DROP.test(k)) out[k] = v;
  return out;
}

/** `server`: the team server the platform is logged in to; AMO 中转 is handed it with `--server`, which it only uses the
 * first time (no address saved yet), so nobody types it twice. Not the login: AMO 中转 still signs in by itself. */
export function planLaunch(tool: string, entry: { dir: string; exe: string } | undefined, options: { studioDataDir: string | null; env: Record<string, string | undefined>; name?: string; server?: string | null }): LaunchPlan {
  const name = options.name ?? tool;
  if (!entry) return { ok: false, reason: "not-installed", message: `${name} 还没装。` };
  if (tool === "studio" && !options.studioDataDir) return { ok: false, reason: "need-studio-dir", message: "先设好 Studio 数据目录，再打开 Studio。" };
  const parts = safeParts(entry.exe.replace(/\\/g, "/"));
  let dir: string;
  try {
    dir = realpathSync(entry.dir);
  } catch {
    return { ok: false, reason: "not-installed", message: `${name} 的程序文件夹不在了，重新安装一下。` };
  }
  const file = parts ? join(dir, ...parts) : "";
  if (!file || !existsSync(file)) return { ok: false, reason: "not-installed", message: `${name} 的主程序不在了，重新安装一下。` };
  const env = startEnv(options.env);
  if (tool === "studio") env.AMO_STUDIO_DATA_DIR = options.studioDataDir!;
  const args = tool === "relay" && options.server ? ["--server", options.server] : [];
  return { ok: true, spec: { file, args, cwd: dir, env } };
}

/** Starts it on its own; a .cmd/.bat (the tests' stand-in tools) goes through cmd.exe. */
export function startDetached(spec: LaunchSpec): Promise<void> {
  const script = /\.(cmd|bat)$/i.test(spec.file);
  const child = script
    ? spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${spec.file}"`, ...spec.args], { cwd: spec.cwd, env: spec.env, detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true })
    : spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, detached: true, stdio: "ignore" });
  child.unref();
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}
