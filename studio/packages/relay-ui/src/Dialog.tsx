import { useEffect, useRef, useState, type ReactNode } from "react";
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
