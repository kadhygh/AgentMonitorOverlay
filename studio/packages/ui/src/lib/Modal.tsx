import { useEffect, useRef, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

// One dialog shell (2026-11-04, plans/cleanup-2026-11.md 第 7 步): some twenty dialogs wrote the backdrop and Escape out by
// hand, some with Escape on the backdrop (only while focus was inside), some on the window (closing the dialog under
// another one too). Here: focus comes into the dialog when it opens (unless a field inside took it) and goes back when
// it closes, so Escape reaches this one first; Escape and a press on the backdrop close it — only this one, not one
// underneath (a dialog opened from it is a portal, but React passes its keys up the tree: they stop here) — unless
// `busy`. When the focus is nowhere (the button pressed went away), Escape on the window closes the dialog on top.
// Looks as before: the same .modal-backdrop / .modal classes (styles/controls.css).

/** The dialogs open now, the last on top. */
const stack: Array<{ close(): void }> = [];

export function Modal({
  label,
  labelledBy,
  role = "dialog",
  className = "",
  backdropClassName = "",
  testId,
  busy = false,
  closeOnBackdrop = true,
  onBackdrop,
  portal = false,
  boxRef,
  onSubmit,
  onKeyDown,
  onClose,
  children,
}: {
  /** The dialog's name for the screen reader (aria-label), or `labelledBy` the id of its title. */
  label?: string;
  labelledBy?: string;
  role?: "dialog" | "alertdialog";
  /** Classes beside `modal` (its size and layout). */
  className?: string;
  /** Classes beside `modal-backdrop` (confirm-backdrop: over another dialog). */
  backdropClassName?: string;
  testId?: string;
  /** Working: Escape and the backdrop do nothing. */
  busy?: boolean;
  closeOnBackdrop?: boolean;
  /** A press on the backdrop, when it does something else than Escape (提示词模板: Escape leaves the form first). */
  onBackdrop?: () => void;
  /** Into document.body (a dialog opened from inside another view's stacking context). */
  portal?: boolean;
  boxRef?: RefObject<HTMLElement | null>;
  /** The dialog is a form (编辑项目…): Enter in a field submits it. */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  /** The dialog's own keys (QuickCommit's 1 / 2); Escape is taken first. */
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  onClose(): void;
  children: ReactNode;
}) {
  const own = useRef<HTMLElement>(null);
  const box = boxRef ?? own;
  const close = useRef(() => undefined as void);
  close.current = () => {
    if (!busy) onClose();
  };
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!box.current?.contains(document.activeElement)) box.current?.focus({ preventScroll: true });
    const me = { close: () => close.current() };
    stack.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || stack[stack.length - 1] !== me) return;
      if (e.target !== document.body && e.target !== document.documentElement && e.target !== window) return;
      e.preventDefault();
      me.close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      stack.splice(stack.indexOf(me), 1);
      // Back where it was, unless what comes next took the focus (a page opened from the dialog, its field focused).
      const now = document.activeElement;
      if (before?.isConnected && (!now || now === document.body || box.current?.contains(now))) before.focus({ preventScroll: true });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const boxProps = { className: `modal${className ? ` ${className}` : ""}`, role, "aria-modal": true, "aria-label": label, "aria-labelledby": labelledBy, tabIndex: -1, "data-testid": testId } as const;
  const shell = (
    <div
      className={`modal-backdrop${backdropClassName ? ` ${backdropClassName}` : ""}`}
      onMouseDown={(e) => closeOnBackdrop && e.target === e.currentTarget && !busy && (onBackdrop ?? onClose)()}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.defaultPrevented) return onKeyDown?.(e);
        e.stopPropagation();
        e.preventDefault();
        close.current();
      }}
    >
      {onSubmit ? (
        <form ref={box as RefObject<HTMLFormElement | null>} onSubmit={onSubmit} {...boxProps}>
          {children}
        </form>
      ) : (
        <div ref={box as RefObject<HTMLDivElement | null>} {...boxProps}>
          {children}
        </div>
      )}
    </div>
  );
  return portal ? createPortal(shell, document.body) : shell;
}
