import { useEffect, useRef, useState } from "react";

// Short notices ("已把留言转进对话。", errors of an action) for every window: they float at the top centre over the page,
// never push it down, and go away by themselves (errors stay longer; hovering keeps one). One <Toaster /> per window.

export interface ToastInput {
  text: string;
  error?: boolean;
  /** A command to show under the text (copyable). */
  command?: string;
  /** Replaces the notice with the same key instead of adding another. */
  key?: string;
  /** Stays until closed (or dismissed by key). */
  sticky?: boolean;
  /** data-testid of this notice; the newest one is always also reachable as "toast". */
  testId?: string;
}

interface ToastItem extends ToastInput {
  id: number;
}

const INFO_MS = 4000;
const ERROR_MS = 8000;
const MAX = 3;

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<(list: ToastItem[]) => void>();
const emit = () => listeners.forEach((l) => l(items));

export function showToast(input: ToastInput | string): void {
  const t = typeof input === "string" ? { text: input } : input;
  const item = { ...t, id: ++seq };
  items = [...items.filter((x) => !t.key || x.key !== t.key), item].slice(-MAX);
  emit();
}

/** Shorthand for an error notice. */
export const showError = (text: string) => showToast({ text, error: true });

export function dismissToast(keyOrId: string | number): void {
  items = items.filter((x) => x.id !== keyOrId && x.key !== keyOrId);
  emit();
}

export function Toaster() {
  const [list, setList] = useState<ToastItem[]>(items);
  useEffect(() => {
    listeners.add(setList);
    setList(items);
    return () => void listeners.delete(setList);
  }, []);
  if (!list.length) return null;
  return (
    <div className="toaster" aria-live="polite">
      {list.map((t, i) => (
        <ToastView key={t.id} toast={t} newest={i === list.length - 1} />
      ))}
    </div>
  );
}

function ToastView({ toast, newest }: { toast: ToastItem; newest: boolean }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = () => {
    if (toast.sticky) return;
    timer.current = setTimeout(() => dismissToast(toast.id), toast.error ? ERROR_MS : INFO_MS);
  };
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one timer per notice
  useEffect(() => (start(), stop), []);
  return (
    <div
      role={toast.error ? "alert" : "status"}
      className={toast.error ? "toast toast-error" : "toast"}
      data-testid={toast.testId ?? (newest ? "toast" : "toast-older")}
      onMouseEnter={stop}
      onMouseLeave={start}
    >
      <span>{toast.text}</span>
      {toast.command && <code>{toast.command}</code>}
      <button type="button" className="toast-close" aria-label="关闭提示" onClick={() => dismissToast(toast.id)}>
        ×
      </button>
    </div>
  );
}
