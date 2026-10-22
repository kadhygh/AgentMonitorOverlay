import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { diffHunks, MAX_PROPOSAL_BYTES, type GitDiffLine, type GitFileDiff } from "@amo-studio/protocol";
import { HostError } from "../../../core/shared.js";
import { DIFF_MAX_LINES, parseUnifiedDiff, textLines } from "../../gitreview/git.js";
import { common, type ViewKindModule } from "./kind.js";

// 改动预览: a change the agent suggests but has not made — the file as it is when the pack is made, and the whole
// content the agent proposes. Nothing on disk changes. The window shows the two as a diff (git diff --no-index on
// two temporary files, outside any repository), as Git Review shows one; comments on it are for that one look.

export const proposalKind: ViewKindModule<"proposal"> = {
  kind: "proposal",

  async check(input, ctx) {
    const path = ctx.relative(input.path, "path");
    if (typeof input.proposed !== "string") throw new HostError("bad_request", "proposed (the whole new content of the file) is required");
    if (Buffer.byteLength(input.proposed) > MAX_PROPOSAL_BYTES) throw new HostError("bad_request", `proposed is larger than ${MAX_PROPOSAL_BYTES / 1_000_000} MB`);
    const full = resolve(ctx.workspace.path, path);
    const info = await stat(full).catch(() => null);
    if (info && !info.isFile()) throw new HostError("bad_request", `${path} is a folder, not a file`);
    let original = "";
    if (info) {
      if (info.size > MAX_PROPOSAL_BYTES) throw new HostError("bad_request", `${path} is larger than ${MAX_PROPOSAL_BYTES / 1_000_000} MB`);
      const data = await readFile(full);
      if (data.subarray(0, 8000).includes(0)) throw new HostError("bad_request", `${path} is a binary file`);
      original = data.toString("utf8");
    }
    return { kind: "proposal", path, original, proposed: input.proposed, isNew: !info, ...common(input) };
  },

  // A later proposal for the same file replaces the earlier one (the original stays the one first read).
  merge(prev, next) {
    if (prev.path !== next.path) return null;
    return { ...prev, ...(next.title ? { title: next.title } : {}), ...(next.note ? { note: next.note } : {}), proposed: next.proposed };
  },

  async diff(item) {
    const lines = await diffTexts(item.original, item.proposed);
    const tooLarge = lines.length > DIFF_MAX_LINES;
    const shown = tooLarge ? [] : lines;
    return { range: "working", path: item.path, binary: false, tooLarge, lines: shown, hunks: diffHunks(shown) };
  },
};

/** The whole new text with its changes, as Git Review's full-file diff: `git diff --no-index` of two temp files. */
export async function diffTexts(before: string, after: string): Promise<GitDiffLine[]> {
  if (before === after) return textLines(after).map((text, i) => ({ kind: "context", oldLine: i + 1, newLine: i + 1, text }));
  const dir = await mkdtemp(join(tmpdir(), "amo-studio-proposal-"));
  try {
    await writeFile(join(dir, "a"), before);
    await writeFile(join(dir, "b"), after);
    const out = await new Promise<string>((done, fail) => {
      execFile(
        "git",
        ["-c", "core.quotepath=off", "-c", "color.ui=never", "diff", "--no-index", "--no-ext-diff", "--no-color", "-U1000000", "--", "a", "b"],
        { cwd: dir, windowsHide: true, maxBuffer: 4 * MAX_PROPOSAL_BYTES, timeout: 15_000 },
        // Exit code 1 is git saying the files differ.
        (err, stdout) => (err && (err as { code?: unknown }).code !== 1 ? fail(new HostError("runtime_error", `git diff failed: ${err.message}`)) : done(stdout)),
      );
    });
    return parseUnifiedDiff(out).lines;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
