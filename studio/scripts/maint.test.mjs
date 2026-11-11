import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addItem, load, mutate, noteRelease, roundText, setItem, startRound } from "./maint.mjs";

// 维护记录 (2026-11-11): rounds, numbered items, and the versions their commits went out in.
let dir;
let file;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "amo-maint-"));
  file = join(dir, "amo-maint.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const git = (...a) => execFileSync("git", ["-C", join(import.meta.dirname, ".."), ...a], { encoding: "utf8" }).trim();

describe("maint", () => {
  it("numbers rounds and their items; a new round ends the last and lists what it left open", () => {
    expect(mutate((r) => startRound(r, { n: 12 }), file).round.n).toBe(12);
    expect(mutate((r) => addItem(r, { kind: "bug", title: "修 Focus 闪烁", issue: "37" }), file)).toMatchObject({ id: "R12-1", status: "doing", issue: 37 });
    expect(mutate((r) => addItem(r, { kind: "small", title: "画布缩放记住" }), file).id).toBe("R12-2");
    mutate((r) => setItem(r, "r12-1", { status: "done", note: "合进 master" }), file);
    expect(() => mutate((r) => addItem(r, { kind: "nope", title: "x" }), file)).toThrow(/种类/);
    expect(() => mutate((r) => setItem(r, "R12-9", {}), file)).toThrow(/没有 R12-9/);
    expect(() => mutate((r) => setItem(r, "R12-1", { status: "nope" }), file)).toThrow(/状态/);

    const { round, ended, left } = mutate((r) => startRound(r), file);
    expect(round.n).toBe(13);
    expect(ended.n).toBe(12);
    expect(left.map((i) => i.id)).toEqual(["R12-2"]);
    expect(mutate((r) => addItem(r, { kind: "feature", title: "分支" }), file).id).toBe("R13-1");
    expect(() => mutate((r) => startRound(r, { n: 13 }), file)).toThrow(/已经有/);
    expect(() => mutate((r) => startRound(r, { n: 2 }), file)).toThrow(/只能往上加/);

    const record = load(file);
    expect(record.rounds.map((r) => [r.n, Boolean(r.endedAt)])).toEqual([[12, true], [13, false]]);
    expect(record.rounds[0].items[0].notes.map((n) => n.text)).toEqual(["合进 master"]);
    expect(roundText(record.rounds[0])).toMatch(/第 12 轮.*2 项：1 做完、1 进行中[\s\S]*R12-1 +修 bug +做完 +修 Focus 闪烁  #37/);
  });

  it("an item without a round going on is refused", () => {
    expect(() => mutate((r) => addItem(r, { kind: "bug", title: "x" }), file)).toThrow(/round start/);
  });

  it("a release gives its versions to the items whose commits are in it and touch a tool that went out", () => {
    // Two real commits of this repository: one in host, one in the app's CHANGELOG only.
    const host = git("log", "-1", "--format=%H", "--", "packages/host/src");
    const head = git("rev-parse", "HEAD");
    mutate((r) => startRound(r, { n: 1 }), file);
    mutate((r) => {
      r.rounds[0].startedAt = "2026-01-01T00:00:00.000Z";
      addItem(r, { kind: "bug", title: "a" });
      addItem(r, { kind: "bug", title: "b" });
      addItem(r, { kind: "bug", title: "c" });
      setItem(r, "R1-1", { status: "done", commits: [host] });
      setItem(r, "R1-2", { commits: [host] });
      setItem(r, "R1-3", { status: "dropped", commits: [host] });
    }, file);
    expect(() => mutate((r) => setItem(r, "R1-1", { commits: ["not-a-commit"] }), file)).toThrow(/不认识/);

    const tools = [
      { label: "AMO Studio", version: "0.9.99", paths: ["studio/packages/host"] },
      { label: "AMO 便签", version: "0.9.50", paths: ["studio/packages/notes/does-not-exist"] },
    ];
    expect(mutate((r) => noteRelease(r, head, tools), file).map((i) => i.id)).toEqual(["R1-1", "R1-2"]);
    const items = load(file).rounds[0].items;
    expect(items[0]).toMatchObject({ status: "released", released: { "AMO Studio": "0.9.99" } });
    // Still 进行中: the version is noted, the status stays.
    expect(items[1]).toMatchObject({ status: "doing", released: { "AMO Studio": "0.9.99" } });
    expect(items[2]).toMatchObject({ status: "dropped", released: {} });
    // The next build does not take it again.
    expect(mutate((r) => noteRelease(r, head, [{ ...tools[0], version: "0.9.100" }]), file)).toEqual([]);
  });
});
