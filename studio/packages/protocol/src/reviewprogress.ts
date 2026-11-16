import type { Id } from "./entities.js";

// 审阅进度 (plans/review-progress.md, 测试功能「审阅进度」). 第二版 (2026-11-16; the user: 复盘功能，我想的是逐行确认或者标记看到
// 具体哪里 … 右侧加一个竖线，左键点击是标记读到哪里，右键则是标记那个感叹号有问题 … 没看的块做标注感受更好一些，然后审过的按钮
// 可以去掉了): each round's final reply is read block by block — a paragraph, a list's item, a table's row, a code block
// (ui/src/chat/reviewLogic.ts, readBlocks) — and the person marks how far they read it and which blocks have a problem.
// Nothing is recorded by itself. Kept by the Host (a remote copy's on the computer reading it), shared here so the Host
// and the conversation change it the same way (applyReviewChange).

/** A block the person marked 「!」 (有问题), with the start of its text (for the AI, and to check it later). */
export interface ReviewFlag {
  /** The block's number in its reply, from 0. */
  block: number;
  quote: string;
  /** Said to the AI with the person's next message (core/reviewprogress.ts, reviewProgressHint). */
  told?: boolean;
}

/** How far the person read one reply. */
export interface ReviewRead {
  /** The blocks read from the top (0: none); `all`: 到这里为止都读过 marked it read to the end. */
  read: number | "all";
  /** How many blocks it had when it was marked. */
  of?: number;
  /** The start of the last block read (`read` a number above 0). */
  at?: string;
  flags: ReviewFlag[];
}

/** One session's 审阅进度 on this computer: by the reply's row id. A reply not in it has not been marked. */
export interface ReviewProgress {
  sessionId: Id;
  replies: Record<Id, ReviewRead>;
}

/**
 * A change the conversation sends (PUT /api/sessions/:id/review-progress). `read`: read to block `blocks` of `of` (0:
 * not read, taken back); `flag`: a block's 「!」 on or off; `readUpTo`: these replies read to the end.
 */
export interface ReviewChange {
  read?: { id: Id; blocks: number; of: number; at?: string };
  flag?: { id: Id; block: number; quote: string; on: boolean };
  readUpTo?: Id[];
}

/** The length the texts kept with a mark are cut to (`at`, a flag's `quote`). */
export const REVIEW_QUOTE_MAX = 60;

const cut = (s: string) => (s.length > REVIEW_QUOTE_MAX ? s.slice(0, REVIEW_QUOTE_MAX) : s);

/**
 * The replies after a change (a new object; the one given is left as it was). A reply with nothing read and no 「!」
 * left is dropped. Ids are taken as they are: the Host checks them first.
 */
export function applyReviewChange(replies: Readonly<Record<Id, ReviewRead>>, change: ReviewChange): Record<Id, ReviewRead> {
  const next: Record<Id, ReviewRead> = { ...replies };
  const put = (id: Id, r: ReviewRead) => {
    if (r.read === 0 && !r.flags.length) delete next[id];
    else next[id] = r;
  };
  if (change.read) {
    const { id, of } = change.read;
    const blocks = Math.max(0, Math.min(change.read.blocks, of));
    const cur = next[id];
    put(id, { read: blocks, of, ...(blocks > 0 && change.read.at ? { at: cut(change.read.at) } : {}), flags: cur?.flags ?? [] });
  }
  if (change.flag) {
    const { id, block, on } = change.flag;
    const cur = next[id] ?? { read: 0, flags: [] };
    const others = cur.flags.filter((f) => f.block !== block);
    const had = cur.flags.find((f) => f.block === block);
    const flags = on ? [...others, had ?? { block, quote: cut(change.flag.quote) }].sort((a, b) => a.block - b.block) : others;
    put(id, { ...cur, flags });
  }
  for (const id of change.readUpTo ?? []) {
    const cur = next[id];
    next[id] = { read: "all", ...(cur?.of ? { of: cur.of } : {}), flags: cur?.flags ?? [] };
  }
  return next;
}
