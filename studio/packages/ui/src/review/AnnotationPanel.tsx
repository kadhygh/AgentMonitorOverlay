import { useEffect, useState, type ReactNode } from "react";
import { composeAnnotationMessage, type Annotation } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { ScratchpadEntry } from "../scratchpad/ScratchpadEntry.js";

interface AnnotationPanelProps {
  link: HostLink;
  annotations: readonly Annotation[];
  busy: boolean;
  /** False when the session is archived or handed off: nothing can be sent. */
  canSend: boolean;
  onEdit(id: string, note: string): void;
  onDelete(id: string): void;
  onLocate(annotation: Annotation): void;
  onSendAll(): void;
  /** Shown above the annotations (the task's mail). */
  header?: ReactNode;
}

/**
 * Right column of the task page: the unsent annotations (written in the bubble by the selection), send-all, and the
 * sent ones folded away.
 */
export function AnnotationPanel({ link, annotations, busy, canSend, onEdit, onDelete, onLocate, onSendAll, header }: AnnotationPanelProps) {
  const [showSent, setShowSent] = useState(false);

  const unsent = annotations.filter((a) => !a.sentAt);
  const sent = annotations.filter((a) => a.sentAt);

  return (
    <aside className="anno-panel" aria-label="批注">
      {header}
      <div className="anno-head">
        <span className="anno-title">批注</span>
        <span className="anno-count" data-testid="annotation-count">
          {unsent.length}
        </span>
      </div>

      {!annotations.length && <div className="anno-empty">选中回复里的文字，点旁边的「批注」即可添加；点高亮的段落可以修改。</div>}

      {unsent.map((a) => (
        <AnnotationCard key={a.id} annotation={a} busy={busy} onEdit={onEdit} onDelete={onDelete} onLocate={onLocate} />
      ))}

      {unsent.length > 0 && (
        <button
          type="button"
          className="btn-primary anno-send"
          disabled={busy || !canSend}
          title={composeAnnotationMessage(unsent)}
          onClick={onSendAll}
        >
          汇总发回会话（{unsent.length}）
        </button>
      )}

      {sent.length > 0 && (
        <div className="anno-sent">
          <button type="button" className="archived-toggle" aria-expanded={showSent} onClick={() => setShowSent((v) => !v)}>
            {showSent ? "▾" : "▸"} 已发送 {sent.length}
          </button>
          {showSent &&
            sent.map((a) => (
              <button key={a.id} type="button" className="anno-card sent" onClick={() => onLocate(a)} data-testid="annotation-sent">
                <span className="anno-quote">「{a.quote}」</span>
                <span className="anno-note">{a.note}</span>
              </button>
            ))}
        </div>
      )}

      <ScratchpadEntry link={link} />
    </aside>
  );
}

function AnnotationCard({ annotation, busy, onEdit, onDelete, onLocate }: { annotation: Annotation; busy: boolean; onEdit(id: string, note: string): void; onDelete(id: string): void; onLocate(a: Annotation): void }) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(annotation.note);
  useEffect(() => setNote(annotation.note), [annotation.note]);

  return (
    <div className="anno-card" data-testid="annotation">
      <button type="button" className="anno-quote-btn" onClick={() => onLocate(annotation)} title="定位到原文">
        「{annotation.quote}」
      </button>
      {editing ? (
        <form
          className="anno-edit"
          onSubmit={(e) => {
            e.preventDefault();
            if (!note.trim()) return;
            onEdit(annotation.id, note.trim());
            setEditing(false);
          }}
        >
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} aria-label="修改批注" />
          <div className="add-ws-actions">
            <button type="submit" className="btn-primary" disabled={busy || !note.trim()}>
              保存
            </button>
            <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </form>
      ) : (
        <span className="anno-note">{annotation.note}</span>
      )}
      {!editing && (
        <div className="anno-actions">
          <button type="button" className="link-btn" onClick={() => setEditing(true)}>
            编辑
          </button>
          <button type="button" className="link-btn" disabled={busy} onClick={() => onDelete(annotation.id)}>
            删除
          </button>
        </div>
      )}
    </div>
  );
}
