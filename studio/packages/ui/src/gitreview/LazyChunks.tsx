import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { chunkRanges } from "./overview.js";
import { registerRevealer, scrollParent } from "./reveal.js";

// Long lists drawn near the view only (2026-10-20): items in chunks; a chunk's items exist only while the chunk is
// within DRAW_MARGIN_PX of the view (an IntersectionObserver on the scrolling ancestor), or holds an item that must
// stay (`keep`), or was asked for through reveal.ts until it leaves again. The others are empty boxes as tall as they
// were drawn (or `guess`ed before). The diff and the viewer's code (DiffView), and Review's file list, use it: a
// 2879-line prefab in the viewer had been 33 000 elements, which held the window up opening it.

/** How far beyond the visible part of the view chunks are drawn, in px. */
const DRAW_MARGIN_PX = 1500;

export function LazyChunks<T>({
  items,
  size,
  file,
  guess,
  render,
  keep,
  itemOfRow,
  chunkClass,
}: {
  items: readonly T[];
  /** Items a chunk. */
  size: number;
  /** What is shown: another one draws afresh (nothing drawn or measured carries over). */
  file: string;
  /** An item's height in px before its chunk was ever drawn. */
  guess(item: T): number;
  render(item: T, index: number): ReactNode;
  /** Items (by index) whose chunks stay drawn. */
  keep: readonly number[];
  /** For reveal.ts: the item showing a row (`data-row`). Without it the list cannot be revealed into. */
  itemOfRow?(row: number): number | null;
  /** The chunks' class; `far` is added to the ones not drawn. */
  chunkClass: string;
}) {
  const ranges = useMemo(() => chunkRanges(items.length, size), [items.length, size]);
  const host = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<number, number>());
  const [near, setNear] = useState<ReadonlySet<number>>(() => new Set([0, 1]));
  const [asked, setAsked] = useState<ReadonlySet<number>>(() => new Set());
  const waiting = useRef<Array<() => void>>([]);
  const chunkOf = (item: number) => Math.floor(item / size);

  const [shownFile, setShownFile] = useState(file);
  if (shownFile !== file) {
    setShownFile(file);
    setNear(new Set([0, 1]));
    setAsked(new Set());
    heights.current = new Map();
  }

  useEffect(() => {
    const el = host.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const on: number[] = [];
        const off: number[] = [];
        for (const e of entries) {
          const target = e.target as HTMLElement;
          const c = Number(target.dataset.chunk);
          if (e.isIntersecting) on.push(c);
          else {
            // Leaving: still drawn now, so its real height is known.
            if (target.childElementCount) heights.current.set(c, target.offsetHeight);
            off.push(c);
          }
        }
        const apply = (prev: ReadonlySet<number>, add: boolean) => {
          const next = new Set(prev);
          if (add) for (const c of on) next.add(c);
          for (const c of off) next.delete(c);
          return next.size === prev.size && [...next].every((c) => prev.has(c)) ? prev : next;
        };
        setNear((prev) => apply(prev, true));
        setAsked((prev) => apply(prev, false));
      },
      { root: scrollParent(el), rootMargin: `${DRAW_MARGIN_PX}px 0px` },
    );
    for (const c of el.children) io.observe(c);
    return () => io.disconnect();
  }, [ranges, file]);

  // reveal.ts: draw the chunks holding these rows, and say when they are.
  useEffect(() => {
    const el = host.current;
    if (!el || !itemOfRow) return;
    return registerRevealer(
      el,
      (rows) =>
        new Promise<void>((done) => {
          waiting.current.push(done);
          const chunks = rows.map(itemOfRow).flatMap((i) => (i === null ? [] : [chunkOf(i)]));
          setAsked((prev) => new Set([...prev, ...chunks]));
        }),
    );
  });
  useLayoutEffect(() => {
    for (const done of waiting.current.splice(0)) done();
  });

  const kept = new Set(keep.map(chunkOf));
  return (
    <div ref={host} className="gr-chunks">
      {ranges.map(({ start, count }, c) => {
        let guessed = 0;
        for (let i = start; i < start + count; i++) guessed += guess(items[i]!);
        const height = heights.current.get(c) ?? guessed;
        const drawn = near.has(c) || asked.has(c) || kept.has(c);
        return (
          // Keyed by file: a chunk must not keep another file's remembered height.
          <div
            key={`${file}#${c}`}
            className={drawn ? chunkClass : `${chunkClass} far`}
            data-chunk={c}
            data-chunk-start={start}
            data-chunk-count={count}
            style={drawn ? { containIntrinsicHeight: `auto ${height}px` } : { height }}
          >
            {drawn && items.slice(start, start + count).map((item, k) => render(item, start + k))}
          </div>
        );
      })}
    </div>
  );
}
