import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";
import type { ClientManifest } from "@amo-studio/relay";

// The client's content as the desktop shell keeps it (its hot update): <home>/client/<version>/ holds one build,
// current.json names the one in use. Installing downloads the manifest's files into <version>.partial — reusing the
// files the current build already has with the same hash — checks every hash, then renames it into place and points
// current.json at it. Only the current build and the one before it are kept.

export interface InstalledContent {
  version: string;
  dir: string;
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const folderName = (version: string) => version.replace(/[^\w.+-]/g, "_");

/** A manifest path, kept inside its folder. */
function safePath(root: string, rel: string): string {
  const file = normalize(join(root, rel));
  if (!file.startsWith(root + sep)) throw new Error(`客户端清单里有不安全的路径：${rel}`);
  return file;
}

export class ContentStore {
  readonly root: string;

  constructor(home: string) {
    this.root = join(home, "client");
  }

  current(): InstalledContent | null {
    try {
      const { version } = JSON.parse(readFileSync(join(this.root, "current.json"), "utf8")) as { version: string };
      const dir = join(this.root, folderName(version));
      return existsSync(join(dir, "index.html")) ? { version, dir } : null;
    } catch {
      return null;
    }
  }

  async install(server: string, manifest: ClientManifest, onProgress: (done: number, total: number) => void = () => undefined): Promise<InstalledContent> {
    const target = join(this.root, folderName(manifest.version));
    const partial = `${target}.partial`;
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true });
    const current = this.current();
    const previous = new Map<string, string>();
    if (current) {
      try {
        const old = JSON.parse(readFileSync(join(current.dir, "manifest.json"), "utf8")) as ClientManifest;
        for (const f of old.files) previous.set(f.sha256, safePath(current.dir, f.path));
      } catch {
        // no manifest kept with it: download everything
      }
    }
    const total = manifest.files.reduce((n, f) => n + f.size, 0);
    let done = 0;
    onProgress(0, total);
    for (const f of manifest.files) {
      const file = safePath(partial, f.path);
      mkdirSync(dirname(file), { recursive: true });
      const reuse = previous.get(f.sha256);
      if (reuse && existsSync(reuse) && sha256(readFileSync(reuse)) === f.sha256) copyFileSync(reuse, file);
      else {
        const res = await fetch(`${server}/client/${f.path.split("/").map(encodeURIComponent).join("/")}`);
        if (!res.ok) throw new Error(`下载 ${f.path} 失败：HTTP ${res.status}`);
        const data = Buffer.from(await res.arrayBuffer());
        if (sha256(data) !== f.sha256) throw new Error(`${f.path} 校验不对，服务器上的客户端可能正在更新，稍后再试`);
        writeFileSync(file, data);
      }
      done += f.size;
      onProgress(done, total);
    }
    writeFileSync(join(partial, "manifest.json"), JSON.stringify(manifest, null, 2));
    rmSync(target, { recursive: true, force: true });
    renameSync(partial, target);
    writeFileSync(join(this.root, "current.json"), JSON.stringify({ version: manifest.version }));
    this.prune([manifest.version, current?.version].filter((v): v is string => !!v));
    return { version: manifest.version, dir: target };
  }

  private prune(keep: string[]): void {
    const names = new Set(keep.map(folderName));
    for (const name of readdirSync(this.root)) {
      if (name === "current.json" || names.has(name)) continue;
      rmSync(join(this.root, name), { recursive: true, force: true });
    }
  }
}

export async function fetchManifest(server: string, timeoutMs = 8000): Promise<ClientManifest> {
  const res = await fetch(`${server}/client/manifest.json`, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) throw new Error("服务器上还没有放客户端内容");
  if (!res.ok) throw new Error(`读取客户端版本失败：HTTP ${res.status}`);
  return (await res.json()) as ClientManifest;
}
