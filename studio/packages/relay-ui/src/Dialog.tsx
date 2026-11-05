import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { Avatar, Who } from "./bits.js";
import { TASK_STATUSES, type TaskStatus } from "./shared.js";

// The parts every dialog is made of (2026-10-27, after 「很丑，尽量少用下拉菜单」): a modal in three bands — head, body,
// foot with buttons of one height — fields whose label and hint share a line, and choices as buttons to click (people,
// task states, a task) instead of drop-downs.

export function Dialog(props: { title: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; wide?: boolean; className?: string; bare?: boolean; sub?: ReactNode }) {
  const { onClose } = props;
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${props.wide ? "wide" : ""} ${props.className ?? ""}`} role="dialog" aria-label={typeof props.title === "string" ? props.title : undefined}>
        <div className="dialog-head">
          <div className="dialog-titles">
            <b>{props.title}</b>
            {props.sub && <span className="dialog-sub">{props.sub}</span>}
          </div>
          <button type="button" className="x" onClick={onClose} title="关闭 (Esc)">
            ×
          </button>
        </div>
        {props.bare ? props.children : <div className="dialog-body">{props.children}</div>}
        {props.foot && <div className="dialog-foot">{props.foot}</div>}
      </div>
    </div>
  );
}

/**
 * A panel over the page that is not modal (2026-11-05, the user: 审核的窗口会遮挡后面的内容，也无法拖拽): no backdrop, so
 * what is behind stays readable and clickable; moved by its head, sized by its left edge and its corner, 铺满 / 还原.
 * It opens on the right part of the window, the conversation still showing on the left. Esc closes it unless something
 * inside took the key (a note being written).
 */
export function FloatPanel(props: { title: ReactNode; onClose: () => void; children: ReactNode; className?: string; label?: string }) {
  const { onClose } = props;
  const first = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const left = Math.max(16, Math.round(w * 0.3));
    return { x: left, y: 48, w: Math.max(480, w - left - 16), h: Math.max(320, h - 64) };
  };
  const [rect, setRect] = useState(first);
  const [full, setFull] = useState(false);
  const drag = useRef<{ kind: "move" | "left" | "corner"; x: number; y: number; r: typeof rect } | null>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const start = (kind: "move" | "left" | "corner") => (e: RPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || full) return;
    // Buttons in the head stay buttons.
    if (kind === "move" && (e.target as HTMLElement).closest("button, select, input, a")) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { kind, x: e.clientX, y: e.clientY, r: rect };
  };
  const move = (e: RPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (d.kind === "move") setRect({ ...d.r, x: Math.min(Math.max(d.r.x + dx, 80 - d.r.w), W - 80), y: Math.min(Math.max(d.r.y + dy, 0), H - 40) });
    else if (d.kind === "left") {
      const w = Math.max(420, d.r.w - dx);
      setRect({ ...d.r, x: d.r.x + d.r.w - w, w });
    } else setRect({ ...d.r, w: Math.max(420, d.r.w + dx), h: Math.max(260, d.r.h + dy) });
  };
  const end = () => (drag.current = null);
  const style = full ? { left: 8, top: 8, width: "calc(100vw - 16px)", height: "calc(100vh - 16px)" } : { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
  return (
    <div className={`dialog float-panel ${props.className ?? ""}`} role="dialog" aria-label={props.label ?? (typeof props.title === "string" ? props.title : undefined)} style={style} data-full={full ? "" : undefined}>
      <div className="dialog-head" title={full ? undefined : "按住拖动"} onPointerDown={start("move")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onDoubleClick={(e) => !(e.target as HTMLElement).closest("button, select, input, a") && setFull(!full)}>
        <div className="dialog-titles">
          <b>{props.title}</b>
        </div>
        <button type="button" className="small" onClick={() => setFull(!full)} title={full ? "回到原来的大小和位置" : "铺满窗口（双击标题栏也行）"}>
          {full ? "还原" : "铺满"}
        </button>
        <button type="button" className="x" onClick={onClose} title="关闭 (Esc)">
          ×
        </button>
      </div>
      {props.children}
      {!full && (
        <>
          <span className="float-panel-left" aria-hidden="true" title="拖动调整宽度" onPointerDown={start("left")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
          <span className="float-panel-corner" aria-hidden="true" title="拖动调整大小" onPointerDown={start("corner")} onPointerMove={move} onPointerUp={end} onPointerCancel={end} />
        </>
      )}
    </div>
  );
}

/** A labelled field: the label and an optional hint on one line, the control under them. */
export function Field({ label, hint, children, wide = true }: { label: ReactNode; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`field ${wide ? "" : "half"}`}>
      <div className="field-label">
        <span>{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** One of a few choices, as buttons. */
export function Pick<T extends string>({ options, value, onChange, label }: { options: Array<{ value: T; label: ReactNode; title?: string }>; value: T; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="pick" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={o.value === value ? "on" : ""} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Whom: the team as avatars to click. */
export function PersonPick({ people, value, onChange, me, label = "人" }: { people: string[]; value: string; onChange: (name: string) => void; me?: string; label?: string }) {
  return (
    <Pick
      label={label}
      value={value}
      onChange={onChange}
      options={people.map((p) => ({
        value: p,
        label: (
          <>
            <Avatar name={p} small />
            <Who name={p} />
            {p === me ? <span className="muted">（我）</span> : null}
          </>
        ),
      }))}
    />
  );
}

/** A task's state, each with its colour. */
export function StatusPick({ value, onChange }: { value: TaskStatus; onChange: (s: TaskStatus) => void }) {
  return (
    <Pick
      label="状态"
      value={value}
      onChange={onChange}
      options={TASK_STATUSES.map((s) => ({
        value: s,
        label: (
          <>
            <span className={`dot st-${s}`} />
            {s}
          </>
        ),
      }))}
    />
  );
}

/** A tick with its words. */
export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="check-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

/** A button that opens a small menu under it; a click outside or on an item closes it. */
export function Menu({ label, title, items }: { label: ReactNode; title?: string; items: Array<{ label: ReactNode; onClick: () => void; hint?: string } | null> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);
  return (
    <div className="menu-box" ref={box}>
      <button type="button" className="tb-btn" aria-expanded={open} title={title} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div className="menu" role="menu">
          {items.map((it, i) =>
            it ? (
              <button
                key={i}
                type="button"
                role="menuitem"
                title={it.hint}
                onClick={() => {
                  setOpen(false);
                  it.onClick();
                }}
              >
                {it.label}
              </button>
            ) : (
              <div key={i} className="menu-sep" />
            ),
          )}
        </div>
      )}
    </div>
  );
}
