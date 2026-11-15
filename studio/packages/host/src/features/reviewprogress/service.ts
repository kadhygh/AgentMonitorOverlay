import { experimentalEnabled, type Id, type ReviewMark, type ReviewProgress } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { Feature, type FeatureHost } from "../../core/feature.js";

/** One kv row per session (kv-keys.ts, scope session: deleted with its session). */
const progressKey = (sessionId: Id) => `review-progress:${sessionId}`;
/** Ids in one PUT: the UI sends a handful (浏览过 gathered for a second), or the replies up to one (到这里为止都审过). */
const MAX_IDS = 2000;

/**
 * 审阅进度 (2026-11-16, plans/review-progress.md; the user: 我再想更新需要的功能是之前说的那个审核，阅读看到哪然后标记上): for
 * each AI reply of a session (by its row's id, not a scroll position) whether the person on this computer has looked at
 * it. 浏览过 is recorded by the conversation when the reply's end stayed on screen; 审过 only by the person's click — so
 * a 浏览过 never takes a 审过 away, and taking 审过 back leaves it 浏览过. Kept here rather than in the browser so the
 * task's cards, Focus and 脉络 can show it later. A remote task's copy keeps its own (it is this person's reading).
 */
export class ReviewProgressFeature extends Feature<"config"> {
  constructor(host: FeatureHost<"config">) {
    super(host);
  }

  get(sessionId: Id): ReviewProgress {
    this.requireSession(sessionId);
    return { sessionId, marks: this.read(sessionId) };
  }

  /** The conversation's report: what it saw, what the person marked or took back. Refused while 测试功能「审阅进度」 is off. */
  update(sessionId: Id, body: { seen?: unknown; reviewed?: unknown; unreviewed?: unknown } | null): ReviewProgress {
    this.requireSession(sessionId);
    if (!experimentalEnabled(this.f.config.experimentalFeatures(), "review-progress")) throw new HostError("bad_request", "测试功能「审阅进度」没有打开");
    const seen = this.replies(sessionId, body?.seen, "seen");
    const reviewed = this.replies(sessionId, body?.reviewed, "reviewed");
    const unreviewed = this.replies(sessionId, body?.unreviewed, "unreviewed");
    const marks = this.read(sessionId);
    let changed = false;
    const set = (id: Id, mark: ReviewMark) => {
      if (marks[id] === mark) return;
      marks[id] = mark;
      changed = true;
    };
    for (const id of seen) if (!marks[id]) set(id, "seen");
    for (const id of unreviewed) if (marks[id] === "reviewed") set(id, "seen");
    for (const id of reviewed) set(id, "reviewed");
    if (changed) {
      this.store.setKv(progressKey(sessionId), JSON.stringify({ marks }));
      this.publish({ type: "reviewprogress.changed", sessionId, marks });
    }
    return { sessionId, marks };
  }

  private read(sessionId: Id): Record<Id, ReviewMark> {
    const raw = this.store.getKv(progressKey(sessionId))?.value;
    if (!raw) return {};
    try {
      const v = JSON.parse(raw) as { marks?: Record<string, unknown> } | null;
      const out: Record<Id, ReviewMark> = {};
      for (const [id, mark] of Object.entries(v?.marks ?? {})) if (mark === "seen" || mark === "reviewed") out[id] = mark;
      return out;
    } catch {
      return {};
    }
  }

  /** The ids given that are replies of this session; others (a row of another session, one gone) are left out. */
  private replies(sessionId: Id, value: unknown, field: string): Id[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) throw new HostError("bad_request", `${field} 要是回复 id 的列表`);
    if (value.length > MAX_IDS) throw new HostError("bad_request", `${field} 一次最多 ${MAX_IDS} 条`);
    return [...new Set(value as string[])].filter((id) => {
      const item = this.store.getItem(id);
      return item?.sessionId === sessionId && item.type === "agent";
    });
  }
}
