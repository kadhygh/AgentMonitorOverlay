import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffHunks, type GitDiffLine } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { rangeBase } from "@amo-studio/protocol";
import { insidePath, parseNameStatus, parseNumstat, parseUnifiedDiff, readChanges, readFileDiff, readStatus, textLines } from "./git.js";

// Git Review against real (temporary) repositories: ranges, statuses, line numbers, CRLF, binary files.

describe("git output parsing", () => {
  it("numbers diff lines, keeps blank context lines without their space, drops CR and no-newline markers", () => {
    const out = ["diff --git a/a.txt b/a.txt", "index 1..2 100644", "--- a/a.txt", "+++ b/a.txt", "@@ -1,4 +1,4 @@", " one\r", "-two\r", "+TWO\r", "", " four", "\\ No newline at end of file", ""].join("\n");
    const { lines, binary } = parseUnifiedDiff(out);
    expect(binary).toBe(false);
    expect(lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "one" },
      { kind: "del", oldLine: 2, newLine: null, text: "two" },
      { kind: "add", oldLine: null, newLine: 2, text: "TWO" },
      { kind: "context", oldLine: 3, newLine: 3, text: "" },
      { kind: "context", oldLine: 4, newLine: 4, text: "four" },
    ]);
    expect(parseUnifiedDiff("diff --git a/x b/x\nBinary files a/x and b/x differ\n").binary).toBe(true);
  });

  it("reads name-status and numstat with renames and binary files", () => {
    expect(parseNameStatus("M\0a.ts\0R087\0old name.ts\0new name.ts\0D\0gone.ts\0A\0b.bin\0")).toEqual([
      { status: "modified", path: "a.ts" },
      { status: "renamed", path: "new name.ts", oldPath: "old name.ts" },
      { status: "deleted", path: "gone.ts" },
      { status: "added", path: "b.bin" },
    ]);
    const stats = parseNumstat("3\t1\ta.ts\0" + "2\t2\t\0old name.ts\0new name.ts\0" + "-\t-\tb.bin\0");
    expect(stats.get("a.ts")).toEqual({ additions: 3, deletions: 1, binary: false });
    expect(stats.get("new name.ts")).toEqual({ additions: 2, deletions: 2, binary: false });
    expect(stats.get("b.bin")).toEqual({ additions: 0, deletions: 0, binary: true });
  });

  it("splits CRLF and LF text without an extra last line", () => {
    expect(textLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(textLines("a\nb")).toEqual(["a", "b"]);
    expect(textLines("")).toEqual([]);
  });

  it("keeps paths inside the project", () => {
    expect(() => insidePath("C:\\p", "../x")).toThrow();
    expect(() => insidePath("C:\\p", "C:\\other\\x")).toThrow();
    expect(insidePath("C:\\p", "src/a.ts")).toMatch(/src[\\/]a\.ts$/);
  });

  it("groups changes into hunks with three lines of context", () => {
    const lines: GitDiffLine[] = Array.from({ length: 20 }, (_, i) => ({ kind: "context", oldLine: i + 1, newLine: i + 1, text: `l${i + 1}` }));
    lines[4] = { kind: "add", oldLine: null, newLine: 5, text: "new" };
    lines[15] = { kind: "del", oldLine: 16, newLine: null, text: "gone" };
    const hunks = diffHunks(lines);
    expect(hunks.map((h) => [h.start, h.end])).toEqual([
      [1, 8],
      [12, 19],
    ]);
    // Merged when the context of two changes touches.
    lines[9] = { kind: "add", oldLine: null, newLine: 10, text: "mid" };
    expect(diffHunks(lines).map((h) => [h.start, h.end])).toEqual([[1, 19]]);
  });
});

let root: string;
let repo: string;

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true });

// git is a process per call: slow on a loaded machine (the whole suite runs in parallel).
describe("a repository with a branch and working changes", { timeout: 30_000 }, () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-git-"));
    repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    run(repo, "init", "-q", "-b", "main");
    // Line endings exactly as written, whatever the machine's git defaults.
    run(repo, "config", "core.autocrlf", "false");
    writeFileSync(join(repo, "src", "app.ts"), "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    writeFileSync(join(repo, "old-name.md"), "# Title\n\nbody text\n");
    writeFileSync(join(repo, "gone.txt"), "bye\nfor now\n");
    writeFileSync(join(repo, "win.txt"), "one\r\ntwo\r\nthree\r\n");
    run(repo, "add", ".");
    run(repo, "commit", "-q", "-m", "base");
    run(repo, "checkout", "-q", "-b", "feature");
    writeFileSync(join(repo, "src", "app.ts"), "const a = 1;\nconst b = 20;\nconst c = 3;\n");
    writeFileSync(join(repo, "src", "feature.ts"), "export const f = true;\n");
    run(repo, "add", ".");
    run(repo, "commit", "-q", "-m", "feature work");
    // Working changes: modified (staged and unstaged), renamed, deleted, CRLF, binary and untracked files.
    writeFileSync(join(repo, "src", "app.ts"), "const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n");
    run(repo, "mv", "old-name.md", "new-name.md");
    run(repo, "rm", "-q", "gone.txt");
    writeFileSync(join(repo, "win.txt"), "one\r\nTWO\r\nthree\r\n");
    writeFileSync(join(repo, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x00, 0xff]));
    writeFileSync(join(repo, "notes 中文.txt"), "first\nsecond\n");
    run(repo, "add", "src/app.ts");
    writeFileSync(join(repo, "src", "app.ts"), "const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;\nconst e = 5;\n");
  }, 60_000);

  afterAll(() => removeTempDir(root));

  it("reads the branch, HEAD, the default branch and the merge base", async () => {
    const status = await readStatus(repo);
    const mainHead = run(repo, "rev-parse", "main").trim();
    expect(status).toMatchObject({ repo: true, branch: "feature", base: "main", mergeBase: mainHead, upstream: null });
    expect(status.head).toBe(run(repo, "rev-parse", "HEAD").trim());
  });

  it("lists working changes against HEAD, untracked files included", async () => {
    const status = await readStatus(repo);
    const { files, truncated } = await readChanges(repo, "working", status);
    expect(truncated).toBe(false);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["gone.txt", "deleted"],
      ["logo.bin", "added"],
      ["new-name.md", "renamed"],
      ["notes 中文.txt", "added"],
      ["src/app.ts", "modified"],
      ["win.txt", "modified"],
    ]);
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(by["src/app.ts"]).toMatchObject({ additions: 2, deletions: 0, binary: false });
    expect(by["gone.txt"]).toMatchObject({ additions: 0, deletions: 2 });
    expect(by["new-name.md"]).toMatchObject({ oldPath: "old-name.md" });
    expect(by["logo.bin"]).toMatchObject({ untracked: true, binary: true });
    expect(by["notes 中文.txt"]).toMatchObject({ untracked: true, additions: 2 });
    expect(by["win.txt"]).toMatchObject({ additions: 1, deletions: 1 });
  });

  it("lists everything the branch changes in the branch range, only the index in the staged range", async () => {
    const status = await readStatus(repo);
    const branch = await readChanges(repo, "branch", status);
    expect(branch.files.map((f) => f.path)).toEqual(["gone.txt", "logo.bin", "new-name.md", "notes 中文.txt", "src/app.ts", "src/feature.ts", "win.txt"]);
    expect(branch.files.find((f) => f.path === "src/app.ts")).toMatchObject({ additions: 3, deletions: 1 });
    const staged = await readChanges(repo, "staged", status);
    expect(staged.files.map((f) => f.path)).toEqual(["gone.txt", "new-name.md", "src/app.ts"]);
    expect(staged.files.find((f) => f.path === "src/app.ts")).toMatchObject({ additions: 1, deletions: 0 });
  });

  it("gives the whole file with old and new line numbers, and the hunks", async () => {
    const status = await readStatus(repo);
    const working = await readFileDiff(repo, "working", status, "src/app.ts");
    expect(working.lines.map((l) => [l.kind, l.oldLine, l.newLine, l.text])).toEqual([
      ["context", 1, 1, "const a = 1;"],
      ["context", 2, 2, "const b = 20;"],
      ["context", 3, 3, "const c = 3;"],
      ["add", null, 4, "const d = 4;"],
      ["add", null, 5, "const e = 5;"],
    ]);
    expect(working.hunks).toEqual([{ start: 0, end: 5, oldStart: 1, oldCount: 3, newStart: 1, newCount: 5 }]);
    const branch = await readFileDiff(repo, "branch", status, "src/app.ts");
    expect(branch.lines.filter((l) => l.kind !== "context").map((l) => [l.kind, l.oldLine, l.newLine, l.text])).toEqual([
      ["del", 2, null, "const b = 2;"],
      ["add", null, 2, "const b = 20;"],
      ["add", null, 4, "const d = 4;"],
      ["add", null, 5, "const e = 5;"],
    ]);
    const staged = await readFileDiff(repo, "staged", status, "src/app.ts");
    expect(staged.lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["const d = 4;"]);
  });

  it("handles CRLF, deleted, renamed, untracked and binary files", async () => {
    const status = await readStatus(repo);
    const win = await readFileDiff(repo, "working", status, "win.txt");
    expect(win.lines.map((l) => [l.kind, l.text])).toEqual([
      ["context", "one"],
      ["del", "two"],
      ["add", "TWO"],
      ["context", "three"],
    ]);
    const gone = await readFileDiff(repo, "working", status, "gone.txt");
    expect(gone.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ["del", 1, null],
      ["del", 2, null],
    ]);
    const renamed = await readFileDiff(repo, "working", status, "new-name.md", "old-name.md");
    expect(renamed).toMatchObject({ oldPath: "old-name.md", binary: false, tooLarge: false, hunks: [] });
    expect(renamed.lines.map((l) => [l.kind, l.newLine, l.text])).toEqual([
      ["context", 1, "# Title"],
      ["context", 2, ""],
      ["context", 3, "body text"],
    ]);
    const untracked = await readFileDiff(repo, "working", status, "notes 中文.txt");
    expect(untracked.lines.map((l) => [l.kind, l.newLine, l.text])).toEqual([
      ["add", 1, "first"],
      ["add", 2, "second"],
    ]);
    expect(await readFileDiff(repo, "working", status, "logo.bin")).toMatchObject({ binary: true, lines: [] });
    await expect(readFileDiff(repo, "working", status, "../outside.txt")).rejects.toThrow(/outside/);
  });

  it("takes the list's base commit and untracked flag instead of asking git again", async () => {
    const status = await readStatus(repo);
    const base = rangeBase("branch", status);
    expect(base).toBe(status.mergeBase);
    const branch = await readFileDiff(repo, "branch", base, "src/app.ts", undefined, false);
    expect(branch.lines).toEqual((await readFileDiff(repo, "branch", status, "src/app.ts")).lines);
    const untracked = await readFileDiff(repo, "working", rangeBase("working", status), "notes 中文.txt", undefined, true);
    expect(untracked.lines.map((l) => l.kind)).toEqual(["add", "add"]);
    // Changes still being read alongside a pending status come out the same.
    expect((await readChanges(repo, "working", readStatus(repo))).files.map((f) => f.path)).toEqual((await readChanges(repo, "working", status)).files.map((f) => f.path));
  });

  it("scopes a project inside the repository to its own folder", async () => {
    const dir = join(repo, "src");
    const status = await readStatus(dir);
    const { files } = await readChanges(dir, "branch", status);
    expect(files.map((f) => f.path)).toEqual(["app.ts", "feature.ts"]);
    const diff = await readFileDiff(dir, "working", status, "app.ts");
    expect(diff.lines.at(-1)).toMatchObject({ kind: "add", newLine: 5 });
  });

  it("reports folders that are not repositories, and repositories without commits", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    // A folder under the temp root that git might find a repository above: tell it not to look.
    const status = await readStatus(plain);
    if (status.repo) return; // a repository above %TEMP% on this machine: nothing to check here
    expect(status).toMatchObject({ repo: false, reason: "不是 git 仓库", branch: null });
    const fresh = join(root, "fresh");
    mkdirSync(fresh);
    run(fresh, "init", "-q", "-b", "main");
    writeFileSync(join(fresh, "a.txt"), "x\n");
    run(fresh, "add", "a.txt");
    const s = await readStatus(fresh);
    expect(s).toMatchObject({ repo: true, branch: "main", head: null, base: null, mergeBase: null });
    expect((await readChanges(fresh, "working", s)).files.map((f) => [f.path, f.status, f.additions])).toEqual([["a.txt", "added", 1]]);
    rmSync(join(fresh, ".git"), { recursive: true, force: true });
  });
});
