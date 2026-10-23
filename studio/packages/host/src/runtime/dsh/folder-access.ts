import { execFile } from "node:child_process";
import { mkdirSync, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
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
  /** Gives the person inherited full control, the old permissions saved first; returns where they were saved. */
  grant(folder: string): Promise<string>;
  /** Labels the folder Low, passed on to all it holds, as DSH's grant will (a set-up folder is ready before DSH). */
  label(folder: string): Promise<void>;
  /**
   * Sets every program and library in the folder (IMAGE_KINDS) back to Medium (an explicit label, which DSH's later
   * grants leave alone) and returns how many there are. Never follows links or junctions; skips .git.
   */
  exes(folder: string): Promise<number>;
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

/**
 * What a Low label breaks when it is on the file: a program (.exe, .com) runs at Low, so cannot write outside the
 * project; a library (.dll, and .node, a Node / Electron native addon, which is one) is refused by Chromium's sandboxed
 * processes, so Electron in the project crashed its windows (2026-10-23). Scripts and data run or open through programs
 * elsewhere and are left as they are.
 */
export const IMAGE_KINDS = ["exe", "com", "dll", "node"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];
const IMAGE_RE = new RegExp(`\\.(${IMAGE_KINDS.join("|")})$`, "i");

/** The folders under `root` holding programs or libraries (IMAGE_KINDS), with how many of each kind. */
export async function findExes(root: string): Promise<Map<string, Partial<Record<ImageKind, number>>>> {
  const found = new Map<string, Partial<Record<ImageKind, number>>>();
  const stack = [root];
  let visited = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (e.name !== ".git") stack.push(join(dir, e.name));
      } else if (e.isFile()) {
        const kind = IMAGE_RE.exec(e.name)?.[1]?.toLowerCase() as ImageKind | undefined;
        if (!kind) continue;
        const n = found.get(dir) ?? {};
        n[kind] = (n[kind] ?? 0) + 1;
        found.set(dir, n);
      }
    }
    // A big project has tens of thousands of folders: let the Host answer meanwhile.
    if (++visited % 500 === 0) await new Promise((r) => setImmediate(r));
  }
  return found;
}

/** The real one, through `icacls`; old permissions go to `backupDir`. */
export function windowsFolderAccess(backupDir: string): FolderAccess {
  const user = userInfo().username;
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
  return {
    async check(folder) {
      try {
        return readIcacls(await icacls([folder]), folder, user);
      } catch {
        return null;
      }
    },
    async grant(folder) {
      mkdirSync(backupDir, { recursive: true });
      const backup = join(backupDir, `${folder.replace(/[:\\/]+/g, "_").replace(/^_+|_+$/g, "")}-${new Date().toISOString().replace(/[:.]/g, "-")}.acl`);
      // `icacls <parent> /restore <file>` puts them back.
      await icacls([folder, "/save", backup]);
      await icacls([folder, "/grant", `${account}:(OI)(CI)F`]);
      return backup;
    },
    async label(folder) {
      await icacls([folder, "/setintegritylevel", "(OI)(CI)low"]);
    },
    async exes(folder) {
      let count = 0;
      for (const [dir, n] of await findExes(folder)) {
        for (const kind of IMAGE_KINDS) {
          if (!n[kind]) continue;
          await icacls([join(dir, `*.${kind}`), "/setintegritylevel", "medium"]);
          count += n[kind];
        }
      }
      return count;
    },
  };
}
