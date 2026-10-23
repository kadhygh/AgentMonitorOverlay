import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { addGitExclude, readGitExclude } from "./git-exclude.js";

// 一键忽略 .amo/ (2026-10-23): a project's extension packs left out of git by one line in .git/info/exclude.

let root: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=AMO Test", "-c", "user.email=amo@test.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
const exclude = (repo: string) => readFileSync(join(repo, ".git", "info", "exclude"), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-exclude-"));
});

afterEach(() => removeTempDir(root));

describe("git exclude of .amo/", () => {
  it("adds /.amo/ once to the repository's exclude file, then reads it as excluded", async () => {
    const repo = join(root, "game");
    mkdirSync(repo);
    git(repo, "init", "-q");
    expect(await readGitExclude(repo)).toEqual({ git: true, excluded: false, source: null, entry: "/.amo/", tracked: 0 });

    const after = await addGitExclude(repo);
    expect(after).toMatchObject({ excluded: true, entry: "/.amo/" });
    expect(after.source).toMatch(/info[\\/]exclude:\d+$/);
    expect(exclude(repo)).toMatch(/# AMO Studio[^\n]*\n\/\.amo\/\n$/);

    await addGitExclude(repo);
    expect(exclude(repo).match(/\/\.amo\//g)).toHaveLength(1);
    // git really leaves the packs out.
    mkdirSync(join(repo, ".amo", "packs", "demo"), { recursive: true });
    writeFileSync(join(repo, ".amo", "packs", "demo", "pack.json"), "{}");
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("a project inside a larger repository gets its own sub path; a .gitignore rule counts as excluded", async () => {
    const repo = join(root, "mono");
    const sub = join(repo, "tools", "game");
    mkdirSync(sub, { recursive: true });
    git(repo, "init", "-q");
    expect((await readGitExclude(sub)).entry).toBe("/tools/game/.amo/");
    expect((await addGitExclude(sub)).excluded).toBe(true);
    expect(exclude(repo)).toContain("/tools/game/.amo/\n");

    const other = join(root, "other");
    mkdirSync(other);
    git(other, "init", "-q");
    writeFileSync(join(other, ".gitignore"), "node_modules/\n.amo/\n");
    const state = await addGitExclude(other);
    expect(state).toMatchObject({ excluded: true, source: ".gitignore:2" });
    expect(exclude(other)).not.toContain(".amo");
  });

  it("counts tracked files under .amo/, and says when the folder is not in git", async () => {
    const repo = join(root, "shared");
    mkdirSync(join(repo, ".amo", "packs"), { recursive: true });
    git(repo, "init", "-q");
    writeFileSync(join(repo, ".amo", "packs", "README.md"), "team packs\n");
    git(repo, "add", ".");
    expect((await readGitExclude(repo)).tracked).toBe(1);

    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(await addGitExclude(plain)).toMatchObject({ git: false, excluded: false });
  });
});
