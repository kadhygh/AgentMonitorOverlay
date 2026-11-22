import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { floatsReduce, loadRect, saveRect, type FloatOpen, type FloatRect, type FloatSize, type FloatWin } from "./floatState.js";

// Floating windows over a page (2026-11-23, plans/cowork.md 第 9 条): a 协作's 子会话 — several at once — and its 白板.
//   <FloatArea>                  the page they float over (its size bounds them)
//     … useFloats().open({ id, title, status })   from a card, a list row …
//     <FloatWindow id=…>content</FloatWindow>    rendered by whoever owns the content, anywhere inside the area
//     <FloatTabs />                the folded ones, a row of small tabs (above the group chat's box)
// A folded window stays mounted (hidden), so what was typed in it is still there when it opens again. Each window's
// place and size are kept on this computer under its id. Nothing here knows of sessions or boards.

interface FloatsApi {
  wins: FloatWin[];
  open: (o: Omit<FloatOpen, "saved">) => void;
  close: (id: string) => void;
  focus: (id: string) => void;
  minimize: (id: string) => void;
  restore: (id: string) => void;
  toggleMax: (id: string) => void;
  /** Change what its title bar (and tab) say: a 子会话's state moved on. */
  setInfo: (id: string, info: { title?: string; status?: string }) => void;
  isOpen: (id: string) => boolean;
}

interface FloatsCtx extends FloatsApi {
  layer: HTMLDivElement | null;
  area: () => FloatSize;
  move: (id: string, rect: FloatRect) => void;
}

const Ctx = createContext<FloatsCtx | null>(null);

export function useFloats(): FloatsApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useFloats outside a FloatArea");
  return c;
}

export function FloatArea({ children, className }: { children: ReactNode; className?: string }) {
  const [wins, dispatch] = useReducer(floatsReduce, []);
  const box = useRef<HTMLDivElement>(null);
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);
  const area = useCallback((): FloatSize => ({ w: box.current?.clientWidth || 800, h: box.current?.clientHeight || 600 }), []);

  // The page got smaller (the window was resized): the windows come back inside it.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => dispatch({ type: "area", area: area() }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [area]);

  const winsRef = useRef(wins);
  winsRef.current = wins;
  const api = useMemo<FloatsCtx>(
    () => ({
      wins,
      layer,
      area,
      open: (o) => dispatch({ type: "open", ...o, saved: loadRect(o.id), area: area() }),
      close: (id) => dispatch({ type: "close", id }),
      focus: (id) => dispatch({ type: "focus", id }),
      minimize: (id) => dispatch({ type: "minimize", id }),
      restore: (id) => dispatch({ type: "restore", id }),
      toggleMax: (id) => dispatch({ type: "toggleMax", id }),
      setInfo: (id, info) => dispatch({ type: "info", id, ...info }),
      isOpen: (id) => winsRef.current.some((w) => w.id === id),
      move: (id, rect) => {
        dispatch({ type: "move", id, rect, area: area() });
      },
    }),
    [wins, layer, area],
  );
  return (
    <Ctx.Provider value={api}>
      <div className={`float-area ${className ?? ""}`} ref={box}>
        {children}
        <div className="float-layer" ref={setLayer} />
      </div>
    </Ctx.Provider>
  );
}

type Drag = { kind: "move" | "size"; x: number; y: number; start: FloatRect; id: number };

/**
 * One window. Renders nothing until `open` was called for its id; folded, it stays mounted but hidden. `actions` sit in
 * the title bar before 收起 / 最大化 / 关闭; `onClose` is told when it is closed (the window is gone either way).
 */
export function FloatWindow(props: { id: string; children: ReactNode; actions?: ReactNode; onClose?: () => void; className?: string }) {
  const f = useContext(Ctx);
  const win = f?.wins.find((w) => w.id === props.id);
  // While dragging, the rectangle follows the pointer here; the area hears of it once, at the end.
  const [live, setLive] = useState<FloatRect | null>(null);
  const drag = useRef<Drag | null>(null);
  const liveRef = useRef<FloatRect | null>(null);
  liveRef.current = live;
  useLayoutEffect(() => setLive(null), [win?.rect]);
  if (!f || !win || !f.layer) return null;

  const begin = (kind: Drag["kind"]) => (e: ReactPointerEvent) => {
    if (e.button !== 0 || win.maximized) return;
    if (kind === "move" && (e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind, x: e.clientX, y: e.clientY, start: win.rect, id: e.pointerId };
    f.focus(win.id);
  };
  const during = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const a = f.area();
    const r = d.kind === "move" ? { ...d.start, x: d.start.x + dx, y: d.start.y + dy } : { ...d.start, w: d.start.w + dx, h: d.start.h + dy };
    // Inside the area while it moves too (the same rule the area applies at the end).
    const x = Math.min(Math.max(r.x, 0), Math.max(a.w - r.w, 0));
    const y = Math.min(Math.max(r.y, 0), Math.max(a.h - r.h, 0));
    setLive(d.kind === "move" ? { ...r, x, y } : { ...r, w: Math.max(Math.min(r.w, a.w - r.x), 280), h: Math.max(Math.min(r.h, a.h - r.y), 180) });
  };
  const end = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const r = liveRef.current;
    if (!r) return;
    f.move(win.id, r);
    saveRect(win.id, r);
  };
  const close = () => {
    f.close(win.id);
    props.onClose?.();
  };

  const r = live ?? win.rect;
  const style = win.maximized ? { zIndex: win.z } : { zIndex: win.z, left: r.x, top: r.y, width: r.w, height: r.h };
  return createPortal(
    <section
      className={`float-win ${win.maximized ? "max" : ""} ${props.className ?? ""}`}
      style={style}
      hidden={win.minimized}
      role="dialog"
      aria-label={win.title}
      data-float={win.id}
      onPointerDownCapture={() => f.focus(win.id)}
    >
      <header className="float-head" onPointerDown={begin("move")} onPointerMove={during} onPointerUp={end} onPointerCancel={end} onDoubleClick={(e) => !(e.target as HTMLElement).closest("button") && f.toggleMax(win.id)}>
        <span className="float-title">{win.title}</span>
        {win.status && <span className="float-status">{win.status}</span>}
        <span className="grow" />
        {props.actions}
        <button type="button" className="float-btn" title="收起成标签" aria-label="收起" onClick={() => f.minimize(win.id)}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 9h8" />
          </svg>
        </button>
        <button type="button" className="float-btn" title={win.maximized ? "还原" : "最大化"} aria-label={win.maximized ? "还原" : "最大化"} onClick={() => f.toggleMax(win.id)}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            {win.maximized ? <path d="M3.5 4.5h5v5h-5zM4.5 4.5v-2h5v5h-1" /> : <path d="M2.5 2.5h7v7h-7z" />}
          </svg>
        </button>
        <button type="button" className="float-btn close" title="关闭" aria-label="关闭" onClick={close}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" />
          </svg>
        </button>
      </header>
      <div className="float-body">{props.children}</div>
      {!win.maximized && <span className="float-grip" title="拖动改大小" onPointerDown={begin("size")} onPointerMove={during} onPointerUp={end} onPointerCancel={end} />}
    </section>,
    f.layer,
  );
}

/** The folded windows as a row of small tabs (title + state); a click opens one again. Nothing when none is folded. */
export function FloatTabs({ className }: { className?: string }) {
  const f = useContext(Ctx);
  const folded = (f?.wins ?? []).filter((w) => w.minimized);
  if (!f || !folded.length) return null;
  return (
    <div className={`float-tabs ${className ?? ""}`} role="toolbar" aria-label="收起的弹窗">
      {folded.map((w) => (
        <button key={w.id} type="button" className="float-tab" data-float={w.id} title={`展开「${w.title}」`} onClick={() => f.restore(w.id)}>
          <span className="float-tab-title">{w.title}</span>
          {w.status && <span className="float-tab-status">{w.status}</span>}
        </button>
      ))}
    </div>
  );
}
