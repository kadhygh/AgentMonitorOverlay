import { useEffect, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";

// A column whose width the person drags (2026-10-15: the left column and the task page's session list), kept on this
// machine. The handle is a zero-width item after the column, so it never scrolls with the column's content.

function saved(key: string, def: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return v >= min ? Math.min(v, max) : def;
  } catch {
    return def;
  }
}

export function useDragWidth(key: string, def: number, min: number, max: number): { width: number; handle: (label: string) => ReactElement } {
  const [width, setWidth] = useState(() => saved(key, def, min, max));
  const keep = (w: number) => {
    try {
      localStorage.setItem(key, String(Math.round(w)));
    } catch {
      // not kept: fine
    }
  };
  const start = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let w = startW;
    document.body.classList.add("col-resizing");
    const move = (ev: PointerEvent) => {
      w = Math.max(min, Math.min(max, startW + ev.clientX - startX));
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("col-resizing");
      keep(w);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const handle = (label: string) => (
    <div className="col-resize-gap">
      <div
        className="col-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={Math.round(width)}
        title="拖动调整宽度，双击恢复默认"
        onPointerDown={start}
        onDoubleClick={() => {
          setWidth(def);
          keep(def);
        }}
        data-testid="col-resize"
      />
    </div>
  );
  return { width, handle };
}

/** The left column's width also lines up the brand in the title bar (`--nav-w`). */
export function useNavWidthVar(width: number, on: boolean): void {
  useEffect(() => {
    if (on) document.documentElement.style.setProperty("--nav-w", `${Math.round(width)}px`);
    else document.documentElement.style.removeProperty("--nav-w");
  }, [width, on]);
}
