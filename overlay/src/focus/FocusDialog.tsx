import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function FocusDialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null), titleId = useId();
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input, button, select, textarea")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="amo-focus-backdrop" onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); close.current(); }
    if (event.key !== "Tab") return;
    const targets = Array.from(ref.current?.querySelectorAll<HTMLElement>("button, input, select, textarea, summary, [tabindex='0']") ?? []).filter(el => !el.hasAttribute("disabled") && el.getClientRects().length);
    const first = targets[0], last = targets[targets.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} className="amo-focus-dialog">
    <header className="amo-focus-dialog-header"><h2 id={titleId}>{title}</h2><button aria-label={`关闭${title}`} onClick={onClose}><X size={16} /></button></header>
    <div className="amo-focus-dialog-body">{children}</div>
  </div></div>;
}
