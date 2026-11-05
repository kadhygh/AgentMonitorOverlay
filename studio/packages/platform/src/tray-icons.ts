import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";
import { compareVersions, isVersion } from "./manifest.js";
import { powershell } from "./system.js";

// 托盘图标拖出来了，下次又折叠回去 (2026-11-06, the user). Windows 11 remembers "show in the taskbar" per program path
// (HKCU\Control Panel\NotifyIconSettings\<id>: ExecutablePath, UID, IsPromoted), and every version the platform installs
// runs from its own folder (apps\<tool>\<version>\, launch.ts), so each update is a new program to Windows, its icon
// back in the overflow. Running through `current` would keep the path but has a newer version's files under an older
// running one (its helper processes start from the exe's path) — so instead the platform carries the choice over: the
// newest version's entry, while the user has not decided on it, gets what they last decided on an older one. Only ever
// "promoted" is carried (folded is Windows' default anyway), and an entry with its own IsPromoted is left alone.
// Explorer picks the value up at once (tried 2026-11-06: 0 and back to 1 moved the icon out and in without a restart).

export interface TrayIconEntry {
  /** The subkey's name under NotifyIconSettings. */
  key: string;
  /** ExecutablePath as Windows wrote it (a known folder may be a {GUID} prefix). */
  exe: string;
  uid: string;
  /** IsPromoted: 1 shown in the taskbar, 0 folded, null never decided. */
  promoted: number | null;
}

const KEY = "HKCU:\\Control Panel\\NotifyIconSettings";

/** The known folders Windows writes as {GUID}\… in ExecutablePath, back to the folder (only those a root could be in). */
export function expandKnownFolder(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const m = /^\{([0-9A-Fa-f-]{36})\}(.*)$/.exec(path);
  if (!m) return path;
  const folders: Record<string, string | undefined> = {
    "6D809377-6AF0-444B-8957-A3773F02200E": env.ProgramW6432 ?? env.ProgramFiles,
    "7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E": env["ProgramFiles(x86)"],
  };
  const dir = folders[m[1]!.toUpperCase()];
  return dir ? dir + m[2] : path;
}

/**
 * Which entries to set promoted: per program of the platform's folder (apps\<tool>\<version>\<exe>, and the entry
 * <root>\<exe> as the platform, `outerVersion` its version when known), the newest version's entry when it has no
 * IsPromoted and the newest older entry that has one says 1.
 */
export function promotionsToCarry(entries: readonly TrayIconEntry[], root: string, outerVersion: string | null = null, env: NodeJS.ProcessEnv = process.env): TrayIconEntry[] {
  const prefix = (resolve(root) + sep).toLowerCase();
  const groups = new Map<string, { entry: TrayIconEntry; version: string | null }[]>();
  for (const entry of entries) {
    const exe = expandKnownFolder(entry.exe, env);
    if (!exe.toLowerCase().startsWith(prefix)) continue;
    const parts = exe.slice(prefix.length).split(/[\\/]/);
    let group: string;
    let version: string | null;
    if (parts.length === 4 && parts[0]!.toLowerCase() === "apps" && isVersion(parts[2]!)) {
      group = `${parts[1]}|${parts[3]}`;
      version = parts[2]!;
    } else if (parts.length === 1) {
      group = `platform|${parts[0]}`;
      version = outerVersion;
    } else continue;
    const id = `${group}|${entry.uid}`.toLowerCase();
    groups.set(id, [...(groups.get(id) ?? []), { entry, version }]);
  }
  const out: TrayIconEntry[] = [];
  for (const list of groups.values()) {
    // Newest first; the entry of an unknown version last (it only ever lends its choice).
    list.sort((a, b) => (a.version === null ? (b.version === null ? 0 : 1) : b.version === null ? -1 : compareVersions(b.version, a.version)));
    const [newest, ...older] = list;
    if (!newest || newest.version === null || newest.entry.promoted !== null) continue;
    if (older.find((o) => o.entry.promoted !== null)?.entry.promoted === 1) out.push(newest.entry);
  }
  return out;
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((done) => {
    // One script on stdin, not an encoded command (system.ts: an antivirus took encoded PowerShell for a trojan).
    const child = spawn(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
    child.on("error", () => done(""));
    child.on("close", () => done(out));
    child.stdin.on("error", () => undefined);
    child.stdin.end(script);
  });
}

/** Every NotifyIconSettings entry of this user (UTF-8, so folders with Chinese names come through). */
export async function readTrayIconEntries(): Promise<TrayIconEntry[]> {
  if (process.platform !== "win32") return [];
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-ChildItem -LiteralPath '${KEY}' -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty -LiteralPath $_.PSPath; if ($p.ExecutablePath) { "$($_.PSChildName)\`t$($p.UID)\`t$($p.IsPromoted)\`t$($p.ExecutablePath)" } }\n`;
  const out = await runPowerShell(script);
  return out.split(/\r?\n/).flatMap((line) => {
    const [key, uid, promoted, ...exe] = line.split("\t");
    if (!key || !/^\d+$/.test(key) || !exe.length) return [];
    return [{ key, uid: uid ?? "", promoted: promoted === "" || promoted === undefined ? null : Number(promoted), exe: exe.join("\t") }];
  });
}

/** Carries "shown in the taskbar" over to the newest versions' icons (see the top); what was set, by program path. */
export async function carryTrayPromotions(root: string, outerVersion: string | null): Promise<string[]> {
  const todo = promotionsToCarry(await readTrayIconEntries(), root, outerVersion).filter((e) => /^\d+$/.test(e.key));
  if (!todo.length) return [];
  await runPowerShell(todo.map((e) => `Set-ItemProperty -LiteralPath '${KEY}\\${e.key}' -Name IsPromoted -Value 1 -Type DWord -ErrorAction SilentlyContinue\n`).join(""));
  return todo.map((e) => e.exe);
}
