import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { RelayClientError, type RelayClient } from "./api.js";
import { MAX_FILE_BYTES, type RelayFile } from "./protocol.js";

// Saving a file of a session or a task on this machine, for an AI (2026-11-12, the user: amo-relay 里的 AI 也能拿到
// 附件 — relay_file_download, `amo-relay download`). relay_file_get only shows a text file's words; a picture or any
// other file the person sent had no way to reach the AI. The bytes go to a folder outside every program folder
// (AGENTS.md rule 2): the system's temp folder by default, one folder per fileId so the file keeps its own name (what
// the AI's tools go by to open it) and two files of the same name never meet; or a folder the AI names.

/** Where downloads go when no folder is given: %TEMP%\amo-relay-files\<fileId>\<name>. */
export const downloadsDir = () => join(tmpdir(), "amo-relay-files");

/** At most what the service takes in an upload (MAX_FILE_BYTES); a bigger file is refused before a byte is read. */
export const DOWNLOAD_MAX_BYTES = MAX_FILE_BYTES;

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * A name that is one file inside the folder on every system: no folder parts, no characters Windows refuses, not a
 * device name, no dots or spaces at the end, not too long (the extension kept). The service cleans names on upload
 * already; this does not count on it.
 */
export function safeFileName(name: string): string {
  let s = name.split(/[\\/]/).pop() ?? "";
  s = s.replace(/[:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").trim();
  if (!s || /^\.+$/.test(s)) s = "file";
  if (RESERVED.test(s)) s = `_${s}`;
  if (s.length > 120) {
    const ext = extname(s).slice(0, 20);
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s;
}

export interface Downloaded {
  file: RelayFile;
  /** The full local path. */
  path: string;
  data: Uint8Array;
  /** The file was there already with the same bytes (sha256): not fetched again. */
  reused: boolean;
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Inside `folder`, never above it, whatever the name says. */
function inside(folder: string, name: string): string {
  const path = resolve(folder, name);
  const rel = relative(folder, path);
  // The first part, not the start: 「.._x.txt」 is a name in the folder, 「..\x.txt」 is not.
  if (!rel || rel.split(/[\\/]/)[0] === ".." || rel.split(/[\\/]/).length > 1 || isAbsolute(rel)) throw new RelayClientError(400, "bad_name", `文件名不能用：${name}`);
  return path;
}

/** The same bytes as the service's (by sha256) already at `path`. */
function same(path: string, file: RelayFile): Uint8Array | null {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size !== file.size) return null;
  const data = readFileSync(path);
  return sha256(data) === file.sha256 ? data : null;
}

/**
 * Saves one file (a version: its own fileId) the person's account can open — a session's of theirs, or a task's — and
 * says where. Refused when over `maxBytes`, when the service does not know the id, or when it is not theirs to see (the
 * service checks, as for the person's own client). The bytes are checked against the service's sha256.
 */
export async function downloadFile(client: RelayClient, fileId: string, opts: { dir?: string; maxBytes?: number } = {}): Promise<Downloaded> {
  const max = opts.maxBytes ?? DOWNLOAD_MAX_BYTES;
  const file = (await client.versions(fileId)).find((v) => v.id === fileId);
  if (!file) throw new RelayClientError(404, "not_found", `没有这个文件：${fileId}`);
  if (file.size > max) throw new RelayClientError(413, "too_large", `${file.name} 有 ${mb(file.size)}，超过下载上限 ${mb(max)}，没有下载。请让发的人换成小一点的文件，或者在中转客户端里自己打开。`);
  const folder = resolve(opts.dir?.trim() ? opts.dir.trim() : join(downloadsDir(), /^[\w-]{1,64}$/.test(file.id) ? file.id : file.sha256.slice(0, 16)));
  const name = safeFileName(file.name);
  let path = inside(folder, name);
  const had = same(path, file);
  if (had) return { file, path, data: had, reused: true };
  // In a folder the AI named, a different file of the same name is someone's: kept, this one gets 「名字 (2).png」.
  if (existsSync(path)) {
    const ext = extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 2; ; n++) {
      path = inside(folder, `${stem} (${n})${ext}`);
      const again = same(path, file);
      if (again) return { file, path, data: again, reused: true };
      if (!existsSync(path)) break;
    }
  }
  const data = await client.fileBytes(file.id, max);
  if (data.byteLength !== file.size || sha256(data) !== file.sha256) throw new RelayClientError(502, "corrupt", `下载的 ${file.name} 和服务上记的不一致（大小或校验和不对），没有保存。可以再试一次。`);
  mkdirSync(folder, { recursive: true });
  const tmp = `${path}.${process.pid}.part`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
  return { file, path, data, reused: false };
}

const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
