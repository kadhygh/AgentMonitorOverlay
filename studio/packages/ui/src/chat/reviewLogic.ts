import type { ReviewMark } from "@amo-studio/protocol";
import { turnChanges } from "../files/changes.js";
import { segmentMembers, type Segment } from "./turns.js";

// 审阅进度 in the conversation (2026-11-16, plans/review-progress.md, behind 测试功能「审阅进度」): each round's final
// reply is 没看 / 浏览过 / 审过. What is worked out without the page — which round counts, which shows its 审过 button,
// how many are left — is here, so it is tested on its own.

export type ReviewState = "unseen" | "seen" | "reviewed";

export const REVIEW_STATE_LABEL: Record<ReviewState, string> = { unseen: "○ 没看", seen: "◐ 浏览过", reviewed: "✓ 审过" };

/**
 * The reply a round is reviewed by: its final answer, once the round is over and the answer done (a reply still being
 * written is not one yet). Its row's id is the key the Host keeps the mark under. Null for a round without one.
 */
export function reviewKey(seg: Segment): string | null {
  const answer = seg.answer;
  return !seg.running && answer && !answer.streaming && answer.markdown.trim() ? answer.id : null;
}

/** The rounds' reply ids, in order. */
export function reviewKeys(segments: readonly Segment[]): string[] {
  return segments.flatMap((s) => {
    const key = reviewKey(s);
    return key ? [key] : [];
  });
}

export function stateOf(marks: Readonly<Record<string, ReviewMark>>, id: string): ReviewState {
  const mark = marks[id];
  return mark === "reviewed" ? "reviewed" : mark === "seen" ? "seen" : "unseen";
}

/**
 * Why a round is worth a 审过 of its own even when its reply is short (the user, 11-15: 带审批 / 提问 / 文档的那些回复): it
 * asked for an approval, asked the person something (a question, decision_request), changed files, or opened a 查看包
 * or a Review. Empty: a plain round, whose button shows only when its reply is over a screen long.
 */
export function reviewReasons(seg: Segment): string[] {
  const items = [...segmentMembers(seg), ...seg.tail];
  const reasons: string[] = [];
  if (items.some((i) => i.type === "approval")) reasons.push("审批");
  if (items.some((i) => i.type === "question" || (i.type === "tool" && /(^|[_.])decision_request$/.test(i.name)))) reasons.push("提问");
  if (turnChanges(items).length) reasons.push("文件改动");
  if (items.some((i) => i.type === "tool" && /(^|[_.])(view_open|review_open)$/.test(i.name))) reasons.push("查看包");
  return reasons;
}

/**
 * What the end of a reply shows. Off 复盘 it stays quiet (the user: 平时很淡): a 审过 one its tick; one worth reviewing
 * (`weighty`: a reason above, or over a screen long) the 审过 button; the rest nothing. In 复盘 every reply shows its
 * state, its button and 「到这里为止都审过」.
 */
export function reviewControls({ mode, weighty, state }: { mode: boolean; weighty: boolean; state: ReviewState }): { toggle: boolean; label: boolean; upTo: boolean } {
  if (mode) return { toggle: true, label: state !== "reviewed", upTo: true };
  return { toggle: state === "reviewed" || weighty, label: false, upTo: false };
}

/** The replies not 审过 yet, in order. */
export function unreviewed(keys: readonly string[], marks: Readonly<Record<string, ReviewMark>>): string[] {
  return keys.filter((k) => marks[k] !== "reviewed");
}

/** 到这里为止都审过: this reply and the ones before it that are not 审过 yet. Empty when it is not one of them. */
export function reviewUpTo(keys: readonly string[], marks: Readonly<Record<string, ReviewMark>>, id: string): string[] {
  const at = keys.indexOf(id);
  return at < 0 ? [] : unreviewed(keys.slice(0, at + 1), marks);
}

/**
 * 下一条没审的: the first one not 审过 after the reply being read (`after`: the last key above the place read, null at
 * the top), and from the start again once there is none below.
 */
export function nextUnreviewed(keys: readonly string[], marks: Readonly<Record<string, ReviewMark>>, after: string | null): string | null {
  const left = unreviewed(keys, marks);
  if (!left.length) return null;
  const from = after === null ? -1 : keys.indexOf(after);
  return left.find((k) => keys.indexOf(k) > from) ?? left[0]!;
}
