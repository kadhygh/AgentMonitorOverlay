import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "@amo-studio/testkit";
import { git } from "../features/gitreview/git.js";
import { startGitTrace, tracedRequest } from "./git-trace.js";

let dir: string | undefined;
afterEach(() => {
  if (dir) removeTempDir(dir);
  dir = undefined;
});

describe("git trace", () => {
  it("logs each git command with the request that asked for it, how many ran at once and its output size", async () => {
    dir = mkdtempSync(join(tmpdir(), "amo-studio-test-gittrace-"));
    startGitTrace(dir);
    await tracedRequest("GET /api/workspaces/ws-1/git/changes?range=working", () => Promise.all([git(dir!, ["--version"]), git(dir!, ["--version"])]));
    await git(dir, ["rev-parse", "--no-such-option"]).catch(() => undefined);
    const lines = readFileSync(join(dir, "logs", "git-trace.log"), "utf8").trim().split("\n");
    expect(lines[0]).toMatch(/^--- start /);
    const traced = lines.filter((l) => l.includes(" git --version "));
    expect(traced).toHaveLength(2);
    for (const l of traced) expect(l).toMatch(/ms running=[12] \[amo-studio-test-gittrace-\w+\] git --version → \d+B · GET \/api\/workspaces\/ws-1\/git\/changes\?range=working$/);
    expect(traced.some((l) => l.includes("running=2"))).toBe(true);
    expect(lines.at(-1)).toMatch(/git rev-parse --no-such-option → error: .* · \(no request\)$/);
  });
});
