import { existsSync, readFileSync, statSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { ZipMaker, type ZipLayout, type StoredObject } from "./platform-zip.js";

// The AMO platform's files on the relay service (2026-10-28, plans/amo-lan-platform.md 「第一版的接口约定」). The
// platform dir is outside the service's app/ (deploy never touches it) and is written only by the publisher
// (scripts/platform-publish.mjs, over SSH):
//   objects/<sha256 first two>/<sha256>   file contents by sha256, each stored once — as it is, or
//   objects/<sha256 first two>/<sha256>.gz   gzipped (2026-10-29: Studio's install was 375 MB); the sha256 is always the
//                                         original's. Sent as it is with Content-Encoding: gzip to a client that takes
//                                         gzip, unpacked on the way to one that does not (server.ts).
//   tools/<tool>/<version>.json           one tool's manifest for one version (sent minified and gzipped, and as a
//                                         summary without its file list: manifestServed, 2026-11-03)
//   channels.json                         { "stable": { "studio": "0.9.0", … }, "test": { … } }
//   downloads/AMO-Platform-win.zip        the platform itself for the download page, put by hand (2026-10-28); since
//                                         2026-11-03 only when no platform is published: the page's zip is made from
//                                         the newest published platform (platform-zip.ts), so each release updates it
//   android/latest.json, android/<name>.apk   the Android app's newest build (2026-10-31, relay-mac.mjs android-publish):
//                                         the app asks for it and installs it itself; not a platform tool (the
//                                         platform would offer it to install on Windows)
// The service only reads it, on each request. Every name taken from a URL is checked against the patterns below before
// it is joined to a path, and the result must still be under the platform dir.

/** Tool ids: lowercase words (studio, reviewer, notes, platform); the publisher checks the same. */
export const TOOL_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** Versions: 0.9.0, 0.9.1-test.2 — no slashes, no empty parts. */
export const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const PLATFORM_ZIP = "AMO-Platform-win.zip";
/** The Android app's file names: AMO-Studio-Android-0.1.1.apk. */
export const APK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.apk$/;

/** android/latest.json: what the app compares with itself (versionCode) and downloads (file, checked by size and sha256). */
export interface AndroidLatest {
  version: string;
  versionCode: number;
  file: string;
  size: number;
  sha256: string;
  notes: string;
  publishedAt: string;
}

export interface PlatformChannels {
  stable: Record<string, string>;
  test: Record<string, string>;
}

/** A manifest ready to send: minified, gzipped, and its summary (the manifest without `files`, with their count and size). */
export interface ServedManifest {
  json: Buffer;
  gzip: Buffer;
  summary: Record<string, unknown> & { fileCount: number; size: number };
}

/** Versions in order: 0.9.10 after 0.9.9; a version with a -suffix before the same one without. */
export function compareVersions(a: string, b: string): number {
  const [ma = "", pa] = a.split("-", 2);
  const [mb = "", pb] = b.split("-", 2);
  const na = ma.split(".").map(Number);
  const nb = mb.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((na[i] ?? 0) !== (nb[i] ?? 0)) return (na[i] ?? 0) - (nb[i] ?? 0);
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  return pa < pb ? -1 : 1;
}

/** The folder a tool's whole zip unpacks to (the platform's as the hand-made zip had it). */
export function zipRoot(tool: string): string {
  return tool === "platform" ? "AMO Platform" : `AMO-${tool}`;
}

/** Manifests kept made: a few tools' current and previous versions. */
const SERVED_KEPT = 12;

export class PlatformFiles {
  readonly dir: string | null;

  constructor(dir: string | undefined) {
    this.dir = dir ? resolve(dir) : null;
  }

  /** A file under the platform dir, never outside it; null when it is not there. */
  private file(...parts: string[]): string | null {
    if (!this.dir) return null;
    const file = resolve(this.dir, ...parts);
    return file.startsWith(this.dir + sep) && existsSync(file) && statSync(file).isFile() ? file : null;
  }

  /** channels.json; both channels empty before the first publish. */
  channels(): PlatformChannels {
    const file = this.file("channels.json");
    const raw = file ? (JSON.parse(readFileSync(file, "utf8")) as Partial<PlatformChannels>) : {};
    return { ...raw, stable: raw.stable ?? {}, test: raw.test ?? {} };
  }

  /** The manifest file of one tool's version, or null (also for a name that fails its pattern). */
  manifest(tool: string, version: string): string | null {
    if (!TOOL_ID.test(tool) || !VERSION.test(version)) return null;
    return this.file("tools", tool, `${version}.json`);
  }

  private readonly served = new Map<string, ServedManifest & { key: string }>();

  /**
   * A manifest as it is sent (2026-11-03, the user): without its indentation and gzipped (Studio's is 2.3 MB as
   * written, 0.53 MB so), and its summary — all but the file list — which the platform reads to show a version (the
   * list only when it installs). Made once per file and kept for the last few asked for (a republished file is made
   * again: its size and time are part of the key).
   */
  manifestServed(tool: string, version: string): ServedManifest | null {
    const file = this.manifest(tool, version);
    if (!file) return null;
    const st = statSync(file);
    const key = `${file}|${st.size}|${st.mtimeMs}`;
    const kept = this.served.get(file);
    if (kept?.key === key) {
      // Most recently used last.
      this.served.delete(file);
      this.served.set(file, kept);
      return kept;
    }
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> & { files?: Array<{ size?: number }> };
    const files = Array.isArray(value.files) ? value.files : [];
    const { files: _files, ...rest } = value;
    const json = Buffer.from(JSON.stringify(value));
    const made = { key, json, gzip: gzipSync(json), summary: { ...rest, fileCount: files.length, size: files.reduce((n, f) => n + (typeof f?.size === "number" ? f.size : 0), 0) } };
    this.served.delete(file);
    this.served.set(file, made);
    while (this.served.size > SERVED_KEPT) this.served.delete(this.served.keys().next().value!);
    return made;
  }

  /**
   * An object opened for sending: the .gz when there is one, else the file as it is; null when neither is there. Opened
   * rather than looked up, so platform-compress swapping one for the other (the .gz renamed in, then the original
   * removed) never leaves a request with a name that is gone: the original is tried after the .gz, and the .gz again.
   */
  async openObject(sha256: string): Promise<{ handle: FileHandle; size: number; gzip: boolean } | null> {
    if (!SHA256.test(sha256) || !this.dir) return null;
    const base = resolve(this.dir, "objects", sha256.slice(0, 2), sha256);
    if (!base.startsWith(this.dir + sep)) return null;
    const tryOpen = async (file: string) => {
      let handle: FileHandle;
      try {
        handle = await open(file, "r");
      } catch (err) {
        if (["ENOENT", "EISDIR"].includes((err as NodeJS.ErrnoException).code ?? "")) return null;
        throw err;
      }
      const st = await handle.stat();
      if (st.isFile()) return { handle, size: st.size };
      await handle.close();
      return null;
    };
    for (const [file, gzip] of [[`${base}.gz`, true], [base, false], [`${base}.gz`, true]] as const) {
      const got = await tryOpen(file);
      if (got) return { ...got, gzip };
    }
    return null;
  }

  /** The Android app's newest build, or null before the first publish (or when latest.json names a file not there). */
  androidLatest(): AndroidLatest | null {
    const file = this.file("android", "latest.json");
    if (!file) return null;
    const v = JSON.parse(readFileSync(file, "utf8")) as AndroidLatest;
    return typeof v.file === "string" && APK_NAME.test(v.file) && this.apk(v.file) ? v : null;
  }

  /** One of the Android app's builds, or null (also for a name that fails its pattern). */
  apk(name: string): string | null {
    return APK_NAME.test(name) ? this.file("android", name) : null;
  }

  /** Where an object is kept: its .gz when there is one, else the file as it is; null when neither is there. */
  objectFile(sha256: string): StoredObject | null {
    if (!SHA256.test(sha256)) return null;
    for (const [name, gzip] of [[`${sha256}.gz`, true], [sha256, false]] as const) {
      const file = this.file("objects", sha256.slice(0, 2), name);
      if (file) return { file, size: statSync(file).size, gzip };
    }
    return null;
  }

  private readonly zips = new ZipMaker();

  /**
   * A version's whole program as one zip (platform-zip.ts, 2026-11-03), laid out from its manifest and objects; null
   * when the version is not published. Throws when an object is missing or damaged.
   */
  async zipOf(tool: string, version: string): Promise<{ layout: ZipLayout; filename: string } | null> {
    const file = this.manifest(tool, version);
    if (!file) return null;
    const st = statSync(file);
    const m = JSON.parse(readFileSync(file, "utf8")) as { builtAt?: number; files?: Array<{ path: string; size: number; sha256: string }> };
    const root = zipRoot(tool);
    const layout = await this.zips.layout(`${file}|${st.size}|${st.mtimeMs}`, root, typeof m.builtAt === "number" ? m.builtAt : st.mtimeMs, m.files ?? [], async (sha) => this.objectFile(sha));
    return { layout, filename: tool === "platform" ? `AMO-Platform-win-${version}.zip` : `${root}-${version}.zip` };
  }

  /** The newest platform any channel points at (the download page offers it), or null. */
  newestPlatform(): string | null {
    const c = this.channels();
    const found = [c.test.platform, c.stable.platform].filter((v): v is string => typeof v === "string" && VERSION.test(v) && !!this.manifest("platform", v));
    return found.sort(compareVersions).pop() ?? null;
  }

  /** downloads/AMO-Platform-win.zip, when there is one. */
  zip(): string | null {
    return this.file("downloads", PLATFORM_ZIP);
  }
}
