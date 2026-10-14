import { describe, expect, it } from "vitest";
import { composeGitReviewMessage, diffHunks, type GitChangedFile, type GitDiffLine, type GitReviewComment, type Session } from "@amo-studio/protocol";
import { changeStarts, diffRows, draftCounts, latestMainSession, listOrder, parseReviewHash, placeComments, reviewHash, sessionChoices, step } from "./logic.js";

const file = (path: string, extra: Partial<GitChangedFile> = {}): GitChangedFile => ({ path, status: "modified", additions: 1, deletions: 0, binary: false, ...extra });

// 12 lines: line 2 changed (del + add), line 10 added.
const lines: GitDiffLine[] = [
  { kind: "context", oldLine: 1, newLine: 1, text: "a" },
  { kind: "del", oldLine: 2, newLine: null, text: "b" },
  { kind: "add", oldLine: null, newLine: 2, text: "B" },
  ...Array.from({ length: 7 }, (_, i): GitDiffLine => ({ kind: "context", oldLine: i + 3, newLine: i + 3, text: `c${i + 3}` })),
  { kind: "add", oldLine: null, newLine: 10, text: "new" },
  { kind: "context", oldLine: 10, newLine: 11, text: "end" },
];
const diff = { lines, hunks: diffHunks(lines) };

const comment = (over: Partial<GitReviewComment>): GitReviewComment => ({
  id: "rc-1",
  workspaceId: "ws",
  range: "working",
  path: "src/a.ts",
  side: "new",
  line: 2,
  lineText: "B",
  note: "n",
  state: "draft",
  sessionId: null,
  createdAt: "2026-10-13T10:00:00.000Z",
  updatedAt: "2026-10-13T10:00:00.000Z",
  sentAt: null,
  ...over,
});

describe("Git Review window logic", () => {
  it("round-trips its address", () => {
    expect(reviewHash({ workspaceId: "ws-1", sessionId: "s-2" })).toBe("#review?workspace=ws-1&session=s-2");
    expect(parseReviewHash("#review?workspace=ws-1&session=s-2")).toEqual({ workspaceId: "ws-1", sessionId: "s-2" });
    expect(parseReviewHash("#review?workspace=ws-1")).toEqual({ workspaceId: "ws-1" });
    expect(parseReviewHash("#focus")).toBeNull();
    expect(parseReviewHash("#review")).toBeNull();
    // Stage 13: 用 git diff 看 opens the review at a file.
    const t = { workspaceId: "ws-1", file: "G:\\game\\src\\a b.cs", nonce: "3" };
    expect(parseReviewHash(reviewHash(t))).toEqual(t);
    expect(parseReviewHash("#review?workspace=ws-1&n=3")).toEqual({ workspaceId: "ws-1" });
    // A commit's window (S13-B): read-only, no session; a name that is not a commit id opens nothing.
    expect(reviewHash({ workspaceId: "ws-1", commit: "abc1234" })).toBe("#review?workspace=ws-1&commit=abc1234");
    expect(reviewHash({ workspaceId: "ws-1", commit: "abc1234", file: "a.cs", sessionId: "s" })).toBe("#review?workspace=ws-1&commit=abc1234");
    expect(parseReviewHash("#review?workspace=ws-1&commit=abc1234")).toEqual({ workspaceId: "ws-1", commit: "abc1234" });
    expect(parseReviewHash("#review?workspace=ws-1&commit=HEAD")).toBeNull();
  });

  it("lists files by full path, case aside, as Fork does", () => {
    const files = [file("b/z.ts"), file("README.md"), file("a/y.ts"), file("A/x.ts"), file("b/c/w.ts")];
    expect(listOrder(files).map((f) => f.path)).toEqual(["A/x.ts", "a/y.ts", "b/c/w.ts", "b/z.ts", "README.md"]);
  });

  it("shows every line in 完整文件 and the hunks with skipped lines in 只看改动", () => {
    const full = diffRows(diff, "full");
    expect(full).toHaveLength(12);
    expect(full[1]).toMatchObject({ kind: "line", key: "old:2", side: "old", number: 2 });
    expect(full[2]).toMatchObject({ key: "new:2", side: "new", number: 2 });
    const changes = diffRows(diff, "changes");
    expect(changes.filter((r) => r.kind === "hunk").map((r) => r.kind === "hunk" && [r.header, r.hidden])).toEqual([
      ["@@ -1,5 +1,5 @@", 0],
      ["@@ -7,4 +7,5 @@", 1],
    ]);
    expect(changes.filter((r) => r.kind === "line")).toHaveLength(11);
  });

  it("finds the starts of changes and steps between them", () => {
    const rows = diffRows(diff, "full");
    const starts = changeStarts(rows);
    expect(starts).toEqual([1, 10]);
    expect(step(starts, -1, 1)).toBe(1);
    expect(step(starts, 1, 1)).toBe(10);
    expect(step(starts, 10, 1)).toBe(10);
    expect(step(starts, 10, -1)).toBe(1);
    expect(step(starts, 1, -1)).toBe(1);
    expect(step([], 0, 1)).toBeNull();
  });

  it("puts comments under their lines; others are listed apart", () => {
    const onNew = comment({ id: "a", line: 2 });
    const onOld = comment({ id: "b", side: "old", line: 2 });
    const oldOtherRange = comment({ id: "c", side: "old", line: 2, range: "branch" });
    const farAway = comment({ id: "d", line: 6 });
    const otherFile = comment({ id: "e", path: "src/b.ts" });
    const all = [onNew, onOld, oldOtherRange, farAway, otherFile];
    const inChanges = placeComments(all, "src/a.ts", "working", diffRows(diff, "changes"));
    expect([...inChanges.placed].map(([k, list]) => [k, list.map((c) => c.id)])).toEqual([
      ["new:2", ["a"]],
      ["old:2", ["b"]],
    ]);
    expect(inChanges.elsewhere.map((c) => c.id)).toEqual(["c", "d"]);
    // 完整文件 shows line 6 too.
    expect(placeComments(all, "src/a.ts", "working", diffRows(diff, "full")).elsewhere.map((c) => c.id)).toEqual(["c"]);
    expect(draftCounts([...all, comment({ id: "f", state: "sent" })])).toEqual(new Map([["src/a.ts", 4], ["src/b.ts", 1]]));
  });

  it("offers the project's live sessions, newest first, and a task's latest main session", () => {
    const s = (id: string, over: Partial<Session>): Session =>
      ({ id, taskId: "t1", topicId: null, parentId: null, kind: "main", workspaceId: "ws", title: id, archivedAt: null, updatedAt: "2026-10-13T10:00:00.000Z", ...over }) as Session;
    const sessions = [
      s("old", { updatedAt: "2026-10-12T10:00:00.000Z" }),
      s("new", { updatedAt: "2026-10-13T12:00:00.000Z" }),
      s("fork", { parentId: "new", kind: "fork", updatedAt: "2026-10-13T13:00:00.000Z" }),
      s("gone", { archivedAt: "2026-10-13T00:00:00.000Z", updatedAt: "2026-10-13T14:00:00.000Z" }),
      s("elsewhere", { workspaceId: "other" }),
      s("topic", { taskId: null, topicId: "tp", updatedAt: "2026-10-11T10:00:00.000Z" }),
    ];
    const state = { sessions, tasks: [{ id: "t1", title: "掉落表" }], topics: [{ id: "tp", title: "数值" }] } as never;
    expect(sessionChoices(state, "ws")).toEqual([
      { id: "fork", label: "掉落表 · fork" },
      { id: "new", label: "掉落表 · new" },
      { id: "old", label: "掉落表 · old" },
      { id: "topic", label: "数值 · topic" },
    ]);
    expect(latestMainSession(sessions, "t1")?.id).toBe("new");
    expect(latestMainSession(sessions, "t9")).toBeNull();
  });

  it("composes the summary grouped by file, in line order", () => {
    const text = composeGitReviewMessage([
      comment({ path: "b.ts", line: 3, lineText: "x  ", note: "第二个文件" }),
      comment({ path: "a.ts", line: 9, lineText: "", note: "空行也能批" }),
      comment({ path: "a.ts", line: 1, side: "old", lineText: "gone()", note: "为什么删" }),
    ]);
    expect(text).toBe(
      "Git Review 批注：我看了改动，有 3 条批注。\n\n### a.ts\n\na.ts（旧版第 1 行，已删除）\n> gone()\n为什么删\n\na.ts:9\n> （空行）\n空行也能批\n\n### b.ts\n\nb.ts:3\n> x\n第二个文件",
    );
  });
});
