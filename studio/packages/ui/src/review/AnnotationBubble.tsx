import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { Annotation } from "@amo-studio/protocol";
import type { SelectionAnchor } from "../lib/selection.js";

// Annotating in place (after the ChatGPT app): selecting text in a reply shows a small bar by the selection
// (批注 / 引用); 批注 turns it into a bubble to write the note in, right there. Clicking an annotated passage opens the
// same bubble to change or delete its note. Both live inside the conversation's scroller, so they move with the text.

/** Where, in the scroller's content, a selection or a block sits. */
export interface ContentRect {
  top: number;
  bottom: number;
  left: number;
  width: number;
}

/** A viewport rect in the scroller's content coordinates. */
export function contentRect(scroller: HTMLElement, rect: DOMRect): ContentRect {
  const box = scroller.getBoundingClientRect();
  return { top: rect.top - box.top + scroller.scrollTop, bottom: rect.bottom - box.top + scroller.scrollTop, left: rect.left - box.left + scroller.scrollLeft, width: rect.width };
}

/** Below the passage, centred on it and kept inside the scroller; above it when there is no room below. */
function usePlacement(scroller: RefObject<HTMLElement | null>, at: ContentRect, width: number): { style: CSSProperties; ref: RefObject<HTMLDivElement | null> } {
  const ref = useRef<HTMLDivElement>(null);
  const [above, setAbove] = useState(false);
  const el = scroller.current;
  const inner = el ? el.clientWidth : 800;
  const left = Math.max(8, Math.min(at.left + at.width / 2 - width / 2, inner - width - 8));
  useLayoutEffect(() => {
    const s = scroller.current;
    const h = ref.current?.offsetHeight ?? 0;
    if (!s) return;
    const roomBelow = s.scrollTop + s.clientHeight - at.bottom;
    setAbove(roomBelow < h + 12 && at.top - s.scrollTop > h + 12);
  }, [scroller, at.top, at.bottom]);
  const style: CSSProperties = { left, width, ...(above ? { top: at.top - 6, transform: "translateY(-100%)" } : { top: at.bottom + 6 }) };
  return { style, ref };
}

export function SelectionBar({
  scroller,
  at,
  canQuote,
  onAnnotate,
  onQuote,
  onCopy,
  onBookmark,
}: {
  scroller: RefObject<HTMLElement | null>;
  at: ContentRect;
  canQuote: boolean;
  onAnnotate(): void;
  onQuote(): void;
  /** 复制 (2026-10-19, in place of the right-click menu): the bar stays, saying 已复制 a moment. */
  onCopy?(): void;
  /** 书签 (2026-10-19): keeps the passage under the session's topic. */
  onBookmark?(): void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  const { style, ref } = usePlacement(scroller, at, 132 + (onBookmark ? 54 : 0) + (onCopy ? 64 : 0));
  return (
    <div ref={ref} className="sel-bar" style={style} role="toolbar" aria-label="选中的文字" data-testid="selection-bar" onMouseDown={(e) => e.preventDefault()}>
      <button type="button" onClick={onAnnotate}>
        批注
      </button>
      <button type="button" disabled={!canQuote} onClick={onQuote}>
        引用
      </button>
      {onCopy && (
        <button
          type="button"
          onClick={() => {
            onCopy();
            setCopied(true);
          }}
          title="复制选中的文字"
          data-testid="selection-copy"
        >
          {copied ? "已复制" : "复制"}
        </button>
      )}
      {onBookmark && (
        <button type="button" onClick={onBookmark} title="加到这个专题的书签" data-testid="selection-bookmark">
          书签
        </button>
      )}
    </div>
  );
}

export type BubbleTarget = { kind: "new"; anchor: SelectionAnchor; at: ContentRect } | { kind: "edit"; annotation: Annotation; at: ContentRect };

export function AnnotationBubble({
  scroller,
  target,
  onSave,
  onDelete,
  onClose,
}: {
  scroller: RefObject<HTMLElement | null>;
  target: BubbleTarget;
  /** Resolves true once saved (the bubble then closes). */
  onSave(note: string): Promise<boolean>;
  onDelete?(): void;
  onClose(): void;
}) {
  const initial = target.kind === "edit" ? target.annotation.note : "";
  const quote = target.kind === "edit" ? target.annotation.quote : target.anchor.quote;
  const [note, setNote] = useState(initial);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const { style, ref } = usePlacement(scroller, target.at, 340);
  useEffect(() => {
    input.current?.focus();
    input.current?.setSelectionRange(initial.length, initial.length);
  }, [initial]);
  // A click elsewhere closes it while nothing was written (a draft is not thrown away by a stray click).
  const dirty = note.trim() !== initial.trim();
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !dirty) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [dirty, onClose, ref]);

  async function save() {
    const text = note.trim();
    if (!text || busy) return;
    if (target.kind === "edit" && text === initial.trim()) return onClose();
    setBusy(true);
    const ok = await onSave(text).catch(() => false);
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <div
      ref={ref}
      className="anno-bubble"
      style={style}
      role="dialog"
      aria-label={target.kind === "edit" ? "修改批注" : "添加批注"}
      data-testid="annotation-bubble"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void save();
        }
      }}
    >
      <blockquote className="anno-bubble-quote" title={quote}>
        {quote}
      </blockquote>
      <textarea ref={input} value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="对这段的意见或问题（Ctrl+Enter 保存）" aria-label="批注内容" />
      <div className="anno-bubble-actions">
        {target.kind === "edit" && onDelete && (
          <button type="button" className="link-btn danger" disabled={busy} onClick={onDelete}>
            删除
          </button>
        )}
        <span className="spacer" />
        <button type="button" className="btn-ghost small" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn-primary small" disabled={busy || !note.trim()} onClick={() => void save()}>
          保存
        </button>
      </div>
    </div>
  );
}
