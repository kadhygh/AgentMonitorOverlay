import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";

// 看大图 (2026-11-06): a picture of a rendered HTML or Markdown file shown enlarged over the page, instead of the viewer
// opening it in place of the page (the user clicked a screenshot in a report and could not get back). Esc, a click
// beside it or × closes it; the wheel zooms, a drag moves it once it is larger than the pane.

export type ZoomedImage = {
  /** What the <img> loads. */
  url: string;
  /** Its name, shown at the top. */
  name: string;
  /** The file it is, when there is one: 在查看器中打开 / 在资源管理器中显示 act on it. */
  open?: () => void;
  reveal?: () => void;
};

const MIN = 0.1;
const MAX = 8;

export function ImageZoom({ image, onClose }: { image: ZoomedImage; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  /** null: fitted to the pane; else the scale against the picture's own size. */
  const [scale, setScale] = useState<number | null>(null);
  const [at, setAt] = useState({ x: 0, y: 0 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [broken, setBroken] = useState(false);
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number }; moved: boolean } | null>(null);

  // The keys reach this window only: the page's frame gave the focus away when it asked for the picture.
  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  /** The scale it shows at when fitted: the whole picture in the pane, never larger than its own size. */
  const fitted = () => {
    const el = box.current;
    if (!el || !natural) return 1;
    return Math.min(1, (el.clientWidth - 48) / natural.w, (el.clientHeight - 96) / natural.h);
  };
  const shown = scale ?? fitted();

  const onWheel = (e: ReactWheelEvent) => {
    if (!natural) return;
    const next = Math.min(MAX, Math.max(MIN, shown * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    setScale(next);
    if (next <= fitted()) setAt({ x: 0, y: 0 });
  };
  const onDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, from: at, moved: false };
  };
  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    d.moved = true;
    if (shown > fitted()) setAt({ x: d.from.x + dx, y: d.from.y + dy });
  };
  const onUp = (e: ReactPointerEvent) => {
    const d = drag.current;
    drag.current = null;
    // A click beside the picture closes it; on it, nothing (a drag neither).
    if (d && !d.moved && !(e.target as Element).closest(".iz-img, .iz-bar")) onClose();
  };

  return (
    <div
      className="iz"
      ref={box}
      tabIndex={-1}
      role="dialog"
      aria-label={`看大图：${image.name}`}
      onWheel={onWheel}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      data-testid="image-zoom"
    >
      <div className="iz-bar" onPointerDown={(e) => e.stopPropagation()}>
        <span className="iz-name" title={image.name}>
          {image.name}
        </span>
        {natural && (
          <span className="iz-size">
            {natural.w} × {natural.h} · {Math.round(shown * 100)}%
          </span>
        )}
        {scale !== null && (
          <button
            type="button"
            className="btn-ghost small"
            onClick={() => {
              setScale(null);
              setAt({ x: 0, y: 0 });
            }}
          >
            适应窗口
          </button>
        )}
        {natural && scale !== 1 && (
          <button type="button" className="btn-ghost small" onClick={() => setScale(1)}>
            原始大小
          </button>
        )}
        {image.open && (
          <button type="button" className="btn-ghost small" onClick={image.open} data-testid="image-zoom-open">
            在查看器中打开
          </button>
        )}
        {image.reveal && (
          <button type="button" className="btn-ghost small" onClick={image.reveal} data-testid="image-zoom-reveal">
            在资源管理器中显示
          </button>
        )}
        <button type="button" className="btn-ghost small iz-x" aria-label="关闭" title="关闭（Esc）" onClick={onClose} data-testid="image-zoom-close">
          ×
        </button>
      </div>
      {broken ? (
        <div className="iz-broken">这张图打不开：{image.name}</div>
      ) : (
        <img
          className="iz-img"
          src={image.url}
          alt={image.name}
          draggable={false}
          style={natural ? { width: natural.w * shown, height: natural.h * shown, transform: `translate(${at.x}px, ${at.y}px)`, cursor: shown > fitted() ? "grab" : "default" } : { visibility: "hidden" }}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
          onError={() => setBroken(true)}
          data-testid="image-zoom-img"
        />
      )}
      <div className="iz-hint">Esc 或点旁边关闭 · 滚轮缩放{shown > fitted() ? " · 拖动查看" : ""}</div>
    </div>
  );
}
