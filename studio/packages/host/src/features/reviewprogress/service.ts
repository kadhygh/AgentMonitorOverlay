import { applyReviewChange, experimentalEnabled, type Id, type ReviewChange, type ReviewProgress } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { Feature, type FeatureHost } from "../../core/feature.js";
import { readReviewProgress, writeReviewProgress } from "../../core/reviewprogress.js";

/** Ids in one 到这里为止都读过: the replies up to one. */
const MAX_IDS = 2000;
/** More blocks than a reply could have: a number past it is a mistake, not a reply. */
const MAX_BLOCKS = 100_000;

/**
 * 审阅进度 (plans/review-progress.md; 第二版 2026-11-16, the user: 不要做自动标记完成 … 右侧加一个竖线，左键点击是标记读到哪里，
 * 右键则是标记那个感叹号有问题): for each AI reply of a session (by its row's id, not a scroll position) how many of its
 * blocks the person on this computer read from the top, and the blocks they marked 「!」. Only what the person clicked
 * is recorded. Kept here rather than in the browser so the task's cards, Focus and 脉络 can show it later, and the AI is
 * told the new 「!」 with the next message (core/reviewprogress.ts). A remote task's copy keeps its own (it is this
 * person's reading).
 */
export class ReviewProgressFeature extends Feature<"config"> {
  constructor(host: FeatureHost<"config">) {
    super(host);
  }

  get(sessionId: Id): ReviewProgress {
    this.requireSession(sessionId);
    return { sessionId, replies: readReviewProgress(this.store, sessionId).replies };
  }

  /** One change from the conversation (ReviewChange). Refused while 测试功能「审阅进度」 is off. */
  update(sessionId: Id, body: unknown): ReviewProgress {
    this.requireSession(sessionId);
    if (!experimentalEnabled(this.f.config.experimentalFeatures(), "review-progress")) throw new HostError("bad_request", "测试功能「审阅进度」没有打开");
    const change = this.check(sessionId, body);
    const state = readReviewProgress(this.store, sessionId);
    const replies = applyReviewChange(state.replies, change);
    if (JSON.stringify(replies) !== JSON.stringify(state.replies)) {
      writeReviewProgress(this.store, sessionId, { ...state, replies });
      this.publish({ type: "reviewprogress.changed", sessionId, replies });
    }
    return { sessionId, replies };
  }

  /** The change as sent, checked: numbers in range, ids that are this session's replies. */
  private check(sessionId: Id, body: unknown): ReviewChange {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const change: ReviewChange = {};
    const count = (v: unknown, field: string, min: number) => {
      if (!Number.isInteger(v) || (v as number) < min || (v as number) > MAX_BLOCKS) throw new HostError("bad_request", `${field} 要是 ${min} 以上的整数`);
      return v as number;
    };
    const text = (v: unknown, field: string) => {
      if (v === undefined) return "";
      if (typeof v !== "string") throw new HostError("bad_request", `${field} 要是文字`);
      return v;
    };
    if (b.read !== undefined) {
      const r = (b.read ?? {}) as Record<string, unknown>;
      const id = this.reply(sessionId, r.id, "read.id");
      const of = count(r.of, "read.of", 1);
      const blocks = count(r.blocks, "read.blocks", 0);
      if (blocks > of) throw new HostError("bad_request", "read.blocks 不能比 read.of 大");
      change.read = { id, blocks, of, at: text(r.at, "read.at") };
    }
    if (b.flag !== undefined) {
      const f = (b.flag ?? {}) as Record<string, unknown>;
      if (typeof f.on !== "boolean") throw new HostError("bad_request", "flag.on 要是 true 或 false");
      change.flag = { id: this.reply(sessionId, f.id, "flag.id"), block: count(f.block, "flag.block", 0), quote: text(f.quote, "flag.quote"), on: f.on };
    }
    if (b.readUpTo !== undefined) {
      const ids = b.readUpTo;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) throw new HostError("bad_request", "readUpTo 要是回复 id 的列表");
      if (ids.length > MAX_IDS) throw new HostError("bad_request", `readUpTo 一次最多 ${MAX_IDS} 条`);
      // A row of another session, or one gone, is left out (the conversation's list may be a moment old).
      change.readUpTo = [...new Set(ids as string[])].filter((id) => this.isReply(sessionId, id));
    }
    return change;
  }

  private isReply(sessionId: Id, id: string): boolean {
    const item = this.store.getItem(id);
    return item?.sessionId === sessionId && item.type === "agent";
  }

  private reply(sessionId: Id, id: unknown, field: string): Id {
    if (typeof id !== "string" || !this.isReply(sessionId, id)) throw new HostError("bad_request", `${field} 不是这个会话的回复`);
    return id;
  }
}
