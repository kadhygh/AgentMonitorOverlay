import { describe, expect, it } from "vitest";
import type { ReviewRead, SessionItem } from "@amo-studio/protocol";
import { parseBlocks } from "../lib/markdown.js";
import { buildTranscript } from "./turns.js";
import { blocksOf, clickRead, flagTotal, isFlagged, nextUnread, plainStart, readBlocks, readCount, readDone, readKeys, readLine, readUpTo, reviewKey, unfinished } from "./reviewLogic.js";

// 审阅进度 (第二版 2026-11-16): which reply a round is read by, its blocks, what a click on the line at its right makes
// of it, what 复盘 counts and where it goes next.

let seq = 0;
const base = (turnId: string) => ({ id: `i${++seq}`, sessionId: "s", seq, createdAt: "2026-11-16T00:00:00.000Z", raw: { runtime: "codex" as const, method: "x", turnId } });
const turn = (turnId: string, state: "running" | "completed" = "completed"): SessionItem => ({ ...base(turnId), type: "turn", turnId, state, startedAt: "2026-11-16T00:00:00.000Z" });
const user = (text: string, t: string): SessionItem => ({ ...base(t), type: "user", text });
const agent = (markdown: string, t: string, streaming = false): SessionItem => ({ ...base(t), type: "agent", markdown, streaming });
const tool = (t: string, name: string): SessionItem => ({ ...base(t), type: "tool", name, summary: name, status: "completed" }) as SessionItem;

const read = (n: ReviewRead["read"], flags: number[] = []): ReviewRead => ({ read: n, flags: flags.map((block) => ({ block, quote: "" })) });

describe("审阅进度 in the conversation", () => {
  it("keys a round by its final reply, once it is done, with how many blocks it has", () => {
    const done = agent("改好了\n\n- 一\n- 二", "t1");
    const between = agent("先看一下", "t1");
    const items = [turn("t1"), user("改一下", "t1"), between, tool("t1", "shell"), done, turn("t2", "running"), user("再来", "t2"), agent("正在写", "t2", true)];
    const segs = buildTranscript(items, true);
    expect(segs.map(reviewKey)).toEqual([done.id, null]);
    expect(readKeys(segs)).toEqual([{ id: done.id, of: 3 }]);
    // An empty reply has nothing to read.
    expect(readKeys(buildTranscript([turn("t3"), user("嗯", "t3"), agent("  ", "t3")], false))).toEqual([]);
  });

  it("splits a reply into blocks: paragraphs, list items, table rows, code; a heading goes with the block after it; a divider is none", () => {
    const md = [
      "我先看了现有的 **70 张** Boss 掉落表和读它们的三处代码，结论是可以合，不用动存档。",
      "",
      "## 一、表怎么合",
      "",
      "- 等级段按 10 级一档",
      "  - 子项跟着它",
      "- Boss 专属掉落留在 `BossDrop`",
      "",
      "---",
      "",
      "| 位置 | 改法 |",
      "| --- | --- |",
      "| DropService.Roll | 改成查 BossDrop |",
      "| GmDropCommand | 一起改 |",
      "",
      "```cs",
      "",
      "var rows = BossDrop.Query(bossId);",
      "```",
      "",
      "> 有一处我拿不准",
      "",
      "### 结尾的标题",
    ].join("\n");
    const blocks = readBlocks(parseBlocks(md));
    expect(blocks.map((b) => b.parts)).toEqual([
      [{ at: 0 }],
      [{ at: 1 }, { at: 2, li: 0 }],
      [{ at: 2, li: 1 }],
      // at 3 is the divider.
      [{ at: 4, head: true }, { at: 4, tr: 0 }],
      [{ at: 4, tr: 1 }],
      [{ at: 5 }],
      [{ at: 6 }],
      [{ at: 7 }],
    ]);
    expect(blocks.map((b) => b.quote)).toEqual([
      "我先看了现有的 70 张 Boss 掉落表和读它们的三处代码，结论是可以合，不用…",
      "等级段按 10 级一档",
      "Boss 专属掉落留在 BossDrop",
      "DropService.Roll · 改成查 BossDrop",
      "GmDropCommand · 一起改",
      "var rows = BossDrop.Query(bossId);",
      "有一处我拿不准",
      "结尾的标题",
    ]);
    // Worked out once per row.
    const row = { markdown: md };
    expect(blocksOf(row)).toBe(blocksOf(row));
    expect(plainStart("看 [这份方案](plans/a.md) 和 ![图](a.png)")).toBe("看 这份方案 和 图");
  });

  it("reads down to the block clicked, moves with the next click and is taken back on the same block", () => {
    expect(readCount(undefined, 5)).toBe(0);
    expect(clickRead(undefined, 2, 5)).toBe(3);
    expect(clickRead(read(3), 4, 5)).toBe(5);
    expect(clickRead(read(3), 0, 5)).toBe(1);
    expect(clickRead(read(3), 2, 5)).toBe(0);
    // 到这里为止都读过: read to the end, so the last block is where it stands.
    expect(readCount(read("all"), 5)).toBe(5);
    expect(clickRead(read("all"), 4, 5)).toBe(0);
    // Marked when the reply had more blocks: no further than it has now.
    expect(readCount(read(7), 5)).toBe(5);
    expect(isFlagged(read(0, [1, 3]), 3)).toBe(true);
    expect(isFlagged(read(0, [1, 3]), 2)).toBe(false);
  });

  it("says how far a reply was read, counts what is left and the 「!」, and marks up to a reply", () => {
    expect([readLine(undefined, 4), readLine(read(2), 4), readLine(read(4), 4), readLine(read("all"), 4)]).toEqual(["还没读", "读到第 2 / 4 块", "读到底了", "读到底了"]);
    expect(readDone(read(3), 4)).toBe(false);
    const keys = [
      { id: "a", of: 2 },
      { id: "b", of: 3 },
      { id: "c", of: 1 },
      { id: "d", of: 4 },
    ];
    const replies = { a: read("all"), b: read(1, [2]), d: read(0, [0, 1]) };
    expect(unfinished(keys, replies).map((k) => k.id)).toEqual(["b", "c", "d"]);
    expect(flagTotal(keys, replies)).toBe(3);
    expect(readUpTo(keys, replies, "c")).toEqual(["b", "c"]);
    expect(readUpTo(keys, replies, "gone")).toEqual([]);
  });

  it("finds the next place not read below the reply being read, from the top again past the last", () => {
    const keys = [
      { id: "a", of: 2 },
      { id: "b", of: 3 },
      { id: "c", of: 1 },
    ];
    const replies = { a: read("all"), b: read(1) };
    expect(nextUnread(keys, replies, null)).toEqual({ id: "b", block: 1 });
    expect(nextUnread(keys, replies, "b")).toEqual({ id: "c", block: 0 });
    expect(nextUnread(keys, replies, "c")).toEqual({ id: "b", block: 1 });
    expect(nextUnread(keys, { a: read("all"), b: read(3), c: read(1) }, null)).toBeNull();
  });
});
