import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { applyReviewChange, type ReviewChange, type ReviewProgress, type ReviewRead } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { blocksOf, clickRead, isFlagged, readCount, type ReadBlock } from "./reviewLogic.js";
import type { AgentItem } from "./turns.js";

// 审阅进度 in the conversation (plans/review-progress.md, 测试功能「审阅进度」). 第二版 (2026-11-16; the user: 看过不要用左面
// 每行加标志的方式 … 也不要做自动标记完成，我觉得可以右侧加一个竖线，左键点击是标记读到哪里，右键则是标记那个感叹号有问题 … 没看
// 的块做标注感受更好一些，然后审过的按钮可以去掉了): each round's final reply has a line at its right; a left click on a
// block's height reads the reply down to it, a right click marks the block 「!」. Thread holds it (so 脉络's 会话弹窗, the
// same Thread, has it too); the Transcript puts ReadMarks in each reply. Off: nothing is drawn, asked or recorded. 复盘
// (the tint of what was not read, its counts and 下一处没读的) went on 2026-11-16 — the user: 现在的复盘我觉得可以删掉，
// 因为本体已经有右侧的看到哪的线了.

type Replies = Readonly<Record<string, ReviewRead>>;

/** What the transcript's replies need of it. */
export interface ReviewView {
  replies: Replies;
  change(change: ReviewChange): void;
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
 * the annotations' highlights and finding in the page are left as they are: its part of the line down the
 * conversation's right edge (a band per block: left click 读到这里, right click 「!」) and the 「读到这里」 tab on the line
 * where the reading stopped. The words are drawn by the CSS (attr()), not in the page's text.
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
  const span = (from: number, to: number) => (bands ? { top: bands.top[from]!, height: bands.bottom[to]! - bands.top[from]! } : null);
  // 读到这里 where the person put it (到这里为止都读过 marks a whole reply: no tag on each of them).
  const placed = !!r && r.read !== "all" && read > 0;
  const preview = hover !== null ? span(0, hover) : null;
  return (
    <div ref={at} className="read-marks" data-testid="read-marks" data-read={read} data-of={of}>
      {bands && (
        <>
          {preview && <div className="read-tint preview" style={preview} data-testid="read-preview" />}
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
            {placed && <div className="read-at" style={{ top: bands.bottom[read - 1]! - bands.top[0]! }} data-testid="read-at" data-label="读到这里" />}
          </div>
        </>
      )}
    </div>
  );
}
