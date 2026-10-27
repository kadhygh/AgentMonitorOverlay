import { useEffect, useRef, useState, type ReactNode } from "react";

// A modal (Studio settings.css .modal): Esc or a click outside closes it.
export function Dialog({ title, onClose, children, wide = false, className = "" }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? "wide" : ""} ${className}`} role="dialog" aria-label={typeof title === "string" ? title : undefined}>
        <div className="dialog-head">
          <b>{title}</b>
          <button type="button" className="x" onClick={onClose} title="关闭 (Esc)">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
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
