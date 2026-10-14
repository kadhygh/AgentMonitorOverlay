import { describe, expect, it } from "vitest";
import type { GitChangedFile, GitFileDiff } from "@amo-studio/protocol";
import { DiffCache, type DiffRequest } from "./diffcache.js";

const file = (path: string, changes = 2): GitChangedFile => ({ path, status: "modified", additions: changes, deletions: 0, binary: false });
const req = (path: string, changes?: number): DiffRequest => ({ range: "working", base: "a".repeat(40), file: file(path, changes) });
const diffOf = (r: DiffRequest): GitFileDiff => ({ range: r.range, path: r.file.path, binary: false, tooLarge: false, lines: [], hunks: [] });

/** A fetch whose answers the test releases by hand. */
function manual() {
  const calls: { req: DiffRequest; resolve(): void; reject(err: Error): void }[] = [];
  const fetchDiff = (r: DiffRequest) =>
    new Promise<GitFileDiff>((resolve, reject) => calls.push({ req: r, resolve: () => resolve(diffOf(r)), reject }));
  return { calls, fetchDiff };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("DiffCache", () => {
  it("reads a diff once: a second load joins the first, later ones come from the cache", async () => {
    const { calls, fetchDiff } = manual();
    const read: string[] = [];
    const cache = new DiffCache(fetchDiff, (d) => read.push(d.path));
    const a = cache.load(req("a.ts"));
    const b = cache.load(req("a.ts"));
    expect(calls).toHaveLength(1);
    calls[0]!.resolve();
    expect(await a).toBe(await b);
    expect(cache.peek(req("a.ts"))).toBe(await a);
    await cache.load(req("a.ts"));
    expect(calls).toHaveLength(1);
    expect(read).toEqual(["a.ts"]);
    // Another range or base is another diff.
    void cache.load({ ...req("a.ts"), range: "branch" });
    expect(calls).toHaveLength(2);
  });

  it("reads ahead two at a time, newest wishes first, skipping very large files", async () => {
    const { calls, fetchDiff } = manual();
    const cache = new DiffCache(fetchDiff);
    cache.prefetch([req("a"), req("b"), req("c"), req("huge", 5000)]);
    expect(calls.map((c) => c.req.file.path)).toEqual(["a", "b"]);
    // The pointer moved: what was still waiting is replaced.
    cache.prefetch([req("d"), req("a")]);
    expect(calls).toHaveLength(2);
    calls[0]!.resolve();
    await tick();
    expect(calls.map((c) => c.req.file.path)).toEqual(["a", "b", "d"]);
    calls[1]!.resolve();
    calls[2]!.resolve();
    await tick();
    expect(calls).toHaveLength(3);
    expect(cache.size).toBe(3);
  });

  it("keeps the most recently used diffs only", async () => {
    const cache = new DiffCache(async (r) => diffOf(r), undefined, 2);
    await cache.load(req("a"));
    await cache.load(req("b"));
    cache.peek(req("a"));
    await cache.load(req("c"));
    expect(cache.peek(req("b"))).toBeUndefined();
    expect(cache.peek(req("a"))).toBeDefined();
  });

  it("forgets everything on clear, and keeps no answer that arrives afterwards", async () => {
    const { calls, fetchDiff } = manual();
    const cache = new DiffCache(fetchDiff);
    const late = cache.load(req("a"));
    cache.clear();
    calls[0]!.resolve();
    await late;
    expect(cache.peek(req("a"))).toBeUndefined();
    void cache.load(req("a"));
    expect(calls).toHaveLength(2);
  });

  it("does not keep failures", async () => {
    let fail = true;
    const cache = new DiffCache(async (r) => {
      if (fail) throw new Error("git failed");
      return diffOf(r);
    });
    await expect(cache.load(req("a"))).rejects.toThrow("git failed");
    fail = false;
    expect((await cache.load(req("a"))).path).toBe("a");
  });
});
