import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ActionMenu } from "../lib/ActionMenu.js";
import { saveFileAs } from "../lib/saveFile.js";
import { canPan, fitLayout, MAX_SCALE, MIN_SCALE, panBy, zoomAt, ZOOM_STEP, type ImageLayout, type Size } from "./imageFit.js";

// 图片缩放、拖拽 + 右键另存为 (2026-11-11, the user: 控制端在会话里 review 一张图片时要能放大、缩小，放大后能拖动，像常规的图片
// 查看器一样；打开时默认显示全图；常规的 Reviewer 也要；图片上按右键可以「另存为…」). One picture in a pane, as image viewers
// do: fitted when it opens (whole, or by its width / height when it is very long — imageFit.ts LONG_RATIO), the wheel
// zooms where the pointer is, a drag moves it once it is larger than the pane, a double-click goes between fitted and
// its own size, + − 0 1 from the keyboard; the buttons in the corner do the same. A right-click on it: 另存为…, which
// the system's save dialog takes. Used by the viewer and 查看包 for a picture file (this computer's, or a remote task's
// copy fetched to this one — the same <img> either way) and by 看大图 over a rendered page (ImageZoom).

/** Room around a fitted picture. */
const MARGIN = 12;

export function ImageView({
  url,
  name,
  imgTestId = "image-view-img",
  testId = "image-view",
  className = "",
  margin = MARGIN,
  onBackgroundClick,
}: {
  /** What the <img> loads. */
  url: string;
  /** The file's name: the picture's alt text, and what 另存为 offers. */
  name: string;
  imgTestId?: string;
  testId?: string;
  className?: string;
  margin?: number;
  /** A click (no drag) beside the picture: 看大图 closes on it. */
  onBackgroundClick?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<Size | null>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [broken, setBroken] = useState(false);
  /** null: fitted (again when the pane changes size); else where the person zoomed or dragged it. */
  const [view, setView] = useState<ImageLayout | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; from: ImageLayout; moved: boolean; id: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    setNatural(null);
    setBroken(false);
    setView(null);
  }, [url]);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setPane((p) => (p && p.w === el.clientWidth && p.h === el.clientHeight ? p : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitted = (): ImageLayout | null => {
    if (!pane || !natural) return null;
    const f = fitLayout({ w: Math.max(1, pane.w - 2 * margin), h: Math.max(1, pane.h - 2 * margin) }, natural);
    return { scale: f.scale, x: f.x + margin, y: f.y + margin };
  };
  const fit = fitted();
  const shown = view ?? fit;
  const pannable = !!(pane && natural && shown && canPan(pane, natural, shown));

  /** Zoomed to `next` with the pane's point `at` (its middle by default) staying put. */
  const zoomTo = (next: number, at?: { x: number; y: number }) => {
    if (!pane || !natural || !shown) return;
    const fitScale = fit?.scale ?? 1;
    // Back down to the fitted size (or below it): fitted again, so it stays whole as the window changes.
    if (next <= fitScale + 1e-6 && shown.scale > fitScale) return setView(null);
    setView(zoomAt(pane, natural, shown, next, at ?? { x: pane.w / 2, y: pane.h / 2 }));
  };
  const zoomBy = (factor: number, at?: { x: number; y: number }) => shown && zoomTo(shown.scale * factor, at);
  const toActual = (at?: { x: number; y: number }) => zoomTo(1, at);

  // The wheel, not passive: the window would scroll or zoom instead (React's own wheel listener is passive).
  const latest = useRef(zoomBy);
  latest.current = zoomBy;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element | null)?.closest?.(".iv-tools, .ctx-menu")) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      latest.current(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !shown || (e.target as Element).closest(".iv-tools, .ctx-menu")) return;
    drag.current = { x: e.clientX, y: e.clientY, from: shown, moved: false, id: e.pointerId };
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || !pane || !natural) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      if (pannable) {
        box.current?.setPointerCapture?.(d.id);
        setDragging(true);
      }
    }
    if (pannable) setView(panBy(pane, natural, d.from, dx, dy));
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (d && box.current?.hasPointerCapture?.(d.id)) box.current.releasePointerCapture(d.id);
    if (d && !d.moved && e.target === box.current) onBackgroundClick?.();
  };
  const onDouble = (e: ReactMouseEvent) => {
    if (!(e.target as Element).closest(".iv-img") || !box.current) return;
    const r = box.current.getBoundingClientRect();
    if (view === null && (fit?.scale ?? 1) < 1) toActual({ x: e.clientX - r.left, y: e.clientY - r.top });
    else setView(null);
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || menu) return;
    const k = e.key;
    if (k === "+" || k === "=") zoomBy(ZOOM_STEP);
    else if (k === "-" || k === "_") zoomBy(1 / ZOOM_STEP);
    else if (k === "0") setView(null);
    else if (k === "1") toActual();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const save = () => void saveFileAs(url, name);
  const pct = shown ? Math.round(shown.scale * 100) : null;

  return (
    <div
      className={`iv${className ? ` ${className}` : ""}${pannable ? " pannable" : ""}${dragging ? " dragging" : ""}`}
      ref={box}
      tabIndex={0}
      aria-label={`图片：${name}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={onDouble}
      onKeyDown={onKey}
      data-testid={testId}
      data-fitted={view === null ? "true" : "false"}
      data-scale={shown ? shown.scale.toFixed(4) : ""}
    >
      {broken ? (
        <div className="iv-broken" role="alert">
          这张图打不开：{name}
        </div>
      ) : (
        <img
          className="iv-img"
          src={url}
          alt={name}
          draggable={false}
          style={shown && natural ? { width: natural.w * shown.scale, height: natural.h * shown.scale, transform: `translate(${shown.x}px, ${shown.y}px)` } : { visibility: "hidden" }}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
          onError={() => setBroken(true)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY });
          }}
          data-testid={imgTestId}
        />
      )}
      {natural && shown && (
        <div className="iv-tools" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} data-testid="image-view-tools">
          <span className="iv-size" title="图片大小（像素）">
            {natural.w} × {natural.h}
          </span>
          <button type="button" className="btn-ghost small" aria-label="缩小" title="缩小（−）" disabled={shown.scale <= MIN_SCALE} onClick={() => zoomBy(1 / ZOOM_STEP)} data-testid="image-view-out">
            −
          </button>
          <span className="iv-pct" data-testid="image-view-pct">
            {pct}%
          </span>
          <button type="button" className="btn-ghost small" aria-label="放大" title="放大（+，或滚轮）" disabled={shown.scale >= MAX_SCALE} onClick={() => zoomBy(ZOOM_STEP)} data-testid="image-view-in">
            +
          </button>
          <button type="button" className="btn-ghost small" aria-pressed={view === null} title="整张图放进窗口（0）；很长或很宽的图按宽度或高度放" onClick={() => setView(null)} data-testid="image-view-fit">
            适应窗口
          </button>
          <button type="button" className="btn-ghost small" aria-pressed={!!view && Math.abs(view.scale - 1) < 1e-6} title="图片本来的大小（1）" onClick={() => toActual()} data-testid="image-view-actual">
            原始大小
          </button>
        </div>
      )}
      {menu && (
        <ActionMenu
          label="图片"
          at={menu}
          onClose={() => setMenu(null)}
          testId="image-view-menu"
          groups={[
            [{ label: "另存为…", key: "S", run: save }],
            [
              { label: "适应窗口", key: "0", run: () => setView(null) },
              { label: "原始大小", key: "1", run: () => toActual() },
            ],
          ]}
        />
      )}
    </div>
  );
}
