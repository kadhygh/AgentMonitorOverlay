import type { ReviewRead } from "@amo-studio/protocol";
import { parseBlocks, type Block } from "../lib/markdown.js";
import type { Segment } from "./turns.js";

// 审阅进度 in the conversation (plans/review-progress.md, behind 测试功能「审阅进度」). 第二版 (2026-11-16; the user:
// 复盘功能，我想的是逐行确认或者标记看到具体哪里 … 右侧加一个竖线，左键点击是标记读到哪里，右键则是标记那个感叹号有问题 … 没看的
// 块做标注感受更好一些，然后审过的按钮可以去掉了): each round's final reply is read block by block. What is worked out
// without the page — which reply counts, what its blocks are, what a click makes of it, how many are left, where the
// next unread place is — is here, so it is tested on its own; ReviewProgress.tsx only finds the blocks' elements.

/**
 * The reply a round is read by: its final answer, once the round is over and the answer done (a reply still being
 * written is not one yet). Its row's id is the key the Host keeps the marks under. Null for a round without one.
 */
export function reviewKey(seg: Segment): string | null {
  const answer = seg.answer;
  return !seg.running && answer && !answer.streaming && answer.markdown.trim() ? answer.id : null;
}

/**
 * One block of a reply as the person reads it, by the Markdown's top-level blocks (lib/markdown.tsx, the `.md`'s
 * children in order): `at` the top-level block, `li` a top-level item of its list, `tr` a row of its table's body,
 * `head` its table's header row.
 */
export interface ReadPart {
  at: number;
  li?: number;
  tr?: number;
  head?: true;
}

export interface ReadBlock {
  /** The elements it is drawn over, top to bottom (a heading before the block it goes with). */
  parts: ReadPart[];
  /** Its text's start, plain, for the Host and the AI (REVIEW_QUOTE_MAX in protocol cuts what is longer). */
  quote: string;
}

/** How much of a block's text is kept to say which block it is. */
const QUOTE_CHARS = 40;

/** A divider (`---`, `***`, `___`): the Markdown here draws it as a paragraph; it is not a block to read. */
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;

/** Inline Markdown taken off, spaces made one, cut short with 「…」. */
export function plainStart(text: string, max = QUOTE_CHARS): string {
  const plain = text
    .replace(/!\[([^\]]*)\]\([^)\s]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

/**
 * A reply's blocks (the user, 2026-11-16, with the demo: 一段话、列表的一条、表格的一行、一个代码块，小标题跟着它下面那一块):
 * a paragraph, a code block, a quote are one each; a list is one per top-level item (its nested lists go with it); a
 * table one per body row (the header with the first); a heading goes with the block after it; a divider is none.
 */
export function readBlocks(blocks: readonly Block[]): ReadBlock[] {
  const out: ReadBlock[] = [];
  let heads: ReadPart[] = [];
  let headText = "";
  const push = (parts: ReadPart[], text: string) => {
    out.push({ parts: [...heads, ...parts], quote: plainStart(text) });
    heads = [];
    headText = "";
  };
  blocks.forEach((b, at) => {
    switch (b.kind) {
      case "heading":
        heads.push({ at });
        headText ||= b.text;
        return;
      case "list":
        b.list.items.forEach((item, li) => push([{ at, li }], item.text));
        return;
      case "table":
        if (!b.rows.length) return push([{ at }], b.header.join(" · "));
        b.rows.forEach((row, tr) => push(tr === 0 ? [{ at, head: true }, { at, tr }] : [{ at, tr }], row.join(" · ")));
        return;
      case "code":
        return push([{ at }], b.text.split("\n").find((l) => l.trim()) ?? b.lang);
      case "paragraph":
        if (RULE.test(b.text)) return;
        return push([{ at }], b.text);
      default:
        return push([{ at }], b.text);
    }
  });
  // A heading with nothing after it is read on its own.
  if (heads.length) push([], headText);
  return out;
}

const cache = new WeakMap<object, ReadBlock[]>();

/** A reply's blocks, worked out once per row (a row that changes is a new object). */
export function blocksOf(reply: { markdown: string }): ReadBlock[] {
  let blocks = cache.get(reply);
  if (!blocks) {
    blocks = readBlocks(parseBlocks(reply.markdown));
    cache.set(reply, blocks);
  }
  return blocks;
}

/** A reply that is read, and how many blocks it has. */
export interface ReadKey {
  id: string;
  of: number;
}

/** The rounds' replies, in order. */
export function readKeys(segments: readonly Segment[]): ReadKey[] {
  return segments.flatMap((s) => {
    const id = reviewKey(s);
    return id && s.answer ? [{ id, of: blocksOf(s.answer).length }] : [];
  });
}

/** How many blocks of a reply of `of` were read from the top. */
export function readCount(r: ReviewRead | undefined, of: number): number {
  if (!r) return 0;
  return r.read === "all" ? of : Math.min(r.read, of);
}

/**
 * A left click on block `block`: read from the top down to it; on the block it is read to already, taken back (the
 * user's demo: 在同一处再点一次是取消). The blocks read after it.
 */
export function clickRead(r: ReviewRead | undefined, block: number, of: number): number {
  return readCount(r, of) === block + 1 ? 0 : block + 1;
}

export function isFlagged(r: ReviewRead | undefined, block: number): boolean {
  return !!r?.flags.some((f) => f.block === block);
}

/** Read to the end (an empty reply has nothing to read). */
export function readDone(r: ReviewRead | undefined, of: number): boolean {
  return readCount(r, of) >= of;
}

/** The replies not read to the end, in order. */
export function unfinished(keys: readonly ReadKey[], replies: Readonly<Record<string, ReviewRead>>): ReadKey[] {
  return keys.filter((k) => !readDone(replies[k.id], k.of));
}

/** The 「!」 on these replies. */
export function flagTotal(keys: readonly ReadKey[], replies: Readonly<Record<string, ReviewRead>>): number {
  return keys.reduce((n, k) => n + (replies[k.id]?.flags.length ?? 0), 0);
}

/** 到这里为止都读过: this reply and the ones before it not read to the end. Empty when it is not one of them. */
export function readUpTo(keys: readonly ReadKey[], replies: Readonly<Record<string, ReviewRead>>, id: string): string[] {
  const at = keys.findIndex((k) => k.id === id);
  return at < 0 ? [] : unfinished(keys.slice(0, at + 1), replies).map((k) => k.id);
}

/**
 * 下一处没读的: the first block not read of the first reply not read to the end after the one being read (`after`: the
 * last reply above the place read, null at the top), and from the start again once there is none below.
 */
export function nextUnread(keys: readonly ReadKey[], replies: Readonly<Record<string, ReviewRead>>, after: string | null): { id: string; block: number } | null {
  const left = unfinished(keys, replies);
  if (!left.length) return null;
  const from = after === null ? -1 : keys.findIndex((k) => k.id === after);
  const next = left.find((k) => keys.indexOf(k) > from) ?? left[0]!;
  return { id: next.id, block: readCount(replies[next.id], next.of) };
}

/** 复盘's line at the end of a reply: how far it was read. */
export function readLine(r: ReviewRead | undefined, of: number): string {
  const n = readCount(r, of);
  return n >= of ? "读到底了" : n === 0 ? "还没读" : `读到第 ${n} / ${of} 块`;
}
