import { useEffect, useState, type ReactNode } from "react";
import type { Annotation } from "@amo-studio/protocol";
import { annotationNumber, type AnnotationRefs } from "./annotationRefs.js";

interface AnnotationPanelProps {
  annotations: readonly Annotation[];
  busy: boolean;
  /** False when the session is archived or handed off: nothing can be sent. */
  canSend: boolean;
  onEdit(id: string, note: string): void;
  onDelete(id: string): void;
  onLocate(annotation: Annotation): void;
  /** Keeps one at the top of the panel, sent or not (2026-10-19). */
  onPin(id: string, pinned: boolean): void;
  /** Which ones the next message refers to (2026-10-15: no separate send; they go with the next message). */
  refs: AnnotationRefs;
  /** Shown above the annotations (the task's mail). */
  header?: ReactNode;
}

/**
 * Right column of the task page: the pinned annotations first (sent or not), then the unsent ones (written in the
 * bubble by the selection), each referred to by the next message unless taken off, and the other sent ones folded
 * away, each of which can be referred to again. Newest first in each (2026-10-26).
 */
export function AnnotationPanel({ annotations, busy, canSend, onEdit, onDelete, onLocate, onPin, refs, header }: AnnotationPanelProps) {
  const [showSent, setShowSent] = useState(false);

  const newest = [...annotations].reverse();
  const unsent = newest.filter((a) => !a.sentAt);
  const pinned = newest.filter((a) => a.pinnedAt);
  const sent = newest.filter((a) => a.sentAt && !a.pinnedAt);

  const card = (a: Annotation) =>
    a.sentAt ? (
      <SentCard key={a.id} annotation={a} n={annotationNumber(a, annotations)} referred={refs.has(a.id)} canRefer={canSend} onRefer={(on) => (on ? refs.add(a.id) : refs.remove(a.id))} onLocate={onLocate} onPin={onPin} />
    ) : (
      <AnnotationCard key={a.id} annotation={a} n={annotationNumber(a, annotations)} referred={refs.has(a.id)} canRefer={canSend} onRefer={(on) => (on ? refs.add(a.id) : refs.remove(a.id))} busy={busy} onEdit={onEdit} onDelete={onDelete} onLocate={onLocate} onPin={onPin} />
    );

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

      {pinned.map(card)}

      {unsent.filter((a) => !a.pinnedAt).map(card)}

      {unsent.length > 0 && <div className="anno-hint">会作为「批注N」带进你的下一条消息，不会单独发出。</div>}

      {sent.length > 0 && (
        <div className="anno-sent">
          <button type="button" className="archived-toggle" aria-expanded={showSent} onClick={() => setShowSent((v) => !v)}>
            {showSent ? "▾" : "▸"} 已发送 {sent.length}
          </button>
          {showSent && sent.map(card)}
        </div>
      )}

    </aside>
  );
}

/** The pin toggle at the start of a card's actions. */
function PinButton({ annotation, n, onPin }: { annotation: Annotation; n: number; onPin(id: string, pinned: boolean): void }) {
  const pinned = !!annotation.pinnedAt;
  return (
    <button
      type="button"
      className="anno-pin"
      aria-pressed={pinned}
      aria-label={pinned ? `取消置顶批注${n}` : `置顶批注${n}`}
      title={pinned ? "取消置顶" : "置顶：排在批注栏最上面，发送后也留着"}
      onClick={() => onPin(annotation.id, !pinned)}
      data-testid="annotation-pin"
    >
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M4 1.5 H8 L7.4 5 L9.5 7 H2.5 L4.6 5 Z M6 7 V11" />
      </svg>
    </button>
  );
}

function SentCard({
  annotation,
  n,
  referred,
  canRefer,
  onRefer,
  onLocate,
  onPin,
}: {
  annotation: Annotation;
  n: number;
  referred: boolean;
  canRefer: boolean;
  onRefer(on: boolean): void;
  onLocate(a: Annotation): void;
  onPin(id: string, pinned: boolean): void;
}) {
  return (
    <div className={annotation.pinnedAt ? "anno-card sent pinned" : "anno-card sent"} data-testid="annotation-sent">
      <button type="button" className="anno-quote-btn" onClick={() => onLocate(annotation)} title="定位到原文">
        <span className="anno-num">批注{n}</span>「{annotation.quote}」
      </button>
      <span className="anno-note">{annotation.note}</span>
      <div className="anno-actions">
        <PinButton annotation={annotation} n={n} onPin={onPin} />
        {annotation.pinnedAt && <span className="anno-sent-tag">已发送</span>}
        <span className="spacer" />
        {referred ? (
          <button type="button" className="link-btn" onClick={() => onRefer(false)}>
            已加入下一条 · 取消
          </button>
        ) : (
          <button type="button" className="link-btn" disabled={!canRefer} onClick={() => onRefer(true)} data-testid="annotation-refer-again">
            继续引用
          </button>
        )}
      </div>
    </div>
  );
}

function AnnotationCard({
  annotation,
  n,
  referred,
  canRefer,
  onRefer,
  busy,
  onEdit,
  onDelete,
  onLocate,
  onPin,
}: {
  annotation: Annotation;
  n: number;
  referred: boolean;
  canRefer: boolean;
  onRefer(on: boolean): void;
  busy: boolean;
  onEdit(id: string, note: string): void;
  onDelete(id: string): void;
  onLocate(a: Annotation): void;
  onPin(id: string, pinned: boolean): void;
}) {
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState(annotation.note);
  useEffect(() => setNote(annotation.note), [annotation.note]);

  return (
    <div className={annotation.pinnedAt ? "anno-card pinned" : "anno-card"} data-testid="annotation">
      <button type="button" className="anno-quote-btn" onClick={() => onLocate(annotation)} title="定位到原文">
        <span className="anno-num">批注{n}</span>「{annotation.quote}」
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
          <PinButton annotation={annotation} n={n} onPin={onPin} />
          <button type="button" className="link-btn" onClick={() => setEditing(true)}>
            编辑
          </button>
          <button type="button" className="link-btn" disabled={busy} onClick={() => onDelete(annotation.id)}>
            删除
          </button>
          <span className="spacer" />
          <button
            type="button"
            className={referred ? "anno-refer on" : "anno-refer"}
            aria-pressed={referred}
            disabled={!canRefer}
            title={referred ? "下一条消息会引用它；点一下不引用" : "下一条消息不引用它；点一下引用"}
            onClick={() => onRefer(!referred)}
            data-testid="annotation-refer"
          >
            {referred ? "引用中" : "不引用"}
          </button>
        </div>
      )}
    </div>
  );
}
