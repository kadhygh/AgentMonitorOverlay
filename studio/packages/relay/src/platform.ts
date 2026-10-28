import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

// The AMO platform's files on the relay service (2026-10-28, plans/amo-lan-platform.md 「第一版的接口约定」). The
// platform dir is outside the service's app/ (deploy never touches it) and is written only by the publisher
// (scripts/platform-publish.mjs, over SSH):
//   objects/<sha256 first two>/<sha256>   file contents by sha256, each stored once
//   tools/<tool>/<version>.json           one tool's manifest for one version
//   channels.json                         { "stable": { "studio": "0.9.0", … }, "test": { … } }
//   downloads/AMO-Platform-win.zip        the platform itself for the download page (optional; here because deploy
//                                         replaces app/downloads)
// The service only reads it, on each request. Every name taken from a URL is checked against the patterns below before
// it is joined to a path, and the result must still be under the platform dir.

/** Tool ids: lowercase words (studio, reviewer, notes, platform); the publisher checks the same. */
export const TOOL_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** Versions: 0.9.0, 0.9.1-test.2 — no slashes, no empty parts. */
export const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const PLATFORM_ZIP = "AMO-Platform-win.zip";

export interface PlatformChannels {
  stable: Record<string, string>;
  test: Record<string, string>;
}

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

  object(sha256: string): string | null {
    if (!SHA256.test(sha256)) return null;
    return this.file("objects", sha256.slice(0, 2), sha256);
  }

  /** downloads/AMO-Platform-win.zip, when there is one. */
  zip(): string | null {
    return this.file("downloads", PLATFORM_ZIP);
  }
}
