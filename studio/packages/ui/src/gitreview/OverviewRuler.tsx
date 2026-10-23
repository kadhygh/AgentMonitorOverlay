import { useEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from "react";
import { changeRuns, rulerMarks, scrollForRuler, viewBox, type ChangeRun, type ChunkBox, type RulerKind, type RulerMark } from "./overview.js";

/** "3 处改动 · 2 处重点 · 1 条批注：点击或拖动跳过去". */
function rulerTitle(changes: number, marks: readonly ChangeRun[]): string {
  const hl = marks.filter((m) => m.kind === "hl").length;
  const notes = marks.filter((m) => m.kind === "note").length;
  const parts = [changes ? `${changes} 处改动` : "", hl ? `${hl} 处重点` : "", notes ? `${notes} 处批注` : ""].filter(Boolean);
  return parts.length ? `${parts.join(" · ")}：点击或拖动跳过去` : "点击或拖动跳到文件里的位置";
}

// The overview ruler (S13-B): a thin strip beside the diff's scrollbar with a mark for every run of changes (added
// green, deleted red, both yellow) where it sits in the file, and a box for the part on screen. A click or a drag
// scrolls there. Positions come from the drawn chunks (a comment card or wrapped lines make some rows taller).

interface Geometry {
  marks: RulerMark[];
  box: { top: number; height: number };
  /** The scroller's own scrollbars, so the ruler sits just inside them. */
  vbar: number;
  hbar: number;
}

const KIND_NAME = { add: "新增", del: "删除", mod: "修改", hl: "重点", note: "批注" } as const;

/**
 * `marks` (2026-10-23): the 重点 and comments, drawn on the ruler's right half over the changes, so both show; the
 * viewer's 文件 mode has only these (no changes).
 */
export function OverviewRuler({ scroller, kinds, marks = [] }: { scroller: RefObject<HTMLDivElement | null>; kinds: readonly RulerKind[]; marks?: readonly ChangeRun[] }) {
  const ruler = useRef<HTMLDivElement>(null);
  const changes = useMemo(() => changeRuns(kinds), [kinds]);
  const runs = useMemo(() => [...changes, ...marks], [changes, marks]);
  const [geo, setGeo] = useState<Geometry | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const r = ruler.current;
      if (!r) return;
      const height = r.clientHeight;
      const base = el.getBoundingClientRect().top - el.scrollTop;
      const chunks: ChunkBox[] = [...el.querySelectorAll<HTMLElement>(".gr-chunk")].map((c) => {
        const box = c.getBoundingClientRect();
        return { start: Number(c.dataset.chunkStart), count: Number(c.dataset.chunkCount), top: box.top - base, height: box.height };
      });
      setGeo({
        marks: rulerMarks(runs, chunks, el.scrollHeight, height),
        box: viewBox(el.scrollTop, el.clientHeight, el.scrollHeight, height),
        vbar: el.offsetWidth - el.clientWidth,
        hbar: el.offsetHeight - el.clientHeight,
      });
    };
    const later = () => (frame ||= requestAnimationFrame(measure));
    // Scrolling moves only the box; a cheap read, once a frame.
    let scrolled = 0;
    const onScroll = () =>
      (scrolled ||= requestAnimationFrame(() => {
        scrolled = 0;
        const r = ruler.current;
        if (r) setGeo((g) => g && { ...g, box: viewBox(el.scrollTop, el.clientHeight, el.scrollHeight, r.clientHeight) });
      }));
    // The window, and the content: it grows or shrinks as chunks are first drawn (their real heights), comments
    // open, another file or layout replaces the lines.
    const resize = new ResizeObserver(later);
    resize.observe(el);
    const observeLines = () => el.querySelectorAll(".gr-lines").forEach((l) => resize.observe(l));
    observeLines();
    const replaced = new MutationObserver(() => {
      observeLines();
      later();
    });
    replaced.observe(el, { childList: true });
    el.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (scrolled) cancelAnimationFrame(scrolled);
      resize.disconnect();
      replaced.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, [scroller, runs]);

  const jump = (e: PointerEvent<HTMLDivElement>) => {
    const el = scroller.current;
    const r = ruler.current;
    if (!el || !r) return;
    const rect = r.getBoundingClientRect();
    el.scrollTop = scrollForRuler(e.clientY - rect.top, rect.height, el.scrollHeight, el.clientHeight);
  };

  return (
    <div
      ref={ruler}
      className="gr-ruler"
      style={geo ? { right: geo.vbar, bottom: geo.hbar } : undefined}
      title={rulerTitle(changes.length, marks)}
      data-testid="overview-ruler"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = true;
        jump(e);
      }}
      onPointerMove={(e) => dragging.current && jump(e)}
      onPointerUp={() => (dragging.current = false)}
      onLostPointerCapture={() => (dragging.current = false)}
    >
      {geo?.marks.map((m, i) => (
        <span key={i} className={`gr-ruler-mark ${m.kind}`} style={{ top: m.top, height: m.height }} data-testid="ruler-mark" data-kind={m.kind} aria-label={KIND_NAME[m.kind]} />
      ))}
      {geo && <span className="gr-ruler-view" style={{ top: geo.box.top, height: geo.box.height }} data-testid="ruler-view" />}
    </div>
  );
}
