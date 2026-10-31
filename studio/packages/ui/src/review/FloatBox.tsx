import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";

// 批注小窗 (2026-10-31, 问题 #2): the box a comment is written in, next to what it is about — a passage of a reply in
// a conversation (AnnotationBubble), a line of a diff or file, a passage or place of a rendered page (Reviewer). Moved
// by its head, to see what it covers; made bigger or smaller by its corner. Its size is not remembered (the user):
// each one opens at the size it opens at.

const MIN_W = 240;
const MIN_H = 120;

export function FloatBox({
  style,
  width,
  fromBottom,
  bounds,
  title,
  label,
  testId,
  className,
  boxRef,
  resetKey,
  onKeyDown,
  children,
}: {
  /** Where it opens in its positioned parent (left / top, and a transform); left out: the stylesheet's. */
  style?: CSSProperties;
  /** Its width when it opens, in px. */
  width: number;
  /** Opened above what it is about (its bottom there): made taller, its top stays where it is. */
  fromBottom?: boolean;
  /** Kept inside its parent sideways: where it opens (`left`) and the parent's width. */
  bounds?: { left: number; inner: number };
  /** Its head's words. */
  title: ReactNode;
  label: string;
  testId: string;
  className?: string;
  boxRef?: RefObject<HTMLDivElement | null>;
  /** Another one puts it back where it opens, at its first size. */
  resetKey?: unknown;
  onKeyDown?(e: KeyboardEvent<HTMLDivElement>): void;
  children: ReactNode;
}) {
  const own = useRef<HTMLDivElement>(null);
  const ref = boxRef ?? own;
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState<{ w: number; h: number | null }>({ w: width, h: null });
  useEffect(() => {
    setOffset({ x: 0, y: 0 });
    setSize({ w: width, h: null });
  }, [resetKey, width]);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const resize = useRef<{ x: number; y: number; w: number; h: number; oy: number } | null>(null);

  const placed: CSSProperties = {
    ...style,
    width: size.w,
    ...(size.h !== null ? { height: size.h } : {}),
    transform: `${style?.transform ?? ""} translate(${offset.x}px, ${offset.y}px)`.trim(),
  };

  return (
    <div ref={ref} className={`float-note${className ? ` ${className}` : ""}`} data-sized={size.h !== null ? "" : undefined} style={placed} role="dialog" aria-label={label} data-testid={testId} onKeyDown={onKeyDown}>
      <div
        className="float-note-head"
        title="按住拖动，挪开看下面的内容"
        data-testid={`${testId}-drag`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          let x = d.ox + e.clientX - d.x;
          // Sideways it stays inside its parent (when told how wide); up and down it goes where it is put.
          if (bounds) x = Math.max(8 - bounds.left, Math.min(x, bounds.inner - size.w - 8 - bounds.left));
          setOffset({ x, y: d.oy + e.clientY - d.y });
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <span className="float-note-grip" aria-hidden="true">
          ⠿
        </span>
        {title}
      </div>
      {children}
      <span
        className="float-note-resize"
        aria-hidden="true"
        title="拖动调整大小"
        data-testid={`${testId}-resize`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          resize.current = { x: e.clientX, y: e.clientY, w: size.w, h: ref.current?.offsetHeight ?? MIN_H, oy: offset.y };
        }}
        onPointerMove={(e) => {
          const r = resize.current;
          if (!r) return;
          const most = bounds ? bounds.inner - 8 - bounds.left - offset.x : Infinity;
          const w = Math.max(MIN_W, Math.min(r.w + e.clientX - r.x, most));
          const h = Math.max(MIN_H, r.h + e.clientY - r.y);
          setSize({ w, h });
          // Opened above: its bottom is where it is anchored, so it moves down by what it grew to keep its top still.
          if (fromBottom) setOffset((o) => ({ ...o, y: r.oy + h - r.h }));
        }}
        onPointerUp={() => (resize.current = null)}
        onPointerCancel={() => (resize.current = null)}
      />
    </div>
  );
}
