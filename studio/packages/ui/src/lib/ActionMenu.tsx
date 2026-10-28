import { useEffect, useLayoutEffect, useRef, useState } from "react";

// A right-click menu of actions in groups (2026-10-28, first for files): a rule between groups, each action's key on
// its right; while the menu is open that key runs it (the menu takes the keys before the page does, so they do not
// clash with the page's own). Closes on Escape, on a press outside it and when anything scrolls; stays in the window.

export interface MenuAction {
  label: string;
  /** One letter, shown on the right and pressed to run it. */
  key?: string;
  run(): void;
  disabled?: boolean;
  title?: string;
}

type Slot = MenuAction | false | null | undefined;

export function ActionMenu({ label, at, groups, onClose, testId }: { label: string; at: { x: number; y: number }; groups: ReadonlyArray<readonly Slot[]>; onClose(): void; testId?: string }) {
  const shown = groups.map((g) => g.filter((a): a is MenuAction => !!a)).filter((g) => g.length);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  const latest = useRef({ shown, onClose });
  latest.current = { shown, onClose };

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)) });
    // Opened from a page in a frame (位置批注): the keys would go to the frame, so the menu takes the focus.
    if (document.activeElement?.tagName === "IFRAME") el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [at.x, at.y]);

  useEffect(() => {
    const close = () => latest.current.onClose();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return close();
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1) return;
      const action = latest.current.shown.flat().find((a) => a.key && a.key.toLowerCase() === e.key.toLowerCase());
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      if (action.disabled) return;
      close();
      action.run();
    };
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && close();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", close, true);
    };
  }, []);

  return (
    <div className="ctx-menu action-menu" role="menu" aria-label={label} style={{ left: pos.x, top: pos.y }} ref={box} data-testid={testId}>
      {shown.map((group, i) => (
        <div key={i} role="group" className="action-group">
          {i > 0 && <hr className="menu-rule" />}
          {group.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              disabled={a.disabled}
              title={a.title}
              aria-keyshortcuts={a.key}
              onClick={() => {
                onClose();
                a.run();
              }}
            >
              <span>{a.label}</span>
              {a.key && (
                <kbd className="menu-key" aria-hidden="true">
                  {a.key}
                </kbd>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
