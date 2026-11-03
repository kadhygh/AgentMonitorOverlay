import { spawn } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Source } from "./client.js";
import { PlatformError, safeParts, type Manifest } from "./manifest.js";

// 用完整包 (2026-11-03, the user: when 更新平台 gets stuck there should be a way out from the platform itself, not only
// the download page): the version's whole zip (client.downloadPackage) is unpacked with Windows' own tar (bsdtar, in
// System32 since Windows 10 1803), and the installer takes its files from the unpacked folder as if it downloaded them
// — so each is checked against the manifest's size and sha256, and the version is put together, switched to and
// recorded exactly as an update is (installer.ts, fresh: nothing linked from the tools' files).

/** Windows' own tar, or null when this Windows has none. */
export function systemTar(env: NodeJS.ProcessEnv = process.env): string | null {
  const file = join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "tar.exe");
  return existsSync(file) ? file : null;
}

/** Unpacks `zip` into `dir` (made when missing) with Windows' tar. */
export function unpackZip(zip: string, dir: string, tar: string | null = systemTar()): Promise<void> {
  if (!tar) return Promise.reject(new PlatformError("io", `这台电脑上没有 Windows 自带的 tar（Windows 10 1803 以后才有），解压不了 ${zip}`));
  mkdirSync(dir, { recursive: true });
  return new Promise((done, fail) => {
    const child = spawn(tar, ["-xf", zip, "-C", dir], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err = (err + d).slice(-2000)));
    child.on("error", (e) => fail(new PlatformError("io", `解压完整包没成功（${e.message}）`)));
    child.on("close", (code) => (code === 0 ? done() : fail(new PlatformError("io", `解压完整包没成功（tar 退出码 ${code}${err.trim() ? `：${err.trim()}` : ""}）`))));
  });
}

/** The program's folder in what a zip unpacked to: its one folder (the zip has `AMO Platform/…`), or the folder itself. */
export function unpackedRoot(dir: string): string {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.length === 1 && entries[0]!.isDirectory() ? join(dir, entries[0]!.name) : dir;
}

/** A Source whose files are those of an unpacked package (hard-linked, or copied where links do not work). */
export function packageSource(manifest: Manifest, root: string): Source {
  const bySha = new Map<string, string[]>();
  for (const f of manifest.files) if (!bySha.has(f.sha256)) bySha.set(f.sha256, safeParts(f.path) ?? []);
  return {
    manifest: async () => manifest,
    download: async (sha256, dest, onBytes) => {
      const parts = bySha.get(sha256);
      const from = parts?.length ? join(root, ...parts) : null;
      if (!from || !existsSync(from)) throw new PlatformError("checksum", `完整包里少了 ${parts?.join("/") ?? sha256.slice(0, 12)}`);
      try {
        linkSync(from, dest);
      } catch {
        copyFileSync(from, dest);
      }
      onBytes(statSync(dest).size);
    },
  };
}
