import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { GitExcludeState } from "@amo-studio/protocol";
import { PACKS_DIR } from "@amo-studio/protocol";

// The project's `.amo/` (extension packs, 2026-10-23) left out of git without touching the project's own .gitignore:
// one line in the repository's `.git/info/exclude`, which stays on this machine. A worktree shares its repository's
// exclude file (`git rev-parse --git-path`); a project inside a larger repository gets a line with its own sub path.

const AMO_DIR = PACKS_DIR.split("/")[0]!;
const COMMENT = "# AMO Studio: the project's .amo/ (extension packs)";

/** git's exit code and stdout; no shell, a timeout, prompts off. */
function run(cwd: string, args: readonly string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile("git", args, { cwd, timeout: 15_000, windowsHide: true, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : -1) : 0;
      done({ code, out: String(stdout ?? "") });
    });
  });
}

/** Whether git leaves `.amo/` of the folder out, and by which rule. */
export async function readGitExclude(folder: string): Promise<GitExcludeState> {
  const top = await run(folder, ["rev-parse", "--show-prefix"]);
  if (top.code !== 0) return { git: false, excluded: false, source: null, entry: `/${AMO_DIR}/`, tracked: 0 };
  const entry = `/${top.out.trim()}${AMO_DIR}/`;
  // --no-index: the rule counts even when files under .amo/ are tracked (they are counted apart).
  const check = await run(folder, ["check-ignore", "-v", "--no-index", `${AMO_DIR}/`]);
  const [rule = "", pattern = ""] = /^(.*?:\d+):(.*)\t/.exec(check.out)?.slice(1) ?? [];
  // -v also prints a matching negation (`!…`), which keeps it in.
  const excluded = check.code === 0 && !!rule && !pattern.startsWith("!");
  const tracked = await run(folder, ["ls-files", "--", `${AMO_DIR}/`]);
  return { git: true, excluded, source: excluded ? rule : null, entry, tracked: tracked.out.split("\n").filter(Boolean).length };
}

/** Adds the folder's `.amo/` to its repository's `.git/info/exclude` unless git leaves it out already. */
export async function addGitExclude(folder: string): Promise<GitExcludeState> {
  const state = await readGitExclude(folder);
  if (!state.git || state.excluded) return state;
  const where = await run(folder, ["rev-parse", "--git-path", "info/exclude"]);
  if (where.code !== 0 || !where.out.trim()) throw new Error("找不到这个仓库的 .git/info/exclude");
  const file = resolve(folder, where.out.trim());
  mkdirSync(dirname(file), { recursive: true });
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  appendFileSync(file, `${before && !before.endsWith("\n") ? eol : ""}${COMMENT}${eol}${state.entry}${eol}`);
  return readGitExclude(folder);
}
