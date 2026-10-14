import { describe, expect, it } from "vitest";
import type { GitCommit } from "@amo-studio/protocol";
import { filterCommits, markWords, queryWords, shortSha } from "./history.js";

const commit = (sha: string, author: string, subject: string): GitCommit => ({ sha: sha.padEnd(40, "0"), parents: [], author, email: `${author.toLowerCase()}@x.cn`, date: "2026-10-14T09:00:00+08:00", subject });
const commits = [commit("abc1234", "Alice", "调整掉落概率"), commit("def5678", "Bob", "Fix drop table"), commit("0a1b2c3", "张三", "merge drop branch")];

describe("commit search", () => {
  it("matches every word against the hash, author and subject, case aside", () => {
    expect(filterCommits(commits, "").map((c) => c.author)).toEqual(["Alice", "Bob", "张三"]);
    expect(filterCommits(commits, "DROP").map((c) => c.author)).toEqual(["Bob", "张三"]);
    expect(filterCommits(commits, "drop bob").map((c) => c.author)).toEqual(["Bob"]);
    expect(filterCommits(commits, "def56").map((c) => c.author)).toEqual(["Bob"]);
    expect(filterCommits(commits, "掉落").map((c) => c.author)).toEqual(["Alice"]);
    expect(filterCommits(commits, "张三 merge").map((c) => c.author)).toEqual(["张三"]);
    expect(filterCommits(commits, "alice@x")).toHaveLength(1);
    expect(filterCommits(commits, "nothing")).toEqual([]);
  });

  it("marks the hits in what a row shows", () => {
    expect(markWords("Fix drop table", queryWords("DROP"))).toEqual([
      { text: "Fix ", hit: false },
      { text: "drop", hit: true },
      { text: " table", hit: false },
    ]);
    expect(markWords("aaa", ["aa"])).toEqual([{ text: "aaa", hit: true }]);
    expect(markWords("abc", [])).toEqual([{ text: "abc", hit: false }]);
    expect(markWords("", ["a"])).toEqual([]);
    expect(shortSha("abcdef1234")).toBe("abcdef1");
  });
});
