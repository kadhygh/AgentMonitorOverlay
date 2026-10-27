import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

// 设置 can be resized from its bottom-right corner (2026-10-27): the size is kept for the next time (this install), and a
// double click on the corner goes back to the default.

const KEY = "amo.settings.size";
const MIN_W = 640;
const MIN_H = 420;

interface Size {
  w: number;
  h: number;
}

function read(): Size | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Size> | null;
    return v && typeof v.w === "number" && typeof v.h === "number" ? { w: v.w, h: v.h } : null;
  } catch {
    return null;
  }
}

function write(size: Size | null): void {
  try {
    if (size) localStorage.setItem(KEY, JSON.stringify(size));
    else localStorage.removeItem(KEY);
  } catch {
    // Not kept: it still applies until 设置 closes.
  }
}

/** Within the window: 设置 sits 80px from the top, centred across. */
function fit(s: Size): Size {
  return { w: Math.round(Math.max(MIN_W, Math.min(s.w, window.innerWidth - 40))), h: Math.round(Math.max(MIN_H, Math.min(s.h, window.innerHeight - 100))) };
}

export function useDialogSize(): { style: CSSProperties | undefined; grip: { onPointerDown(e: ReactPointerEvent<HTMLElement>): void; onDoubleClick(): void } } {
  const [size, setSize] = useState<Size | null>(read);
  const [, setViewport] = useState(0);
  const drag = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const grip = {
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      const dialog = e.currentTarget.parentElement;
      if (!dialog || e.button !== 0) return;
      e.preventDefault();
      const r = dialog.getBoundingClientRect();
      drag.current = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      let next: Size = { w: r.width, h: r.height };
      const move = (ev: PointerEvent) => {
        const d = drag.current;
        if (!d) return;
        // Centred across, so the corner follows the pointer when the width grows by twice its move.
        next = fit({ w: d.w + 2 * (ev.clientX - d.x), h: d.h + (ev.clientY - d.y) });
        setSize(next);
      };
      const up = () => {
        drag.current = null;
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
        write(next);
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
    },
    onDoubleClick() {
      setSize(null);
      write(null);
    },
  };
  const fitted = size ? fit(size) : null;
  return { style: fitted ? { width: fitted.w, height: fitted.h, maxHeight: "none" } : undefined, grip };
}
