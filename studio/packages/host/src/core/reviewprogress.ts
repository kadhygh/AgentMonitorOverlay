import type { Id, ReviewRead } from "@amo-studio/protocol";
import type { Store } from "../store/store.js";

// 审阅进度 (protocol/src/reviewprogress.ts, plans/review-progress.md): what Studio keeps of how far the person read a
// session's replies. One kv row per session (`review-progress:<sessionId>`). Here rather than in features/reviewprogress
// so the sessions feature can read what to tell the AI with the person's next message (reviewProgressHint) without
// depending on that feature — as 白板 and 脉络 do.

export interface ReviewState {
  replies: Record<Id, ReviewRead>;
  /** The partly read last reply the AI was told about, and how far (so the next message does not say it again). */
  toldRead?: { id: Id; read: number };
}

const key = (sessionId: Id) => `review-progress:${sessionId}`;

export function readReviewProgress(store: Store, sessionId: Id): ReviewState {
  const raw = store.getKv(key(sessionId))?.value;
  if (!raw) return { replies: {} };
  try {
    const v = JSON.parse(raw) as { replies?: Record<string, unknown>; marks?: Record<string, unknown>; toldRead?: { id?: unknown; read?: unknown } } | null;
    const replies: Record<Id, ReviewRead> = {};
    // 第一版 (11-16) kept 浏览过 / 审过 per reply: a 审过 one counts as read to the end; 浏览过 was recorded by itself
    // (第二版 records nothing by itself), so it is dropped.
    for (const [id, mark] of Object.entries(v?.marks ?? {})) if (mark === "reviewed") replies[id] = { read: "all", flags: [] };
    for (const [id, r] of Object.entries(v?.replies ?? {})) {
      const read = cleanRead(r);
      if (read) replies[id] = read;
    }
    const told = v?.toldRead;
    return { replies, ...(told && typeof told.id === "string" && typeof told.read === "number" ? { toldRead: { id: told.id, read: told.read } } : {}) };
  } catch {
    return { replies: {} };
  }
}

/** A reply's record as read back, or null when it is not one (kept data from a newer or broken Studio). */
function cleanRead(value: unknown): ReviewRead | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Partial<ReviewRead>;
  const read = r.read === "all" ? "all" : Number.isInteger(r.read) && (r.read as number) >= 0 ? (r.read as number) : null;
  if (read === null) return null;
  const flags = Array.isArray(r.flags) ? r.flags.filter((f) => f && Number.isInteger(f.block) && f.block >= 0 && typeof f.quote === "string").map((f) => ({ block: f.block, quote: f.quote, ...(f.told ? { told: true } : {}) })) : [];
  return { read, ...(Number.isInteger(r.of) && (r.of as number) > 0 ? { of: r.of } : {}), ...(typeof r.at === "string" && r.at ? { at: r.at } : {}), flags };
}

export function writeReviewProgress(store: Store, sessionId: Id, state: ReviewState): void {
  store.setKv(key(sessionId), JSON.stringify(state));
}

/** The first words of a reply's text, without Markdown's marks, to say which reply is meant. */
export function replyOpening(markdown: string, max = 20): string {
  const line = markdown
    .split("\n")
    .map((l) => l.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+|```.*$)/, "").replace(/[*`|]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim())
    .find((l) => l);
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** A block's start as the conversation sent it (cut short with 「…」 there). */
const quoted = (s: string) => (s ? `「${s}」` : "");

/**
 * What the AI is told with the person's next message (2026-11-16; the user marked blocks of its replies on the line at
 * their right): the blocks newly marked 「!」, one line each, by the reply's first words and the block's; and, when its
 * last reply was read only part of the way, how far. A reply never marked says nothing (not marked is not unread).
 * `told()` once the message went in. Empty when there is nothing to say.
 */
export function reviewProgressHint(store: Store, sessionId: Id): { lines: string[]; told(): void } {
  const state = readReviewProgress(store, sessionId);
  const fresh: Array<{ id: Id; flag: ReviewRead["flags"][number] }> = [];
  for (const [id, r] of Object.entries(state.replies)) for (const flag of r.flags) if (!flag.told) fresh.push({ id, flag });
  const lines: string[] = [];
  if (fresh.length) {
    // In the order the replies came (row seq), then the blocks.
    const seq = (id: Id) => store.getItem(id)?.seq ?? 0;
    fresh.sort((a, b) => seq(a.id) - seq(b.id) || a.flag.block - b.flag.block);
    lines.push(`人在你的回复上标了 ${fresh.length} 处「有问题」（人只标了是哪一段，没写哪里不对：这条消息里说了的照人说的办，没说的先自己重看这一段、找出可能的问题，拿不准就问人）：`);
    for (const { id, flag } of fresh) {
      const item = store.getItem(id);
      const opening = item?.type === "agent" ? replyOpening(item.markdown) : "";
      lines.push(`· ${opening ? `你那条开头是「${opening}」的回复` : "你的一条回复"}里，第 ${flag.block + 1} 段${quoted(flag.quote)}`);
    }
  }
  const [last] = store.findItems(sessionId, "agent", {}, { newest: true, limit: 1 });
  const lastRead = last ? state.replies[last.id] : undefined;
  const partly = !!last && !!lastRead && typeof lastRead.read === "number" && lastRead.read > 0 && !!lastRead.of && lastRead.read < lastRead.of;
  const readTold = partly && state.toldRead?.id === last!.id && state.toldRead.read === lastRead!.read;
  if (partly && !readTold) {
    const read = lastRead!.read as number;
    lines.push(`人读你上一条回复读到第 ${read} 段${quoted(lastRead!.at ?? "")}为止，后面的 ${lastRead!.of! - read} 段还没读：别把没读的部分当成人已经看过、同意了。`);
  }
  return {
    lines,
    told: () => {
      if (!lines.length) return;
      const now = readReviewProgress(store, sessionId);
      const sent = new Set(fresh.map((f) => `${f.id}\n${f.flag.block}`));
      const replies = Object.fromEntries(Object.entries(now.replies).map(([id, r]) => [id, { ...r, flags: r.flags.map((f) => (sent.has(`${id}\n${f.block}`) ? { ...f, told: true } : f)) }]));
      writeReviewProgress(store, sessionId, { replies, ...(partly && !readTold ? { toldRead: { id: last!.id, read: lastRead!.read as number } } : now.toldRead ? { toldRead: now.toldRead } : {}) });
    },
  };
}
