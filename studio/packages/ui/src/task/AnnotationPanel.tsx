import { useEffect, useRef, useState } from "react";
import type { SelectionAnchor } from "../lib/selection.js";

interface AnnotationPanelProps {
  /** Selection waiting for a note ("添加批注"). */
  pending: SelectionAnchor | null;
  busy: boolean;
  onSave(note: string): void;
  onCancel(): void;
}

/** Right column of the task page: the annotation being written. S2-04 adds the list, highlights and sending. */
export function AnnotationPanel({ pending, busy, onSave, onCancel }: AnnotationPanelProps) {
  const [note, setNote] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setNote("");
    if (pending) input.current?.focus();
  }, [pending]);

  return (
    <aside className="anno-panel" aria-label="批注">
      <div className="anno-head">
        <span className="anno-title">批注</span>
      </div>
      {pending && (
        <form
          className="anno-draft"
          data-testid="annotation-draft"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) onSave(note.trim());
          }}
        >
          <blockquote className="anno-quote">「{pending.quote}」</blockquote>
          <label className="stack-field">
            <span className="sr-only">批注内容</span>
            <textarea ref={input} value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="对这段的意见或问题" aria-label="批注内容" />
          </label>
          <div className="add-ws-actions">
            <button type="submit" className="btn-primary" disabled={busy || !note.trim()}>
              保存
            </button>
            <button type="button" className="btn-ghost" onClick={onCancel}>
              取消
            </button>
          </div>
        </form>
      )}
      {!pending && <div className="anno-empty">选中回复里的文字后右键，即可添加批注。</div>}
    </aside>
  );
}
