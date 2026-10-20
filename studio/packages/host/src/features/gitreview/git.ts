import { execFile } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { traceGit } from "../../core/git-trace.js";
import {
  diffHunks,
  GIT_EMPTY_TREE,
  GIT_LOG_MAX,
  isCommitRef,
  isObjectId,
  rangeBase,
  type GitChangedFile,
  type GitChanges,
  type GitCommit,
  type GitCommitChanges,
  type GitDiffLine,
  type GitFileDiff,
  type GitFileStatus,
  type GitLog,
  type GitRange,
  type GitStatus,
} from "@amo-studio/protocol";

// Reading a project's changes from git: `git` runs through execFile (no shell) in the project folder, with a timeout
// and bounded output. Paths are relative to the project folder (`--relative`), so a project inside a larger
// repository sees only its own changes. Nothing here writes to the repository.

const TIMEOUT_MS = 15_000;
/** Output of the listing commands. */
const LIST_MAX_BYTES = 16 * 1024 * 1024;
/** Output of one file's diff; larger files get a notice instead. */
export const DIFF_MAX_BYTES = 4 * 1024 * 1024;
/** Lines of one file's diff; larger files get a notice instead. */
export const DIFF_MAX_LINES = 20_000;
/** Files listed per range. */
export const MAX_FILES = 3000;
/** Untracked files larger than this are not read (not counted, not shown). */
const UNTRACKED_MAX_BYTES = 2 * 1024 * 1024;
/** Context lines that make a diff cover the whole file. */
const WHOLE_FILE = 1_000_000;
/** git's empty tree: what a repository without commits is compared with. */
export const EMPTY_TREE = GIT_EMPTY_TREE;
/** Untracked files read at the same time while listing. */
const UNTRACKED_READS = 8;

export class GitError extends Error {
  constructor(
    message: string,
    readonly kind: "missing" | "failed" | "too-large" | "timeout",
  ) {
    super(message);
  }
}

/** Runs git in `cwd` and returns its stdout. Pathspecs are literal; paths are printed unquoted. */
export function git(cwd: string, args: readonly string[], maxBytes = LIST_MAX_BYTES): Promise<string> {
  return new Promise((done, fail) => {
    const traced = traceGit(cwd, args);
    execFile(
      "git",
      ["--literal-pathspecs", "-c", "core.quotepath=off", "-c", "color.ui=never", ...args],
      // Optional locks off: reading must never block (or be blocked by) the agent's own git commands.
      { cwd, maxBuffer: maxBytes, timeout: TIMEOUT_MS, windowsHide: true, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        traced(err ? { error: String(stderr || err.message).trim() } : { bytes: stdout.length });
        if (!err) return done(stdout);
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === "ENOENT") fail(new GitError("没有找到 git", "missing"));
        else if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") fail(new GitError("output too large", "too-large"));
        else if (e.killed) fail(new GitError("git timed out", "timeout"));
        else fail(new GitError(String(stderr || e.message).trim(), "failed"));
      },
    );
  });
}

/** git's answer, or null when the command fails (a missing ref, no upstream…). */
async function maybe(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const out = (await git(cwd, args)).trim();
    return out || null;
  } catch (err) {
    if (err instanceof GitError && err.kind === "missing") throw err;
    return null;
  }
}

/** Branches a review compares with, in order of preference. */
const DEFAULT_BRANCHES = ["main", "master", "origin/main", "origin/master"];

export async function readStatus(dir: string): Promise<GitStatus> {
  const none = { branch: null, head: null, upstream: null, base: null, mergeBase: null };
  // Every question at once (each git start costs tens of milliseconds on Windows); outside a repository the others
  // simply fail, and the top folder's error says why.
  const top = git(dir, ["rev-parse", "--show-toplevel"]).then(
    (out) => ({ root: out.trim() }),
    (err: unknown) => ({ err }),
  );
  const [found, head, branch, upstream, originHead, refs] = await Promise.all([
    top,
    maybe(dir, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]),
    maybe(dir, ["symbolic-ref", "--short", "-q", "HEAD"]),
    maybe(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    maybe(dir, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]),
    maybe(dir, ["for-each-ref", "--format=%(refname:short)", ...DEFAULT_BRANCHES.map((b) => (b.startsWith("origin/") ? `refs/remotes/${b}` : `refs/heads/${b}`))]),
  ]).catch((err: unknown) => [{ err }, null, null, null, null, null] as const);
  if ("err" in found) return { repo: false, reason: found.err instanceof GitError && found.err.kind === "missing" ? "没有找到 git" : "不是 git 仓库", ...none };
  const { root } = found;
  // origin/HEAD, else main or master; never the branch itself (on main, compare with origin/main if there is one).
  const existing = refs?.split(/\r?\n/) ?? [];
  const candidates = [originHead, ...DEFAULT_BRANCHES.filter((b) => existing.includes(b))].filter((b): b is string => !!b && b !== branch);
  const base = candidates[0] ?? null;
  const mergeBase = head && base ? await maybe(dir, ["merge-base", base, "HEAD"]) : null;
  return { repo: true, root, branch, head, upstream, base, mergeBase };
}

/** The `git diff` arguments that select a range (before the options): against the range's base (see rangeBase). */
export function rangeArgs(range: GitRange, at: GitStatus | string): string[] {
  const base = typeof at === "string" ? at : rangeBase(range, at);
  return range === "staged" ? ["diff", "--cached", base] : ["diff", base];
}

const DIFF_OPTIONS = ["--relative", "-M", "--no-ext-diff", "--no-color"];

const STATUS: Record<string, GitFileStatus> = { A: "added", C: "added", D: "deleted", R: "renamed" };

/** `git diff --name-status -z`: status letter (with a score for renames and copies), then one or two paths. */
export function parseNameStatus(out: string): { status: GitFileStatus; path: string; oldPath?: string }[] {
  const t = out.split("\0");
  const files: { status: GitFileStatus; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < t.length; ) {
    const code = t[i++];
    if (!code) continue;
    const letter = code[0]!;
    if (letter === "R" || letter === "C") {
      const oldPath = t[i++]!;
      const path = t[i++]!;
      files.push(letter === "R" ? { status: "renamed", path, oldPath } : { status: "added", path });
    } else files.push({ status: STATUS[letter] ?? "modified", path: t[i++]! });
  }
  return files;
}

/** `git diff --numstat -z`: added, deleted ("-" for binary files), path; renames give the two paths after an empty one. */
export function parseNumstat(out: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const t = out.split("\0");
  const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let i = 0; i < t.length; ) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(t[i++] ?? "");
    if (!m) continue;
    let path = m[3]!;
    if (!path) {
      i++; // the old path
      path = t[i++] ?? "";
    }
    const binary = m[1] === "-";
    stats.set(path, { additions: binary ? 0 : Number(m[1]), deletions: binary ? 0 : Number(m[2]), binary });
  }
  return stats;
}

const split0 = (out: string) => out.split("\0").filter(Boolean);

/** A buffer that looks binary: a NUL byte near the start (git's own test). */
const looksBinary = (data: Buffer) => data.subarray(0, 8000).includes(0);

/** Lines of a text file, without line breaks (CRLF or LF); a final break does not start another line. */
export function textLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** A path from the UI resolved inside the project folder (or an error). */
export function insidePath(dir: string, path: string): string {
  if (typeof path !== "string" || !path || path.includes("\0") || isAbsolute(path)) throw new GitError(`bad path ${String(path)}`, "failed");
  const full = resolve(dir, path);
  const rel = relative(resolve(dir), full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new GitError(`path ${path} is outside the project`, "failed");
  return full;
}

async function untrackedFile(dir: string, path: string): Promise<GitChangedFile> {
  const file: GitChangedFile = { path, status: "added", untracked: true, additions: 0, deletions: 0, binary: false };
  try {
    const full = insidePath(dir, path);
    const info = await stat(full);
    if (!info.isFile()) return file;
    if (info.size > UNTRACKED_MAX_BYTES) {
      // Large: only peek for binary content, the line count stays unknown (0).
      const handle = await open(full, "r");
      try {
        const head = Buffer.alloc(8000);
        const { bytesRead } = await handle.read(head, 0, head.length, 0);
        return { ...file, binary: looksBinary(head.subarray(0, bytesRead)) };
      } finally {
        await handle.close();
      }
    }
    const data = await readFile(full);
    if (looksBinary(data)) return { ...file, binary: true };
    return { ...file, additions: textLines(data.toString("utf8")).length };
  } catch {
    return file;
  }
}

/**
 * Changed files of a range, sorted by path. Untracked files count for `working` and `branch`. The status may still be
 * on its way: the untracked scan (the slowest call in a large tree) does not need it and starts at once.
 */
export async function readChanges(dir: string, range: GitRange, pending: GitStatus | Promise<GitStatus>): Promise<GitChanges> {
  const scan = range === "staged" ? Promise.resolve("") : git(dir, ["ls-files", "--others", "--exclude-standard", "-z"]);
  // Outside a repository the scan fails; the status says so.
  scan.catch(() => undefined);
  const lists = (base: string[]) => Promise.all([git(dir, [...base, ...DIFF_OPTIONS, "--name-status", "-z"]), git(dir, [...base, ...DIFF_OPTIONS, "--numstat", "-z"])]);
  // Against HEAD (the working tree, the index) the lists need not wait for the status (its merge base takes a second
  // round of git); without a commit they fail and run again against the empty tree.
  const early = range === "branch" ? null : lists(range === "staged" ? ["diff", "--cached", "HEAD"] : ["diff", "HEAD"]);
  early?.catch(() => undefined);
  const status = await pending;
  if (!status.repo) return { status, range, files: [], truncated: false };
  const [[names, nums], others] = await Promise.all([(status.head && early) || lists(rangeArgs(range, status)), scan]);
  const stats = parseNumstat(nums);
  const files: GitChangedFile[] = parseNameStatus(names).map((f) => ({ ...f, ...(stats.get(f.path) ?? { additions: 0, deletions: 0, binary: false }) }));
  const tracked = new Set(files.map((f) => f.path));
  const untracked = split0(others).filter((p) => !tracked.has(p));
  const room = Math.max(0, MAX_FILES - files.length);
  const listed = untracked.slice(0, room);
  for (let i = 0; i < listed.length; i += UNTRACKED_READS) files.push(...(await Promise.all(listed.slice(i, i + UNTRACKED_READS).map((p) => untrackedFile(dir, p)))));
  const truncated = files.length > MAX_FILES || untracked.length > room;
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { status, range, files: files.slice(0, MAX_FILES), truncated };
}

/**
 * A unified diff (of one file, with the whole file as context) as numbered lines. Counts from each @@ header decide
 * where a hunk ends, so blank context lines printed without their leading space still parse; CR of CRLF files is
 * dropped.
 */
export function parseUnifiedDiff(out: string): { lines: GitDiffLine[]; binary: boolean } {
  const rows = out.split("\n");
  const lines: GitDiffLine[] = [];
  let binary = false;
  let i = 0;
  for (; i < rows.length && !rows[i]!.startsWith("@@"); i++) {
    if (/^Binary files .* differ\r?$/.test(rows[i]!) || rows[i] === "GIT binary patch") binary = true;
  }
  while (i < rows.length) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rows[i++]!);
    if (!m) continue;
    let oldNo = Number(m[1]);
    let newNo = Number(m[3]);
    let oldLeft = m[2] === undefined ? 1 : Number(m[2]);
    let newLeft = m[4] === undefined ? 1 : Number(m[4]);
    while ((oldLeft > 0 || newLeft > 0) && i < rows.length) {
      const row = rows[i++]!;
      const mark = row[0];
      if (mark === "\\") continue; // "\ No newline at end of file"
      const text = row.slice(1).replace(/\r$/, "");
      if (mark === "+") {
        lines.push({ kind: "add", oldLine: null, newLine: newNo++, text });
        newLeft--;
      } else if (mark === "-") {
        lines.push({ kind: "del", oldLine: oldNo++, newLine: null, text });
        oldLeft--;
      } else {
        lines.push({ kind: "context", oldLine: oldNo++, newLine: newNo++, text });
        oldLeft--;
        newLeft--;
      }
    }
  }
  return { lines, binary };
}

function fileDiff(range: GitRange, path: string, oldPath: string | undefined, lines: GitDiffLine[], extra: { binary?: boolean; tooLarge?: boolean } = {}): GitFileDiff {
  const tooLarge = extra.tooLarge === true || lines.length > DIFF_MAX_LINES;
  const shown = tooLarge || extra.binary ? [] : lines;
  return { range, path, ...(oldPath ? { oldPath } : {}), binary: extra.binary === true, tooLarge, lines: shown, hunks: diffHunks(shown) };
}

/** A text as unchanged (or all added) lines. */
const asLines = (text: string, kind: "context" | "add"): GitDiffLine[] =>
  textLines(text).map((t, i) => ({ kind, oldLine: kind === "context" ? i + 1 : null, newLine: i + 1, text: t }));

/** The new side of a file in a range: the working tree, or the index for `staged`. */
async function newContent(dir: string, range: GitRange, path: string): Promise<Buffer | null> {
  try {
    if (range === "staged") return Buffer.from(await git(dir, ["show", `:./${path}`], DIFF_MAX_BYTES), "utf8");
    return await readFile(insidePath(dir, path));
  } catch {
    return null;
  }
}

/**
 * One file's diff in a range: the whole file with its changes, and the hunks around them. `at` is the status or the
 * range's base commit; `untracked` (when the list already knows) saves asking git.
 */
export async function readFileDiff(dir: string, range: GitRange, at: GitStatus | string, path: string, oldPath?: string, untracked?: boolean): Promise<GitFileDiff> {
  insidePath(dir, path);
  if (oldPath) insidePath(dir, oldPath);
  const isUntracked = range !== "staged" && (untracked ?? (await git(dir, ["ls-files", "--others", "--exclude-standard", "-z", "--", path])).length > 0);
  if (isUntracked) {
    // Untracked: the file itself, every line added.
    const full = insidePath(dir, path);
    const info = await stat(full);
    if (info.size > DIFF_MAX_BYTES) return fileDiff(range, path, undefined, [], { tooLarge: true });
    const data = await readFile(full);
    if (looksBinary(data)) return fileDiff(range, path, undefined, [], { binary: true });
    return fileDiff(range, path, undefined, asLines(data.toString("utf8"), "add"));
  }
  let out: string;
  try {
    out = await git(dir, [...rangeArgs(range, at), ...DIFF_OPTIONS, `-U${WHOLE_FILE}`, "--", ...(oldPath ? [oldPath, path] : [path])], DIFF_MAX_BYTES);
  } catch (err) {
    if (err instanceof GitError && err.kind === "too-large") return fileDiff(range, path, oldPath, [], { tooLarge: true });
    throw err;
  }
  const parsed = parseUnifiedDiff(out);
  if (parsed.binary) return fileDiff(range, path, oldPath, [], { binary: true });
  if (!parsed.lines.length) {
    // No text change (a pure rename, a mode change): the file as it is.
    const data = await newContent(dir, range, path);
    if (data && data.length > DIFF_MAX_BYTES) return fileDiff(range, path, oldPath, [], { tooLarge: true });
    if (data && looksBinary(data)) return fileDiff(range, path, oldPath, [], { binary: true });
    return fileDiff(range, path, oldPath, data ? asLines(data.toString("utf8"), "context") : []);
  }
  return fileDiff(range, path, oldPath, parsed.lines);
}

// ---- commit history (stage 13, S13-B) ---------------------------------------------------------------------------

/** Fields of one commit in `git log` output: unit separator between fields, record separator after each commit. */
const LOG_FORMAT = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e";

/** `git log` with LOG_FORMAT, as commits. */
export function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of out.split("\x1e")) {
    const f = record.replace(/^\r?\n/, "").split("\x1f");
    if (f.length < 6 || !/^[0-9a-f]{40,64}$/.test(f[0]!)) continue;
    commits.push({ sha: f[0]!, parents: f[1]!.split(" ").filter(Boolean), author: f[2]!, email: f[3]!, date: f[4]!, subject: f.slice(5).join("\x1f").trim() });
  }
  return commits;
}

/** Where a project sits in its repository (`rev-parse --show-prefix`), by folder: asked once, it does not change. */
const prefixes = new Map<string, string>();

/** The pathspec that keeps a project inside a larger repository to its own commits (none at the top folder). */
async function ownCommits(dir: string): Promise<string[]> {
  let prefix = prefixes.get(dir);
  if (prefix === undefined) {
    prefix = (await git(dir, ["rev-parse", "--show-prefix"])).trim();
    prefixes.set(dir, prefix);
  }
  return prefix ? ["--", "."] : [];
}

/**
 * HEAD's latest commits, newest first (`limit` at most GIT_LOG_MAX). Every git start costs tens of milliseconds on
 * Windows (about 100 on the person's machine, 2026-10-16), so the log runs beside the HEAD and branch questions.
 */
export async function readLog(dir: string, limit = GIT_LOG_MAX): Promise<GitLog> {
  const n = Math.max(1, Math.min(GIT_LOG_MAX, Math.floor(limit) || GIT_LOG_MAX));
  // One more than asked: whether there are more. Without a commit it fails, and HEAD says why.
  const log = ownCommits(dir).then((scope) => git(dir, ["log", `-n${n + 1}`, "--no-color", LOG_FORMAT, "HEAD", ...scope]));
  log.catch(() => undefined);
  const [head, branch] = await Promise.all([maybe(dir, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]), maybe(dir, ["symbolic-ref", "--short", "-q", "HEAD"])]);
  if (!head) {
    await ownCommits(dir); // outside a repository: that error
    return { branch, head: null, commits: [], truncated: false };
  }
  const commits = parseLog(await log);
  return { branch, head, commits: commits.slice(0, n), truncated: commits.length > n };
}

/** One commit and its changed files against its first parent (the empty tree for a root commit). */
/** A ref another tool names (a branch, a tag, `HEAD~2`, an id) as a full commit id; never one that reads as an option. */
export async function resolveCommit(dir: string, ref: string): Promise<string> {
  if (!/^[\w./@{}^~-]{1,200}$/.test(ref) || ref.startsWith("-")) throw new GitError(`bad commit ${ref}`, "failed");
  const sha = await maybe(dir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  if (!sha) throw new GitError(`commit ${ref} not found`, "failed");
  return sha;
}

/** Where `b` left `a` (both full ids). */
export async function mergeBase(dir: string, a: string, b: string): Promise<string> {
  const sha = await maybe(dir, ["merge-base", a, b]);
  if (!sha) throw new GitError(`commit shared by ${a.slice(0, 7)} and ${b.slice(0, 7)} not found`, "failed");
  return sha;
}

/** A commit's changed files, against its first parent, or against `against` (a full id: 外部打开 Review's range). */
export async function readCommit(dir: string, ref: string, against?: string): Promise<GitCommitChanges> {
  if (!isCommitRef(ref)) throw new GitError(`bad commit ${String(ref)}`, "failed");
  const sha = await maybe(dir, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  if (!sha) throw new GitError(`commit ${ref} not found`, "failed");
  const [commit] = parseLog(await git(dir, ["log", "-n1", "--no-color", LOG_FORMAT, sha]));
  if (!commit) throw new GitError(`commit ${ref} not found`, "failed");
  const base = against ?? commit.parents[0] ?? EMPTY_TREE;
  const [names, nums] = await Promise.all([
    git(dir, ["diff", base, sha, ...DIFF_OPTIONS, "--name-status", "-z"]),
    git(dir, ["diff", base, sha, ...DIFF_OPTIONS, "--numstat", "-z"]),
  ]);
  const stats = parseNumstat(nums);
  const files: GitChangedFile[] = parseNameStatus(names).map((f) => ({ ...f, ...(stats.get(f.path) ?? { additions: 0, deletions: 0, binary: false }) }));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { commit, base, files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
}

/** One file of a commit against `base` (both full ids, from readCommit): the whole file with its changes, one git call. */
export async function readCommitFileDiff(dir: string, base: string, sha: string, path: string, oldPath?: string): Promise<GitFileDiff> {
  if (!isObjectId(base) || !isObjectId(sha)) throw new GitError("base and sha must be full commit ids", "failed");
  insidePath(dir, path);
  if (oldPath) insidePath(dir, oldPath);
  const of = (d: GitFileDiff): GitFileDiff => ({ ...d, commit: sha });
  let out: string;
  try {
    out = await git(dir, ["diff", base, sha, ...DIFF_OPTIONS, `-U${WHOLE_FILE}`, "--", ...(oldPath ? [oldPath, path] : [path])], DIFF_MAX_BYTES);
  } catch (err) {
    if (err instanceof GitError && err.kind === "too-large") return of(fileDiff("working", path, oldPath, [], { tooLarge: true }));
    throw err;
  }
  const parsed = parseUnifiedDiff(out);
  if (parsed.binary) return of(fileDiff("working", path, oldPath, [], { binary: true }));
  if (parsed.lines.length) return of(fileDiff("working", path, oldPath, parsed.lines));
  // No text change (a pure rename, a mode change): the file as the commit has it.
  let text: string | null = null;
  try {
    text = await git(dir, ["show", `${sha}:./${path}`], DIFF_MAX_BYTES);
  } catch (err) {
    if (err instanceof GitError && err.kind === "too-large") return of(fileDiff("working", path, oldPath, [], { tooLarge: true }));
  }
  if (text !== null && text.includes("\0")) return of(fileDiff("working", path, oldPath, [], { binary: true }));
  return of(fileDiff("working", path, oldPath, text ? asLines(text, "context") : []));
}
