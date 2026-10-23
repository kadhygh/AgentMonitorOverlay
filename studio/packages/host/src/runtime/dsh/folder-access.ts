import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { constants, setPriority, userInfo } from "node:os";
import { join } from "node:path";

// DSH's write sandbox on Windows (2026-10-23): each session gives the project folder an entry for its own sandbox
// identity and a Low integrity label, and Windows passes both on to every subfolder. Setting the label needs the
// person's full control of the folder (the owner's own rights do not cover it), and passing it on needs full control
// of each subfolder. A folder where they only have 修改 (Modify), the usual case for a folder under a drive root,
// fails: DSH cannot start its sandbox (`SetNamedSecurityInfoW failed (Win32 5): grantWrite(…)`) and asks to run
// every command unsandboxed; or, with full control on the folder alone, only folders made later get the sandbox's
// right, and writes into the older ones are refused. The fix gives the person inherited full control of the folder.
// The sandbox is unchanged by it: the sandboxed commands run as DSH's own restricted identity, not as the person.

/** The folder DSH could not set up its sandbox on, from a failed command's output; null when it is not that error. */
export function grantFailurePath(text: string): string | null {
  const m = /SetNamedSecurityInfoW failed \(Win32 5\): grantWrite\(([^)\r\n]+)\)/.exec(text);
  return m ? m[1]! : null;
}

export interface FolderAccessState {
  /** Full control of the folder and, inherited, of what is in it: DSH's sandbox can be set up and passed on. */
  ok: boolean;
  /** DSH's Low label is on the folder already (a sandbox set it up there before). */
  labelled: boolean;
}

/** Trustees whose full control counts for the person: they themselves, or a group every signed-in person is in. */
const EVERYONE = new Set(["everyone", "nt authority\\authenticated users", "builtin\\users"]);

/**
 * Reads `icacls <folder>`: whether `user` has full control of the folder itself and, inherited (OI)(CI), of its
 * contents. Group rights other than the everyone-groups are not counted (Administrators is not in force unelevated).
 */
export function readIcacls(output: string, folder: string, user: string): FolderAccessState {
  let root = false;
  let inherited = false;
  let labelled = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = (raw.startsWith(folder) ? raw.slice(folder.length) : raw).trim();
    if (/Low Mandatory Level|S-1-16-4096/.test(line)) labelled = true;
    const m = /^(.+?):((?:\([^)]*\))+)$/.exec(line);
    if (!m) continue;
    const who = m[1]!.toLowerCase();
    const name = who.includes("\\") ? who.slice(who.lastIndexOf("\\") + 1) : who;
    if (name !== user.toLowerCase() && !EVERYONE.has(who)) continue;
    const flags = new Set(m[2]!.slice(1, -1).split(")("));
    if (!flags.has("F") || flags.has("DENY")) continue;
    if (!flags.has("IO")) root = true;
    if (flags.has("OI") && flags.has("CI")) inherited = true;
  }
  return { ok: root && inherited, labelled };
}

export interface FolderAccess {
  /** The folder's state; null when it cannot be read (or this is not Windows). */
  check(folder: string): Promise<FolderAccessState | null>;
  /** Gives the person inherited full control (the old permissions saved first) and passes DSH's label on; returns where they were saved. */
  fix(folder: string): Promise<{ state: FolderAccessState; backup: string }>;
}

function icacls(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("icacls", args, { windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stdout + stderr).trim().split(/\r?\n/).slice(-2).join(" ") || err.message));
      else resolve(stdout);
    });
    // Passing permissions on through a big project takes a while: it should not slow the person's work.
    try {
      if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // The priority is a courtesy.
    }
  });
}

/** The real one, through `icacls`; old permissions go to `backupDir`. */
export function windowsFolderAccess(backupDir: string): FolderAccess {
  const user = userInfo().username;
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
  const check = async (folder: string) => {
    try {
      return readIcacls(await icacls([folder]), folder, user);
    } catch {
      return null;
    }
  };
  return {
    check,
    async fix(folder) {
      mkdirSync(backupDir, { recursive: true });
      const backup = join(backupDir, `${folder.replace(/[:\\/]+/g, "_").replace(/^_+|_+$/g, "")}-${new Date().toISOString().replace(/[:.]/g, "-")}.acl`);
      // `icacls <parent> /restore <file>` puts them back.
      await icacls([folder, "/save", backup]);
      await icacls([folder, "/grant", `${account}:(OI)(CI)F`]);
      const before = await check(folder);
      // DSH set its label up on the folder alone before (its entry is passed on with the grant above; the label, in
      // another part of the permissions, is not): set again, it reaches the subfolders.
      if (before?.labelled) await icacls([folder, "/setintegritylevel", "(OI)(CI)low"]);
      const state = await check(folder);
      if (!state) throw new Error(`读不到 ${folder} 的权限`);
      return { state, backup };
    },
  };
}
