import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";

// One set of rules for the right-click and ⋯ menus (2026-11-04, plans/done/cleanup-2026-11.md 第 7 步): there were eight,
// each closing on a different set of things (the canvas's on the wheel and when the window lost focus, the file
// menu's on a scroll, the task head's on neither) and keeping inside the window in its own way, or not.

/**
 * Closes a menu on Escape (taken before the page and any dialog under the menu), a press outside every menu (a
 * submenu or picker opened from it is a menu too), the wheel outside it, and the window losing focus. `scroll`: any
 * scroll outside it too (the file menu: its line scrolls away under it). Not by default: a running turn scrolls the
 * conversation by itself, and the task head's menus would close under the pointer.
 */
export function useMenuDismiss(box: RefObject<HTMLElement | null>, onClose: () => void, { scroll = false }: { scroll?: boolean } = {}): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const outside = (e: Event) => {
      const t = e.target;
      if (!(t instanceof Node)) return true;
      if (box.current?.contains(t)) return false;
      return !(t instanceof Element && t.closest(".ctx-menu"));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    const onDown = (e: MouseEvent) => outside(e) && close.current();
    const onWheel = (e: Event) => outside(e) && close.current();
    const onBlur = () => close.current();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    if (scroll) window.addEventListener("scroll", onWheel, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("scroll", onWheel, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [box, scroll]);
}

/** Where a menu opened at `at` goes so that it stays inside the window (near the right or bottom edge: leftwards or upwards). */
export function useInWindow(box: RefObject<HTMLElement | null>, at: { x: number; y: number }): { x: number; y: number } {
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return setPos(at);
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)) });
  }, [at.x, at.y]); // eslint-disable-line react-hooks/exhaustive-deps
  return pos;
}

/** A menu at a point (a right-click, or under the button that opened it), closed by the rules of useMenuDismiss. */
export function ContextMenu({
  at,
  label,
  onClose,
  className = "",
  testId,
  onKeyDown,
  boxRef,
  children,
}: {
  at: { x: number; y: number };
  label: string;
  onClose(): void;
  /** Classes beside `ctx-menu`. */
  className?: string;
  testId?: string;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  boxRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const own = useRef<HTMLDivElement>(null);
  const box = boxRef ?? own;
  useMenuDismiss(box, onClose);
  const pos = useInWindow(box, at);
  return (
    <div className={`ctx-menu${className ? ` ${className}` : ""}`} role="menu" aria-label={label} style={{ left: pos.x, top: pos.y }} ref={box} onContextMenu={(e) => e.preventDefault()} onKeyDown={onKeyDown} data-testid={testId}>
      {children}
    </div>
  );
}
