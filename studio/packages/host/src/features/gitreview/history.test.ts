import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GIT_EMPTY_TREE, isCommitRef } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { GitError, parseLog, readCommit, readCommitFileDiff, readLog } from "./git.js";

// S13-B commit history against a real (temporary) repository: the log, one commit's files, and one file of a commit.

const SHA = "a".repeat(40);

describe("git log parsing", () => {
  it("reads commits from the unit / record separated format", () => {
    const out = `${SHA}\x1f${"b".repeat(40)} ${"c".repeat(40)}\x1f张三\x1fz@x.cn\x1f2026-10-14T09:00:00+08:00\x1fMerge: a | b\x1e\n${"b".repeat(40)}\x1f\x1fAMO\x1fa@b.c\x1f2026-10-13T09:00:00+08:00\x1froot\x1e\n`;
    expect(parseLog(out)).toEqual([
      { sha: SHA, parents: ["b".repeat(40), "c".repeat(40)], author: "张三", email: "z@x.cn", date: "2026-10-14T09:00:00+08:00", subject: "Merge: a | b" },
      { sha: "b".repeat(40), parents: [], author: "AMO", email: "a@b.c", date: "2026-10-13T09:00:00+08:00", subject: "root" },
    ]);
    expect(parseLog("")).toEqual([]);
    expect(parseLog("not a commit\x1e")).toEqual([]);
  });

  it("takes 7 to 64 hex digits as a commit, nothing else", () => {
    for (const ok of ["abc1234", SHA, "f".repeat(64)]) expect(isCommitRef(ok)).toBe(true);
    for (const bad of ["abc123", "HEAD", "abc1234~1", "ABC1234", "--all", "g".repeat(7), "a".repeat(65), 7]) expect(isCommitRef(bad)).toBe(false);
  });
});

let root: string;
let repo: string;
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
const commit = (who: string, message: string) => run(repo, "-c", `user.name=${who}`, "-c", `user.email=${who.toLowerCase()}@test.invalid`, "commit", "-q", "-m", message);
const rev = (ref: string) => run(repo, "rev-parse", ref).trim();

// git is a process per call: slow on a loaded machine (the whole suite runs in parallel).
describe("a repository's history", { timeout: 30_000 }, () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-history-"));
    repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    run(repo, "init", "-q", "-b", "main");
    run(repo, "config", "core.autocrlf", "false");
    writeFileSync(join(repo, "README.md"), "# Game\n");
    writeFileSync(join(repo, "src", "drop.lua"), "local rate = 0.1\nreturn rate\n");
    writeFileSync(join(repo, "src", "old.lua"), "return 'old'\nreturn 'kept'\nreturn 'same'\n");
    run(repo, "add", ".");
    commit("Alice", "base");
    writeFileSync(join(repo, "src", "drop.lua"), "local rate = 0.25\nreturn rate\n");
    run(repo, "mv", "src/old.lua", "src/renamed.lua");
    run(repo, "rm", "-q", "README.md");
    run(repo, "add", ".");
    commit("Bob", "tune drop rate");
    run(repo, "checkout", "-q", "-b", "side");
    writeFileSync(join(repo, "side.txt"), "side\n");
    run(repo, "add", ".");
    commit("Bob", "side work");
    run(repo, "checkout", "-q", "main");
    writeFileSync(join(repo, "main.txt"), "main\n");
    run(repo, "add", ".");
    commit("Alice", "main work");
    run(repo, "-c", "user.name=Alice", "-c", "user.email=alice@test.invalid", "merge", "-q", "--no-ff", "-m", "merge side", "side");
  }, 60_000);

  afterAll(() => removeTempDir(root));

  it("lists HEAD's commits newest first, with authors, parents and whether more are left", async () => {
    const log = await readLog(repo);
    expect(log.branch).toBe("main");
    expect(log.head).toBe(rev("HEAD"));
    expect(log.truncated).toBe(false);
    expect(log.commits.map((c) => c.subject)).toEqual(["merge side", "main work", "side work", "tune drop rate", "base"]);
    expect(log.commits[0]!.parents).toEqual([rev("HEAD^1"), rev("HEAD^2")]);
    expect(log.commits.at(-1)).toMatchObject({ author: "Alice", email: "alice@test.invalid", parents: [] });
    expect(log.commits[3]!.date).toMatch(/^\d{4}-\d\d-\d\dT/);
    const two = await readLog(repo, 2);
    expect(two.commits.map((c) => c.subject)).toEqual(["merge side", "main work"]);
    expect(two.truncated).toBe(true);
  });

  it("keeps a project inside the repository to the commits that touch its folder", async () => {
    const log = await readLog(join(repo, "src"));
    expect(log.commits.map((c) => c.subject)).toEqual(["tune drop rate", "base"]);
  });

  it("reads one commit's files against its first parent; a root commit against the empty tree", async () => {
    const tune = rev("HEAD~1~1");
    const changes = await readCommit(repo, tune.slice(0, 7));
    expect(changes.commit).toMatchObject({ sha: tune, subject: "tune drop rate", author: "Bob" });
    expect(changes.base).toBe(rev(`${tune}^`));
    expect(changes.files.map((f) => [f.path, f.status, f.additions, f.deletions, f.oldPath ?? ""])).toEqual([
      ["README.md", "deleted", 0, 1, ""],
      ["src/drop.lua", "modified", 1, 1, ""],
      ["src/renamed.lua", "renamed", 0, 0, "src/old.lua"],
    ]);
    const first = await readCommit(repo, rev("HEAD~1~1~1"));
    expect(first.base).toBe(GIT_EMPTY_TREE);
    expect(first.files.map((f) => [f.path, f.status])).toEqual([
      ["README.md", "added"],
      ["src/drop.lua", "added"],
      ["src/old.lua", "added"],
    ]);
    // A merge shows what it brought in from the side branch (against its first parent).
    expect((await readCommit(repo, rev("HEAD"))).files.map((f) => f.path)).toEqual(["side.txt"]);
    // In a project folder: paths relative to it, other folders left out.
    expect((await readCommit(join(repo, "src"), tune)).files.map((f) => f.path)).toEqual(["drop.lua", "renamed.lua"]);
  });

  it("refuses names that are not commit ids, and says when a commit is not there", async () => {
    await expect(readCommit(repo, "HEAD")).rejects.toThrow(GitError);
    await expect(readCommit(repo, "--all")).rejects.toThrow(/bad commit/);
    await expect(readCommit(repo, "0000000")).rejects.toThrow(/not found/);
  });

  it("reads one file of a commit: its changes, or the file itself for a pure rename", async () => {
    const tune = rev("HEAD~1~1");
    const base = rev(`${tune}^`);
    const diff = await readCommitFileDiff(repo, base, tune, "src/drop.lua");
    expect(diff.commit).toBe(tune);
    expect(diff.lines.map((l) => `${l.kind}:${l.oldLine ?? "-"}:${l.newLine ?? "-"}:${l.text}`)).toEqual(["del:1:-:local rate = 0.1", "add:-:1:local rate = 0.25", "context:2:2:return rate"]);
    expect(diff.hunks).toHaveLength(1);
    const renamed = await readCommitFileDiff(repo, base, tune, "src/renamed.lua", "src/old.lua");
    expect(renamed.lines.map((l) => l.kind)).toEqual(["context", "context", "context"]);
    expect(renamed.lines[0]!.text).toBe("return 'old'");
    const deleted = await readCommitFileDiff(repo, base, tune, "README.md");
    expect(deleted.lines).toEqual([{ kind: "del", oldLine: 1, newLine: null, text: "# Game" }]);
    // From the project folder, with paths relative to it.
    expect((await readCommitFileDiff(join(repo, "src"), base, tune, "drop.lua")).lines).toHaveLength(3);
    await expect(readCommitFileDiff(repo, base.slice(0, 7), tune, "src/drop.lua")).rejects.toThrow(/full commit ids/);
    await expect(readCommitFileDiff(repo, base, tune, "../outside.txt")).rejects.toThrow(/outside the project/);
  });

  it("has no history in a repository without commits", async () => {
    const fresh = join(root, "fresh");
    mkdirSync(fresh);
    run(fresh, "init", "-q", "-b", "main");
    expect(await readLog(fresh)).toEqual({ branch: "main", head: null, commits: [], truncated: false });
  });
});
