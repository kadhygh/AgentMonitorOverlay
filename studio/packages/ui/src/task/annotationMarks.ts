import { useEffect, useRef, useState, type RefObject } from "react";
import type { Annotation } from "@amo-studio/protocol";
import { onAnnotationsPainted, paintedEnds } from "../review/highlights.js";
import { annotationNumber } from "../review/annotationRefs.js";

/**
 * Where the 批注N marks go: just after the end of each painted annotation, in the scroller's content coordinates, kept
 * up to date as the highlights repaint and the conversation resizes.
 */
export function useAnnotationMarks(scroller: RefObject<HTMLDivElement | null>, shown: readonly Annotation[], all: readonly Annotation[]): Array<{ id: string; n: number; top: number; left: number; title: string }> {
  const [marks, setMarks] = useState<Array<{ id: string; n: number; top: number; left: number; title: string }>>([]);
  const latest = useRef({ shown, all });
  latest.current = { shown, all };
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const box = el.getBoundingClientRect();
      const { shown: list, all: every } = latest.current;
      const next = paintedEnds().flatMap(({ id, rect }) => {
        const a = list.find((x) => x.id === id);
        if (!a) return [];
        return [{ id, n: annotationNumber(a, every), top: rect.top - box.top + el.scrollTop - 14, left: Math.min(rect.right - box.left + el.scrollLeft + 2, el.scrollWidth - 48), title: `「${a.quote}」\n${a.note}` }];
      });
      setMarks((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(place);
    };
    const off = onAnnotationsPainted(schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    schedule();
    return () => {
      off();
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [scroller]);
  return marks.filter((m) => shown.some((a) => a.id === m.id));
}
