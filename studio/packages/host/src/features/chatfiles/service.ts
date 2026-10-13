import { stat } from "node:fs/promises";
import path from "node:path";
import { MAX_EXISTS_PATHS, type ExistingPath, type FsExistsRequest, type FsExistsResult } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

type PathApi = Pick<typeof path, "isAbsolute" | "join" | "normalize">;

/**
 * Files named in a conversation (stage 12, S12-C): tells which of the paths a reply, a tool row or a file chip names
 * exist, so the UI only links those. Never reads the files; network shares are not looked at (they can stall).
 */
export class ChatFilesFeature extends Feature {
  async exists(input: Partial<FsExistsRequest>): Promise<FsExistsResult> {
    if (!Array.isArray(input.paths) || !input.paths.every((p) => typeof p === "string")) throw new HostError("bad_request", "paths must be a list of strings");
    if (input.paths.length > MAX_EXISTS_PATHS) throw new HostError("bad_request", `at most ${MAX_EXISTS_PATHS} paths at once`);
    let base: string | null = null;
    if (typeof input.cwd === "string" && input.cwd.trim() && path.isAbsolute(input.cwd.trim())) base = input.cwd.trim();
    else if (typeof input.workspaceId === "string" && input.workspaceId) base = this.requireWorkspace(input.workspaceId).path;
    const found: Record<string, ExistingPath | null> = {};
    await Promise.all(
      [...new Set(input.paths)].map(async (p) => {
        const abs = resolveMentioned(p, base);
        const info = abs ? await stat(abs).catch(() => null) : null;
        found[p] = abs && info ? { path: abs, dir: info.isDirectory() } : null;
      }),
    );
    return { found };
  }
}

/**
 * Where a path written in a conversation points: absolute (also `file://…`) as is, relative ones from `base`; a path
 * starting with one slash and no drive (`/src/a.ts`) is taken as relative to `base` on Windows. Null for what cannot be
 * a local file: network paths, `~`, other URL schemes, relative paths without a base.
 */
export function resolveMentioned(written: string, base: string | null, p: PathApi = path, windows = process.platform === "win32"): string | null {
  let s = written.trim();
  if (!s || s.length > 1024 || /[\u0000-\u001f]/.test(s)) return null;
  if (/^file:\/\//i.test(s)) {
    try {
      s = decodeURIComponent(s.replace(/^file:\/\//i, ""));
    } catch {
      return null;
    }
    // file:///G:/a → G:/a; file:///home/a → /home/a
    if (/^\/[a-z]:[\\/]/i.test(s)) s = s.slice(1);
  }
  if (/^[\\/]{2}/.test(s) || s.startsWith("~") || (/^[a-z][a-z\d+.-]*:/i.test(s) && !/^[a-z]:[\\/]/i.test(s))) return null;
  if (windows && /^[\\/]/.test(s)) return base ? p.normalize(p.join(base, s.slice(1))) : null;
  if (p.isAbsolute(s)) return p.normalize(s);
  return base ? p.normalize(p.join(base, s)) : null;
}
