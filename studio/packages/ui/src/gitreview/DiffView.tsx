import { Fragment, useEffect, useRef, useState } from "react";
import type { GitFileDiff, GitReviewComment } from "@amo-studio/protocol";
import { commentWhere } from "@amo-studio/protocol";
import type { DiffRow } from "./logic.js";

// The right side of the review window: one file's rows ("只看改动" or "完整文件"), a "+" on each line to comment,
// and the comments under their lines.

interface DiffViewProps {
  diff: GitFileDiff;
  rows: readonly DiffRow[];
  placed: ReadonlyMap<string, GitReviewComment[]>;
  /** Comments of this file that sit on no shown line. */
  elsewhere: readonly GitReviewComment[];
  showSent: boolean;
  /** The row key a new comment is being written for. */
  draftAt: string | null;
  /** Row index n / p moved to. */
  active: number | null;
  busy: boolean;
  onDraft(key: string | null): void;
  onAdd(row: Extract<DiffRow, { kind: "line" }>, note: string): void;
  onEdit(id: string, note: string): void;
  onDelete(id: string): void;
  /** Shows a comment's line in "完整文件". */
  onLocate(comment: GitReviewComment): void;
}

const MARK = { add: "+", del: "−", context: " " } as const;

export function DiffView({ diff, rows, placed, elsewhere, showSent, draftAt, active, busy, onDraft, onAdd, onEdit, onDelete, onLocate }: DiffViewProps) {
  const visible = (list: readonly GitReviewComment[]) => list.filter((c) => showSent || c.state === "draft");
  const others = visible(elsewhere);

  if (diff.binary) return <div className="gr-notice">二进制文件，没有文本差异。</div>;
  if (diff.tooLarge) return <div className="gr-notice">文件太大（超过 2 万行或 4 MB），不在这里显示。</div>;

  return (
    <>
      {others.length > 0 && (
        <div className="gr-elsewhere" data-testid="comments-elsewhere">
          <div className="gr-elsewhere-head">不在当前视图里的批注 {others.length}</div>
          {others.map((c) => (
            <CommentCard key={c.id} comment={c} busy={busy} onEdit={onEdit} onDelete={onDelete} where={commentWhere(c)} onLocate={c.side === "new" ? () => onLocate(c) : undefined} />
          ))}
        </div>
      )}
      {!rows.length && <div className="gr-notice">{diff.lines.length ? "没有文字改动。" : "空文件。"}</div>}
      <div className="gr-lines" data-testid="diff-lines">
        {rows.map((r, i) =>
          r.kind === "hunk" ? (
            <div key={r.key} className="gr-hunk" data-testid="diff-hunk">
              {r.hidden > 0 && <span className="gr-hidden">⋯ {r.hidden} 行未改动</span>}
              <span>{r.header}</span>
            </div>
          ) : (
            <Fragment key={r.key}>
              <div className={`gr-line ${r.line.kind}${active === i ? " active" : ""}`} data-row={i} data-line={r.key} data-testid="diff-line">
                <span className="gr-no">{r.line.oldLine ?? ""}</span>
                <span className="gr-no">{r.line.newLine ?? ""}</span>
                <button
                  type="button"
                  className="gr-add"
                  aria-label={`给第 ${r.number} 行加批注`}
                  title="加批注"
                  onClick={() => onDraft(draftAt === r.key ? null : r.key)}
                  data-testid="add-comment"
                >
                  +
                </button>
                <span className="gr-mark" aria-hidden="true">
                  {MARK[r.line.kind]}
                </span>
                <span className="gr-text">{r.line.text}</span>
              </div>
              {visible(placed.get(r.key) ?? []).map((c) => (
                <CommentCard key={c.id} comment={c} busy={busy} onEdit={onEdit} onDelete={onDelete} />
              ))}
              {draftAt === r.key && <CommentDraft busy={busy} onSave={(note) => onAdd(r, note)} onCancel={() => onDraft(null)} />}
            </Fragment>
          ),
        )}
      </div>
    </>
  );
}

function CommentDraft({ busy, onSave, onCancel, initial = "", label = "批注内容" }: { busy: boolean; onSave(note: string): void; onCancel(): void; initial?: string; label?: string }) {
  const [note, setNote] = useState(initial);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);
  const save = () => note.trim() && onSave(note.trim());
  return (
    <form
      className="gr-draft"
      data-testid="comment-draft"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <textarea
        ref={input}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") onCancel();
        }}
        rows={3}
        placeholder="对这一行的意见或问题（Ctrl+Enter 保存）"
        aria-label={label}
      />
      <div className="add-ws-actions">
        <button type="submit" className="btn-primary small" disabled={busy || !note.trim()}>
          保存
        </button>
        <button type="button" className="btn-ghost small" onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}

function CommentCard({ comment, busy, onEdit, onDelete, where, onLocate }: { comment: GitReviewComment; busy: boolean; onEdit(id: string, note: string): void; onDelete(id: string): void; where?: string; onLocate?: () => void }) {
  const [editing, setEditing] = useState(false);
  const sent = comment.state === "sent";
  return (
    <div className={sent ? "gr-comment sent" : "gr-comment"} data-testid="review-comment">
      {where && (
        <div className="gr-comment-where">
          <span>{where}</span>
          <code>{comment.lineText.trim() || "（空行）"}</code>
        </div>
      )}
      {editing ? (
        <CommentDraft
          busy={busy}
          initial={comment.note}
          label="修改批注"
          onSave={(note) => {
            onEdit(comment.id, note);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <span className="gr-comment-note">{comment.note}</span>
      )}
      {!editing && (
        <div className="anno-actions">
          {sent && <span className="gr-comment-sent">已发送</span>}
          {onLocate && (
            <button type="button" className="link-btn" onClick={onLocate}>
              定位
            </button>
          )}
          {!sent && (
            <button type="button" className="link-btn" onClick={() => setEditing(true)}>
              编辑
            </button>
          )}
          <button type="button" className="link-btn" disabled={busy} onClick={() => onDelete(comment.id)}>
            删除
          </button>
        </div>
      )}
    </div>
  );
}
