import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// 书签说明 (2026-10-20): adding a bookmark first asks for its note, in a small dialog with only 确认 (no close; the note
// may stay empty). For every window, like the toasts: askBookmarkNote() from anywhere, one <BookmarkNotePrompt /> per
// window shows it. A second ask while one is open waits its turn.

interface Ask {
  id: number;
  subject: string;
  resolve(note: string): void;
}

let queue: Ask[] = [];
let seq = 0;
const listeners = new Set<(ask: Ask | null) => void>();
const emit = () => listeners.forEach((l) => l(queue[0] ?? null));

/** The note for a new bookmark of `subject` (a file name, a quoted passage); "" when left empty. */
export function askBookmarkNote(subject: string): Promise<string> {
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
  const confirm = () => {
    queue = queue.filter((a) => a !== ask);
    ask.resolve(note.trim());
    emit();
  };
  return createPortal(
    // No way out but 确认: clicks outside and Esc do nothing (and Esc stays here, not closing what is underneath).
    <div className="modal-backdrop confirm-backdrop bookmark-note-backdrop" onKeyDown={(e) => e.key === "Escape" && e.stopPropagation()}>
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
        <span className="modal-title" id="bookmark-note-title">
          书签说明
        </span>
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
