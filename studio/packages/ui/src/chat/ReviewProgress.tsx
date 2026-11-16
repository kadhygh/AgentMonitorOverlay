import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { applyReviewChange, type ReviewChange, type ReviewProgress, type ReviewRead } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { blocksOf, clickRead, isFlagged, readCount, readLine, reviewKey, type ReadBlock } from "./reviewLogic.js";
import type { AgentItem, Segment } from "./turns.js";

// 审阅进度 in the conversation (plans/review-progress.md, 测试功能「审阅进度」). 第二版 (2026-11-16; the user: 看过不要用左面
// 每行加标志的方式 … 也不要做自动标记完成，我觉得可以右侧加一个竖线，左键点击是标记读到哪里，右键则是标记那个感叹号有问题 … 没看
// 的块做标注感受更好一些，然后审过的按钮可以去掉了): each round's final reply has a line at its right; a left click on a
// block's height reads the reply down to it, a right click marks the block 「!」. 复盘 tints the blocks not read. Thread
// holds it (so 脉络's 会话弹窗, the same Thread, has it too); the Transcript puts ReadMarks in each reply. Off: nothing
// is drawn, asked or recorded.

type Replies = Readonly<Record<string, ReviewRead>>;

/** What the transcript's replies need of it. */
export interface ReviewView {
  replies: Replies;
  /** 复盘: the blocks not read are tinted, each reply's end says how far it was read. */
  mode: boolean;
  change(change: ReviewChange): void;
  /** 到这里为止都读过 on this reply (the transcript knows the order). */
  upTo?(id: string): void;
}

export const ReviewContext = createContext<ReviewView | null>(null);

/**
 * A session's 审阅进度 from the Host, kept live, and the person's changes: shown at once, sent at once. While a change is
 * on its way, the Host's events wait (they would show the state before it for a moment); its answer brings them in.
 * Nothing is asked while `enabled` is off.
 */
export function useReviewProgress(link: HostLink, sessionId: string | null, enabled: boolean, onError?: (text: string) => void) {
  const sending = useRef(0);
  const [data, setData, reload] = useLiveResource<ReviewProgress | null>(
    {
      load: enabled && sessionId ? () => call(link, "GET /api/sessions/:id/review-progress", { id: sessionId }) : null,
      initial: null,
      reset: true,
      onEvent: (cur, e) => (e.type === "reviewprogress.changed" && e.sessionId === sessionId && !sending.current ? { sessionId, replies: e.replies } : cur),
    },
    [link, sessionId, enabled],
  );
  const fail = useRef(onError);
  fail.current = onError;
  const change = useCallback(
    (c: ReviewChange) => {
      if (!sessionId) return;
      setData((cur) => (cur && cur.sessionId === sessionId ? { sessionId, replies: applyReviewChange(cur.replies, c) } : cur));
      sending.current++;
      call(link, "PUT /api/sessions/:id/review-progress", { id: sessionId }, c).then(
        (r) => {
          if (--sending.current === 0) setData((cur) => (cur?.sessionId === r.sessionId ? r : cur));
        },
        (err: unknown) => {
          sending.current--;
          reload();
          fail.current?.(`审阅进度没记上：${err instanceof HostApiError ? err.message : String(err)}`);
        },
      );
    },
    [link, sessionId, setData, reload],
  );
  const replies: Replies = data && data.sessionId === sessionId ? data.replies : EMPTY;
  return { loaded: !!data && data.sessionId === sessionId, replies, change };
}

const EMPTY: Replies = {};

/**
 * The elements a reply's blocks are drawn over (`reply`: its `.msg-agent`; ReadPart says where each is in the
 * Markdown), or null when its Markdown is not drawn as the blocks say (then nothing is drawn rather than the wrong place).
 */
export function blockElements(reply: Element, blocks: readonly ReadBlock[]): HTMLElement[][] | null {
  const tops = reply.querySelector(":scope > .md")?.children;
  if (!tops) return null;
  const out: HTMLElement[][] = [];
  for (const b of blocks) {
    const els: HTMLElement[] = [];
    for (const p of b.parts) {
      const top = tops[p.at];
      const el = !top ? null : p.li !== undefined ? top.querySelector(":scope > ul, :scope > ol")?.children[p.li] : p.tr !== undefined ? top.querySelector("tbody")?.children[p.tr] : p.head ? top.querySelector("thead") : top;
      if (!(el instanceof HTMLElement)) return null;
      els.push(el);
    }
    out.push(els);
  }
  return out;
}

/** A block's first element in the reply drawn on the page (for 下一处没读的), or null. */
export function blockElement(reply: Element, item: AgentItem, block: number): HTMLElement | null {
  return blockElements(reply, blocksOf(item))?.[block]?.[0] ?? null;
}

/** Each block's band down the reply (px from the reply's top): from halfway up the gap above it to halfway down the one below. */
interface Bands {
  top: number[];
  bottom: number[];
}

/** How far around the place in sight a reply's blocks are measured: a long conversation measures only what is near. */
const NEAR = "800px 0px";

/**
 * The bands of a reply's blocks, measured while the reply is near the conversation's view (an IntersectionObserver on
 * the scroller) and again when it changes size (the window, the column, a picture loaded) or its Markdown is drawn
 * anew; a reply far away keeps what it had and is measured when it comes near. Null until measured, or when its
 * blocks cannot be found.
 */
function useBands(at: RefObject<HTMLElement | null>, blocks: readonly ReadBlock[]): Bands | null {
  const [bands, setBands] = useState<Bands | null>(null);
  useEffect(() => {
    const reply = at.current?.parentElement;
    if (!reply) return;
    let near = false;
    let dirty = true;
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (!near) {
        dirty = true;
        return;
      }
      dirty = false;
      const els = blockElements(reply, blocks);
      if (!els || !els.length) return setBands(null);
      const base = reply.getBoundingClientRect().top;
      const boxes = els.map((parts) => {
        let top = Infinity;
        let bottom = -Infinity;
        for (const el of parts) {
          const r = el.getBoundingClientRect();
          top = Math.min(top, r.top - base);
          bottom = Math.max(bottom, r.bottom - base);
        }
        return { top, bottom };
      });
      const next: Bands = {
        top: boxes.map((b, i) => Math.round(i === 0 ? b.top : (boxes[i - 1]!.bottom + b.top) / 2)),
        bottom: boxes.map((b, i) => Math.round(i === boxes.length - 1 ? b.bottom : (b.bottom + boxes[i + 1]!.top) / 2)),
      };
      setBands((cur) => (cur && cur.top.join() === next.top.join() && cur.bottom.join() === next.bottom.join() ? cur : next));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const io = new IntersectionObserver(
      (entries) => {
        near = entries.at(-1)!.isIntersecting;
        if (near && dirty) schedule();
      },
      { root: reply.closest(".thread"), rootMargin: NEAR },
    );
    io.observe(reply);
    const ro = new ResizeObserver(schedule);
    ro.observe(reply);
    const md = reply.querySelector(":scope > .md");
    const mo = new MutationObserver(schedule);
    if (md) mo.observe(md, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(frame);
      io.disconnect();
      ro.disconnect();
      mo.disconnect();
    };
  }, [at, blocks]);
  return bands;
}

/**
 * Drawn in a finished round's reply (its `.msg-agent`), over and beside its text rather than in it, so the Markdown,
 * the annotations' highlights and finding in the page are left as they are: the line at the right (a band per block:
 * left click 读到这里, right click 「!」), the 「读到这里」 line and tag under the last block read, and in 复盘 the tint of
 * the blocks not read (and of the 「!」 ones). The words are drawn by the CSS (attr()), not in the page's text.
 */
export function ReadMarks({ item }: { item: AgentItem }) {
  const review = useContext(ReviewContext);
  const at = useRef<HTMLDivElement>(null);
  const blocks = blocksOf(item);
  const bands = useBands(at, blocks);
  const [hover, setHover] = useState<number | null>(null);
  if (!review || !blocks.length) return null;
  const of = blocks.length;
  const r = review.replies[item.id];
  const read = readCount(r, of);
  const blockAt = (e: MouseEvent) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-block]")?.dataset.block;
    return b === undefined ? null : Number(b);
  };
  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    const b = blockAt(e);
    if (b === null) return;
    const next = clickRead(r, b, of);
    review.change({ read: { id: item.id, blocks: next, of, ...(next ? { at: blocks[next - 1]!.quote } : {}) } });
  };
  // Only this narrow line: a right click on the reply's text keeps the page's own menu (the user's demo: 右键只管竖线那一条).
  const onContextMenu = (e: MouseEvent) => {
    const b = blockAt(e);
    if (b === null) return;
    e.preventDefault();
    e.stopPropagation();
    review.change({ flag: { id: item.id, block: b, quote: blocks[b]!.quote, on: !isFlagged(r, b) } });
  };
  const band = (i: number) => (bands ? { top: bands.top[i]!, height: bands.bottom[i]! - bands.top[i]! } : null);
  const span = (from: number, to: number) => (bands ? { top: bands.top[from]!, height: bands.bottom[to]! - bands.top[from]! } : null);
  // 读到这里 where the person put it (到这里为止都读过 marks a whole reply: no tag on each of them).
  const placed = !!r && r.read !== "all" && read > 0;
  const unread = review.mode && read < of ? span(read, of - 1) : null;
  const preview = hover !== null ? span(0, hover) : null;
  return (
    <div ref={at} className="read-marks" data-testid="read-marks" data-read={read} data-of={of}>
      {bands && (
        <>
          {unread && <div className="read-tint" style={unread} data-testid="read-unread" />}
          {review.mode &&
            r?.flags.map((f) => {
              const b = f.block < of ? band(f.block) : null;
              return b && <div key={f.block} className="read-tint flag" style={b} data-testid="read-flag-tint" />;
            })}
          {preview && <div className="read-tint preview" style={preview} data-testid="read-preview" />}
          {placed && <div className="read-at" style={{ top: bands.bottom[read - 1]! }} data-testid="read-at" data-label="读到这里" />}
          <div className="read-rail" style={span(0, of - 1)!} onClick={onClick} onContextMenu={onContextMenu} onMouseMove={(e) => setHover(blockAt(e))} onMouseLeave={() => setHover(null)} title="左键：从头读到这一段（同一处再点一次取消）　右键：这一段有问题（再点一次取消）" data-testid="read-rail">
            {blocks.map((_, i) => (
              <div
                key={i}
                className="read-seg"
                style={{ top: bands.top[i]! - bands.top[0]!, height: bands.bottom[i]! - bands.top[i]! }}
                data-block={i}
                data-read={i < read || undefined}
                data-pre={(hover !== null && i <= hover) || undefined}
                data-flag={isFlagged(r, i) || undefined}
                data-testid="read-seg"
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** In 复盘, at the end of a round's reply (its footer): how far it was read, its 「!」, and 到这里为止都读过. */
export function ReadFoot({ seg }: { seg: Segment }) {
  const review = useContext(ReviewContext);
  const id = review?.mode ? reviewKey(seg) : null;
  if (!review || !id || !seg.answer) return null;
  const of = blocksOf(seg.answer).length;
  const r = review.replies[id];
  const flags = r?.flags.length ?? 0;
  return (
    <span className="read-foot" data-testid="read-foot">
      <span data-testid="read-line">{readLine(r, of)}</span>
      {flags > 0 && (
        <span className="read-foot-flags" data-testid="read-foot-flags">
          ! {flags} 处有问题
        </span>
      )}
      {review.upTo && (
        <button type="button" className="read-upto" onClick={() => review.upTo?.(id)} title="这一条和它前面所有没读完的回复，都算读到底（标过的「!」留着）" data-testid="read-upto">
          到这里为止都读过
        </button>
      )}
    </span>
  );
}

/** 复盘's line over the conversation: how many replies are not read to the end, the 「!」, the next place, leaving it; `children` at its right (the reply jumps). */
export function ReviewBar({ left, flags, onNext, onExit, children }: { left: number; flags: number; onNext(): void; onExit(): void; children?: ReactNode }) {
  return (
    <div className="review-bar" role="region" aria-label="复盘" data-testid="review-bar">
      <span className="review-bar-title">复盘</span>
      <span className="review-bar-count">
        <span data-testid="review-left">{left ? `还有 ${left} 条回复没读完` : "✓ 都读到底了"}</span>
        {flags > 0 && (
          <span className="review-bar-flags" data-testid="review-flags">
            {left ? "，" : "　"}
            {flags} 处有问题
          </span>
        )}
      </span>
      {left > 0 && (
        <button type="button" className="btn-ghost small" onClick={onNext} data-testid="review-next">
          下一处没读的
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
