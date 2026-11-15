import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ReviewMark, ReviewProgress } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { REVIEW_STATE_LABEL, reviewControls, reviewKey, reviewReasons, stateOf } from "./reviewLogic.js";
import type { Segment } from "./turns.js";

// 审阅进度 in the conversation (2026-11-16, plans/review-progress.md; the user: 我再想更新需要的功能是之前说的那个审核，阅读
// 看到哪然后标记上。我们可以在会话里加上). Thread holds it (so 脉络's 会话弹窗, the same Thread, has it too), the Transcript
// draws each reply's end with it. Off (测试功能「审阅进度」): nothing is drawn, asked or recorded.

type Marks = Readonly<Record<string, ReviewMark>>;

/** What the transcript's replies need of it. */
export interface ReviewView {
  marks: Marks;
  /** 复盘: every reply shows its state and buttons, the ones not 审过 coloured. */
  mode: boolean;
  /** 审过 (true) or taken back (false). */
  mark(ids: readonly string[], reviewed: boolean): void;
  /** 到这里为止都审过 on this reply (the transcript knows the order). */
  upTo?(id: string): void;
  /** A reply's end is drawn: watched for staying on screen (浏览过). Returns its unwatch. */
  watch(el: Element, id: string): () => void;
}

export const ReviewContext = createContext<ReviewView | null>(null);

/** 浏览过 reported together: what stayed on screen within this long goes in one request, not one per reply. */
const SEEN_BATCH_MS = 1000;
/** How long a reply's end stays on screen (window in front, page visible) before it counts as 浏览过. */
export const SEEN_DWELL_MS = 1500;
const DWELL_TICK_MS = 250;

/**
 * A session's marks from the Host, kept live, with the conversation's reports: `seen` gathered for a second, `mark`
 * at once. Both show here before the Host answers. Nothing is asked while `enabled` is off.
 */
export function useReviewProgress(link: HostLink, sessionId: string | null, enabled: boolean, onError?: (text: string) => void) {
  const pending = useRef<{ sessionId: string; ids: Set<string> } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // An event (or a load) that left out what is still to be sent keeps it shown.
  const withPending = (sid: string, marks: Marks): Marks => {
    const p = pending.current;
    if (!p || p.sessionId !== sid) return marks;
    const missing = [...p.ids].filter((id) => !marks[id]);
    return missing.length ? { ...marks, ...Object.fromEntries(missing.map((id) => [id, "seen" as const])) } : marks;
  };
  const [data, setData, reload] = useLiveResource<ReviewProgress | null>(
    {
      load: enabled && sessionId ? () => call(link, "GET /api/sessions/:id/review-progress", { id: sessionId }) : null,
      initial: null,
      reset: true,
      onEvent: (cur, e) => (e.type === "reviewprogress.changed" && e.sessionId === sessionId ? { sessionId, marks: withPending(sessionId, e.marks) } : cur),
    },
    [link, sessionId, enabled],
  );
  const fail = useRef(onError);
  fail.current = onError;
  const put = useCallback(
    (sid: string, body: { seen?: string[]; reviewed?: string[]; unreviewed?: string[] }) =>
      call(link, "PUT /api/sessions/:id/review-progress", { id: sid }, body).then(
        (r) => setData((cur) => (cur?.sessionId === r.sessionId ? { sessionId: r.sessionId, marks: withPending(r.sessionId, r.marks) } : cur)),
        (err: unknown) => {
          reload();
          fail.current?.(`审阅进度没记上：${err instanceof HostApiError ? err.message : String(err)}`);
        },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [link, setData, reload],
  );
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    const p = pending.current;
    pending.current = null;
    if (p?.ids.size) void put(p.sessionId, { seen: [...p.ids] });
  }, [put]);
  // Another session, or the page going: what was gathered goes now.
  useEffect(() => flush, [sessionId, flush]);
  useEffect(() => {
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [flush]);

  const seen = useCallback(
    (id: string) => {
      if (!sessionId) return;
      if (pending.current && pending.current.sessionId !== sessionId) flush();
      pending.current ??= { sessionId, ids: new Set() };
      pending.current.ids.add(id);
      setData((cur) => (cur && cur.sessionId === sessionId && !cur.marks[id] ? { sessionId, marks: { ...cur.marks, [id]: "seen" } } : cur));
      // The first one starts the second; the ones that come meanwhile go with it.
      timer.current ??= setTimeout(flush, SEEN_BATCH_MS);
    },
    [sessionId, flush, setData],
  );
  const mark = useCallback(
    (ids: readonly string[], reviewed: boolean) => {
      if (!sessionId || !ids.length) return;
      setData((cur) => {
        if (!cur || cur.sessionId !== sessionId) return cur;
        const next = { ...cur.marks };
        for (const id of ids) if (reviewed) next[id] = "reviewed";
        else if (next[id] === "reviewed") next[id] = "seen";
        return { sessionId, marks: next };
      });
      void put(sessionId, reviewed ? { reviewed: [...ids] } : { unreviewed: [...ids] });
    },
    [sessionId, put, setData],
  );
  const marks: Marks = data && data.sessionId === sessionId ? data.marks : EMPTY;
  return { loaded: !!data && data.sessionId === sessionId, marks, seen, mark };
}

const EMPTY: Marks = {};

/**
 * Watches the replies' ends (TurnReview's element) in the scroller: one on screen for SEEN_DWELL_MS while the window is
 * in front and the page visible is 浏览过 (`onSeen`). Scrolled past, it starts again. `active` off (the feature off, or
 * the conversation hidden behind 脉络's building): nothing is watched.
 */
export function useSeenWatch(scroller: RefObject<HTMLElement | null>, active: boolean, marks: Marks, onSeen: (id: string) => void): (el: Element, id: string) => () => void {
  const io = useRef<IntersectionObserver | null>(null);
  const ids = useRef(new Map<Element, string>());
  const shown = useRef(new Map<string, number>());
  const latest = useRef({ marks, onSeen });
  latest.current = { marks, onSeen };
  useEffect(() => {
    const root = scroller.current;
    if (!active || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = ids.current.get(e.target);
          if (!id) continue;
          if (e.isIntersecting) {
            if (!shown.current.has(id)) shown.current.set(id, 0);
          } else shown.current.delete(id);
        }
      },
      { root },
    );
    io.current = observer;
    for (const el of ids.current.keys()) observer.observe(el);
    const tick = setInterval(() => {
      if (!shown.current.size || document.hidden || !document.hasFocus()) return;
      for (const [id, ms] of shown.current) {
        if (latest.current.marks[id]) {
          shown.current.delete(id);
          continue;
        }
        if (ms + DWELL_TICK_MS < SEEN_DWELL_MS) shown.current.set(id, ms + DWELL_TICK_MS);
        else {
          shown.current.delete(id);
          latest.current.onSeen(id);
        }
      }
    }, DWELL_TICK_MS);
    return () => {
      clearInterval(tick);
      observer.disconnect();
      io.current = null;
      shown.current.clear();
    };
  }, [active, scroller]);
  return useCallback((el: Element, id: string) => {
    ids.current.set(el, id);
    io.current?.observe(el);
    return () => {
      ids.current.delete(el);
      io.current?.unobserve(el);
      shown.current.delete(id);
    };
  }, []);
}

/** Over a screen long: the reply's element is taller than the conversation's view (watched, as replies lay out late). */
function useTall(at: RefObject<HTMLElement | null>, id: string | null, enabled: boolean): boolean {
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const el = at.current;
    if (!enabled || !el || !id) return;
    const reply = el.closest(".turn")?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`);
    const view = el.closest<HTMLElement>(".thread");
    if (!reply || !view) return;
    const measure = () => setTall(reply.offsetHeight > view.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(reply);
    ro.observe(view);
    return () => ro.disconnect();
  }, [at, id, enabled]);
  return tall;
}

/**
 * The end of a round's reply (in its footer): the 审过 button or tick, and in 复盘 its state and 「到这里为止都审过」. Also
 * the element watched for 浏览过, so it is there (empty) on every finished reply.
 */
export function TurnReview({ seg }: { seg: Segment }) {
  const review = useContext(ReviewContext);
  const id = review ? reviewKey(seg) : null;
  const ref = useRef<HTMLSpanElement>(null);
  const reasons = useMemo(() => (id ? reviewReasons(seg) : []), [id, seg]);
  // Measured only where it can change what shows (off 复盘, a plain round not 审过).
  const state = review && id ? stateOf(review.marks, id) : "unseen";
  const tall = useTall(ref, id, !!review && !review.mode && !reasons.length && state !== "reviewed");
  const watch = review?.watch;
  useEffect(() => {
    if (!watch || !id || !ref.current) return;
    return watch(ref.current, id);
  }, [watch, id]);
  if (!review || !id) return null;
  const show = reviewControls({ mode: review.mode, weighty: reasons.length > 0 || tall, state });
  const why = reasons.length ? `这一轮有${reasons.join("、")}` : tall ? "这条回复超过一屏" : "";
  return (
    <span ref={ref} className="turn-review" data-review-end={id} data-state={state} data-shown={show.toggle || undefined} data-testid="turn-review">
      {show.label && (
        <span className="review-state" data-testid="review-state">
          {REVIEW_STATE_LABEL[state]}
        </span>
      )}
      {show.toggle &&
        (state === "reviewed" ? (
          <button type="button" className="review-tick" onClick={() => review.mark([id], false)} title="你标过「审过」。点一下撤回（回到「浏览过」）" data-testid="review-undo">
            ✓ 审过
          </button>
        ) : (
          <button type="button" className="review-btn" onClick={() => review.mark([id], true)} title={`看完了、认可这条回复就点一下。${why ? `（${why}）` : ""}滚过去只算「浏览过」`} data-testid="review-mark">
            审过
          </button>
        ))}
      {show.upTo && review.upTo && (
        <button type="button" className="review-upto" onClick={() => review.upTo?.(id)} title="这一条和它前面所有还没审过的回复，一次都标成「审过」" data-testid="review-upto">
          到这里为止都审过
        </button>
      )}
    </span>
  );
}

/** 复盘's line over the conversation: how many are left, the next one, leaving it; `children` at its right (the reply jumps). */
export function ReviewBar({ left, onNext, onExit, children }: { left: number; onNext(): void; onExit(): void; children?: ReactNode }) {
  return (
    <div className="review-bar" role="region" aria-label="复盘" data-testid="review-bar">
      <span className="review-bar-title">复盘</span>
      <span className="review-bar-count" data-testid="review-left">
        {left ? `还有 ${left} 条没审` : "✓ 都审过了"}
      </span>
      {left > 0 && (
        <button type="button" className="btn-ghost small" onClick={onNext} data-testid="review-next">
          下一条没审的
        </button>
      )}
      <button type="button" className="btn-ghost small" onClick={onExit} data-testid="review-exit">
        退出复盘
      </button>
      <span className="spacer" />
      {children}
    </div>
  );
}
