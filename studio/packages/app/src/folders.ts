import { execFile } from "node:child_process";
import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { win32 } from "node:path";
import { ipcMain } from "electron";

// Studio's own folder picker (2026-10-25, in place of the system dialog): the system dialog loads every Explorer
// extension and blocked for good — with the main window, which it is modal to — on a disconnected NAS drive that
// TortoiseGit's overlay asked about. This side lists, makes and renames folders for the page, only on this
// machine's own disks (no network drive or UNC path is ever touched), and gives up on any call that takes too long.

export type FolderResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface FolderListing {
  /** The folder, absolute, a drive as "G:\". */
  path: string;
  /** null at a drive's root. */
  parent: string | null;
  /** Its folders' names, sorted as Explorer shows them. */
  folders: string[];
}

const TIMEOUT_MS = 5000;

export class FolderError extends Error {}

function withTimeout<T>(work: Promise<T>, what: string, ms = TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FolderError(`${what}超过 ${ms / 1000} 秒没有响应`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The fixed disks' roots ("C:\" …). Asked of .NET's DriveInfo, which reads each letter's type without touching it. */
export function readLocalDrives(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "[IO.DriveInfo]::GetDrives() | Where-Object DriveType -eq 'Fixed' | ForEach-Object Name"],
      { timeout: TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        const drives = err ? [] : stdout.split(/\r?\n/).map((l) => l.trim().toUpperCase()).filter((l) => /^[A-Z]:\\$/.test(l));
        // Without the list, at least the system's own disk.
        resolve(drives.length ? drives : [`${(process.env.SystemDrive ?? "C:").toUpperCase()}\\`]);
      },
    );
  });
}

/** The absolute folder `path` names, when it is on one of `drives`; a FolderError otherwise. */
export function localPath(path: string, drives: readonly string[]): string {
  const raw = path.trim().replace(/\//g, "\\");
  if (raw.startsWith("\\\\")) throw new FolderError("只能选本机硬盘上的文件夹，网络路径不行");
  if (!/^[a-zA-Z]:(\\|$)/.test(raw)) throw new FolderError("请写完整路径，比如 G:\\PROJECT");
  const full = win32.resolve(raw.length === 2 ? `${raw}\\` : raw);
  const drive = full.slice(0, 3).toUpperCase();
  if (!drives.includes(drive)) throw new FolderError(`${drive.slice(0, 2)} 不是本机硬盘（网络盘、U 盘和光驱都不列）`);
  return drive + full.slice(3);
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A folder name Windows accepts, trimmed; a FolderError saying why not. */
export function folderName(name: string): string {
  const n = name.trim();
  if (!n) throw new FolderError("名字不能为空");
  if (n === "." || n === "..") throw new FolderError("不能用这个名字");
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(n)) throw new FolderError('名字里不能有 \\ / : * ? " < > |');
  if (n.endsWith(".")) throw new FolderError("名字不能以点结尾");
  if (RESERVED.test(n)) throw new FolderError(`${n} 是 Windows 保留的名字`);
  if (n.length > 200) throw new FolderError("名字太长了");
  return n;
}

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
/** As Explorer shows them: names starting with a digit or Latin letter first, then the rest (Chinese by pinyin). */
const ascii = (name: string) => /^[\x20-\x7e]/.test(name);
const byName = (a: string, b: string) => Number(ascii(b)) - Number(ascii(a)) || collator.compare(a, b);
/** Windows' own bookkeeping folders on a drive's root, never a project. */
const HIDDEN_AT_ROOT = new Set(["$recycle.bin", "system volume information", "recovery", "config.msi", "$windows.~ws", "$windows.~bt", "$winreagent", "msocache"]);

function explain(err: unknown, what: string): string {
  if (err instanceof FolderError) return err.message;
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return `${what}：文件夹不存在`;
  if (code === "EEXIST") return `${what}：已经有同名的文件夹`;
  if (code === "EACCES" || code === "EPERM") return `${what}：没有权限，或者文件夹正被别的程序占用`;
  if (code === "EBUSY") return `${what}：文件夹正被别的程序占用`;
  if (code === "ENOTDIR") return `${what}：这不是文件夹`;
  return `${what}：${err instanceof Error ? err.message : String(err)}`;
}

export async function listFolders(path: string, drives: readonly string[]): Promise<FolderListing> {
  const full = localPath(path, drives);
  const entries = await withTimeout(readdir(full, { withFileTypes: true }), "读取文件夹");
  const atRoot = full.length === 3;
  // Junctions and links to folders count too; where they lead is only read when someone opens them.
  const folders = entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => e.name)
    .filter((n) => !(atRoot && (HIDDEN_AT_ROOT.has(n.toLowerCase()) || n.startsWith("$"))))
    .sort(byName);
  return { path: full, parent: atRoot ? null : win32.dirname(full), folders };
}

/** Makes `name` in `parent`; its path. */
export async function makeFolder(parent: string, name: string, drives: readonly string[]): Promise<string> {
  const target = win32.join(localPath(parent, drives), folderName(name));
  await withTimeout(mkdir(target), "新建文件夹");
  return target;
}

/** Renames the folder at `path` to `name`, in the same place; its new path. A change of case only is allowed. */
export async function renameFolder(path: string, name: string, drives: readonly string[]): Promise<string> {
  const from = localPath(path, drives);
  if (from.length === 3) throw new FolderError("磁盘本身不能改名");
  const next = folderName(name);
  const to = win32.join(win32.dirname(from), next);
  if (to === from) return from;
  if (to.toLowerCase() !== from.toLowerCase()) {
    const taken = await withTimeout(stat(to).then(() => true, () => false), "改名");
    if (taken) throw new FolderError("已经有同名的文件夹");
  }
  await withTimeout(rename(from, to), "改名");
  return to;
}

async function result<T>(what: string, work: () => Promise<T>): Promise<FolderResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (err) {
    return { ok: false, error: explain(err, what) };
  }
}

/** The page's amo:folders-* calls. The disk list is read once and again when the page asks to refresh it. */
export function installFolderIpc(): void {
  let drives: Promise<string[]> | null = null;
  const known = (refresh = false) => (drives && !refresh ? drives : (drives = readLocalDrives()));
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  ipcMain.handle("amo:folders-drives", (_e, refresh?: unknown) => result("读取磁盘", () => known(refresh === true)));
  ipcMain.handle("amo:folders-list", async (_e, path: unknown) => result("读取文件夹", async () => listFolders(str(path), await known())));
  ipcMain.handle("amo:folders-create", async (_e, parent: unknown, name: unknown) => result("新建文件夹", async () => makeFolder(str(parent), str(name), await known())));
  ipcMain.handle("amo:folders-rename", async (_e, path: unknown, name: unknown) => result("改名", async () => renameFolder(str(path), str(name), await known())));
}
