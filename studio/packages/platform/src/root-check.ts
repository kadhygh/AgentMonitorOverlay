import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Whether the platform's folder (self-update.ts's root) can hold the tools (2026-10-28, the user: no administrator
// rights — unpacked somewhere it cannot write, like Program Files, it says to move the folder). Network and removable
// drives work but are said too: hard links may not work there (every tool then copies the shared Electron files), and
// the tools stop opening when the drive goes away.

export type RootDrive = "local" | "network" | "removable" | "unknown";

export interface RootCheck {
  writable: boolean;
  drive: RootDrive;
}

/** Whether a file can be made in `root` (made, if it is not there yet): a small file written and removed again. */
export function rootWritable(root: string): boolean {
  const probe = join(root, `.amo-write-check-${process.pid}-${Date.now().toString(36)}`);
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * UNC paths are network shares; a drive letter's kind is what Windows says of it (`reported`: fsutil's line, "G: - Fixed
 * Drive" / "Z: - Remote/Network Drive", or .NET's DriveType, "Fixed" / "Network"; English or Chinese).
 */
export function driveKind(path: string, reported: string | null): RootDrive {
  const p = path.replace(/^\\\\\?\\/, "");
  if (/^UNC\\/i.test(p) || /^\\\\/.test(p)) return "network";
  const r = (reported ?? "").replace(/^\s*[A-Za-z]:\s*-\s*/, "").trim().toLowerCase();
  if (!r) return "unknown";
  if (/network|remote|网络|远程/.test(r)) return "network";
  if (/removable|可移动/.test(r)) return "removable";
  if (/fixed|cd-?rom|ram|固定|光盘/.test(r)) return "local";
  return "unknown";
}

/** Runs a program, its output (null when it fails or takes over 5 s). */
function output(file: string, args: string[], stdin: string | null): Promise<string | null> {
  return new Promise((done) => {
    const child = spawn(file, args, { windowsHide: true, stdio: [stdin === null ? "ignore" : "pipe", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill(), 5000);
    child.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.on("error", () => (clearTimeout(timer), done(null)));
    child.on("close", (code) => (clearTimeout(timer), done(code === 0 ? out.trim() || null : null)));
    if (stdin !== null) {
      child.stdin!.on("error", () => undefined);
      child.stdin!.end(stdin);
    }
  });
}

function powershell(): string {
  const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const full = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(full) ? full : "powershell.exe";
}

/** The drive the root is on: fsutil first (a few ms, no rights needed for drivetype), else .NET's DriveType through PowerShell. */
export async function rootDrive(root: string): Promise<RootDrive> {
  if (driveKind(root, null) === "network") return "network";
  const letter = /^(?:\\\\\?\\)?([A-Za-z]):/.exec(root)?.[1];
  if (process.platform !== "win32" || !letter) return "unknown";
  const system = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const fsutil = join(system, "System32", "fsutil.exe");
  const quick = driveKind(root, existsSync(fsutil) ? await output(fsutil, ["fsinfo", "drivetype", `${letter}:`], null) : null);
  if (quick !== "unknown") return quick;
  // One line on stdin, not an encoded command (10-28: an antivirus took encoded PowerShell in AMO for a trojan).
  return driveKind(root, await output(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], `([System.IO.DriveInfo]::new('${letter}:\\')).DriveType.ToString()\n`));
}
