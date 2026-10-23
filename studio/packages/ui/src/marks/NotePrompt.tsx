import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// 书签说明 (2026-10-20): adding a bookmark first asks for its note, in a small dialog (the note may stay empty). × or
// Esc closes it without adding the bookmark (2026-10-23). For every window, like the toasts: askBookmarkNote() from
// anywhere, one <BookmarkNotePrompt /> per window shows it. A second ask while one is open waits its turn.

interface Ask {
  id: number;
  subject: string;
  resolve(note: string | null): void;
}

/** The person closed 书签说明 (× or Esc): no bookmark. */
export class BookmarkCancelled extends Error {
  constructor() {
    super("没有加书签");
  }
}

let queue: Ask[] = [];
let seq = 0;
const listeners = new Set<(ask: Ask | null) => void>();
const emit = () => listeners.forEach((l) => l(queue[0] ?? null));

/** The note for a new bookmark of `subject` (a file name, a quoted passage); "" when left empty, null when closed. */
export function askBookmarkNote(subject: string): Promise<string | null> {
  return new Promise((resolve) => {
    queue = [...queue, { id: ++seq, subject, resolve }];
    emit();
  });
}

export function BookmarkNotePrompt() {
  const [ask, setAsk] = useState<Ask | null>(queue[0] ?? null);
  useEffect(() => {
    listeners.add(setAsk);
    setAsk(queue[0] ?? null);
    return () => void listeners.delete(setAsk);
  }, []);
  return ask ? <NoteDialog key={ask.id} ask={ask} /> : null;
}

function NoteDialog({ ask }: { ask: Ask }) {
  const [note, setNote] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => box.current?.focus(), []);
  const close = (value: string | null) => {
    queue = queue.filter((a) => a !== ask);
    ask.resolve(value);
    emit();
  };
  const confirm = () => close(note.trim());
  return createPortal(
    // Esc closes it without a bookmark (and stays here, not closing what is underneath); a click outside does nothing.
    <div
      className="modal-backdrop confirm-backdrop bookmark-note-backdrop"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        e.preventDefault();
        close(null);
      }}
    >
      <form
        className="modal confirm-modal bookmark-note"
        role="dialog"
        aria-modal="true"
        aria-labelledby="bookmark-note-title"
        data-testid="bookmark-note"
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        <div className="modal-head">
          <span className="modal-title" id="bookmark-note-title">
            书签说明
          </span>
          <span className="spacer" />
          <button type="button" className="icon-btn" aria-label="不加书签" title="不加书签（Esc）" onClick={() => close(null)} data-testid="bookmark-note-cancel">
            ×
          </button>
        </div>
        <span className="bookmark-note-subject" title={ask.subject}>
          {ask.subject}
        </span>
        <textarea
          ref={box}
          className="field"
          rows={4}
          value={note}
          maxLength={2000}
          placeholder="这个书签记的是什么（可以留空）"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              confirm();
            }
          }}
          data-testid="bookmark-note-text"
        />
        <div className="settings-row end">
          <button type="submit" className="btn-primary small" title="确认（Ctrl+Enter）" data-testid="bookmark-note-ok">
            确认
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
