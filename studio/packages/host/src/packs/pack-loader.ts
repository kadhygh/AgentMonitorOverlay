import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { PACK_LIMITS, PACK_MANIFEST, PACKS_DIR, safeRelativePath, validatePackManifest, type PackDocContent, type WorkspacePack } from "@amo-studio/protocol";

// Reads extension packs from a workspace (`.amo/packs/<name>/pack.json`). Packs are untrusted project files: only read,
// with every path resolved through symbolic links and checked to stay inside its base. Manifests are cached by
// modification time; documents are read fresh.

export class PackError extends Error {
  constructor(
    readonly kind: "not_found" | "bad_request",
    message: string,
  ) {
    super(message);
  }
}

/** `base/rel` with links resolved, or null when it does not exist or ends up outside `base`. */
export function resolveInside(base: string, rel: string): string | null {
  const safe = safeRelativePath(rel);
  if (!safe) return null;
  let real: string;
  let realBase: string;
  try {
    realBase = realpathSync(base);
    real = realpathSync(resolve(base, safe));
  } catch {
    return null;
  }
  const r = relative(realBase, real);
  return r && !r.startsWith("..") && !isAbsolute(r) ? real : null;
}

interface Cached {
  mtimeMs: number;
  size: number;
  pack: WorkspacePack;
}

export class PackLoader {
  private readonly cache = new Map<string, Cached>();

  /** The packs of a workspace, valid or not, by directory name. */
  list(workspacePath: string): WorkspacePack[] {
    const root = resolveInside(workspacePath, PACKS_DIR);
    if (!root) return [];
    let dirs: string[];
    try {
      dirs = readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() || d.isSymbolicLink())
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
    return dirs.slice(0, PACK_LIMITS.packs).flatMap((name) => {
      const dir = resolveInside(root, name);
      return dir && statSync(dir).isDirectory() ? [this.load(name, dir)] : [];
    });
  }

  /** One document of a valid pack, size-limited. */
  readDoc(workspacePath: string, packName: string, docId: string): PackDocContent {
    const pack = this.list(workspacePath).find((p) => p.dirName === packName);
    if (!pack) throw new PackError("not_found", `扩展包 ${packName} 不存在`);
    if (!pack.manifest) throw new PackError("bad_request", `扩展包 ${packName} 有错误：${pack.errors[0] ?? ""}`);
    const doc = pack.manifest.docs.find((d) => d.id === docId);
    if (!doc) throw new PackError("not_found", `扩展包 ${packName} 里没有文档 ${docId}`);
    const file = resolveInside(pack.dir, doc.path);
    if (!file || !statSync(file).isFile()) throw new PackError("not_found", `文档 ${doc.path} 不存在，或指到了扩展包外面`);
    const size = statSync(file).size;
    if (size > PACK_LIMITS.docBytes) throw new PackError("bad_request", `文档 ${doc.path} 太大（${size} 字节，最多 ${PACK_LIMITS.docBytes}）`);
    return { pack: packName, id: doc.id, title: doc.title, path: doc.path, text: readFileSync(file, "utf8") };
  }

  private load(dirName: string, dir: string): WorkspacePack {
    const file = join(dir, PACK_MANIFEST);
    const broken = (error: string): WorkspacePack => ({ dirName, dir, manifest: null, errors: [error], warnings: [] });
    if (!existsSync(file)) return broken(`缺少 ${PACK_MANIFEST}`);
    const real = resolveInside(dir, PACK_MANIFEST);
    if (!real) return broken(`${PACK_MANIFEST} 指到了扩展包外面`);
    const st = statSync(real);
    if (!st.isFile()) return broken(`${PACK_MANIFEST} 不是文件`);
    if (st.size > PACK_LIMITS.manifestBytes) return broken(`${PACK_MANIFEST} 太大（${st.size} 字节，最多 ${PACK_LIMITS.manifestBytes}）`);
    const pack = this.parse(dirName, dir, real, st);
    if (!pack.manifest) return pack;
    // Documents can appear or go away without the manifest changing, so this part is not cached.
    const missing = pack.manifest.docs.flatMap((d, i) => (resolveInside(dir, d.path) ? [] : [`docs[${i}]: 文件 ${d.path} 不存在，或指到了扩展包外面`]));
    return missing.length ? { ...pack, warnings: [...pack.warnings, ...missing] } : pack;
  }

  private parse(dirName: string, dir: string, file: string, st: { mtimeMs: number; size: number }): WorkspacePack {
    const cached = this.cache.get(dir);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.pack;
    let pack: WorkspacePack;
    try {
      const v = validatePackManifest(JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")));
      if (!v.ok) pack = { dirName, dir, manifest: null, errors: v.errors, warnings: v.warnings };
      else {
        const warnings = v.manifest.name === dirName ? v.warnings : [...v.warnings, `name "${v.manifest.name}" 和目录名 "${dirName}" 不同`];
        pack = { dirName, dir, manifest: v.manifest, errors: [], warnings };
      }
    } catch (err) {
      pack = { dirName, dir, manifest: null, errors: [`${PACK_MANIFEST} 不是有效的 JSON：${(err as Error).message}`], warnings: [] };
    }
    this.cache.set(dir, { mtimeMs: st.mtimeMs, size: st.size, pack });
    return pack;
  }
}
