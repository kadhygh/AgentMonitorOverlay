import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { GitFileDiff, GitReviewComment } from "@amo-studio/protocol";
import { commentWhere } from "@amo-studio/protocol";
import { CodeTokens } from "../lib/CodeTokens.js";
import type { DiffRow } from "./logic.js";
import { chunkRanges, maxColumns } from "./overview.js";
import { splitRows, tokensOf, type DiffTokens, type LineRow, type SideCell } from "./splitview.js";

// The right side of the review window: one file's rows ("只看改动" or "完整文件"), in one column or side by side
// ("左右对照"), syntax-coloured, a "+" on each line to comment, and the comments under their lines.

interface DiffViewProps {
  diff: GitFileDiff;
  rows: readonly DiffRow[];
  /** "左右对照": old on the left, new on the right. */
  split: boolean;
  /** Syntax colours by line number (null: plain text). */
  tokens: DiffTokens | null;
  placed: ReadonlyMap<string, GitReviewComment[]>;
  /** Comments of this file that sit on no shown line. */
  elsewhere: readonly GitReviewComment[];
  showSent: boolean;
  /** The row key a new comment is being written for. */
  draftAt: string | null;
  /** Row index n / p moved to, or the line clicked. */
  active: number | null;
  busy: boolean;
  /** A commit's diff (S13-B): no "+" to comment. */
  readOnly?: boolean;
  onDraft(key: string | null): void;
  /** A click on a line makes it the active one (VS Code opens there). */
  onActivate(index: number): void;
  onAdd(row: LineRow, note: string): void;
  onEdit(id: string, note: string): void;
  onDelete(id: string): void;
  /** Shows a comment's line in "完整文件". */
  onLocate(comment: GitReviewComment): void;
}

const MARK = { add: "+", del: "−", context: " " } as const;

/** Clicks on a line's buttons (or inside a comment) do not move the active line. */
const plainClick = (e: MouseEvent) => !(e.target as Element).closest("button, textarea, a");

export function DiffView(props: DiffViewProps) {
  const { diff, rows, split, placed, elsewhere, showSent, busy, onEdit, onDelete, onLocate } = props;
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
      {split ? <SplitLines {...props} visible={visible} /> : <UnifiedLines {...props} visible={visible} />}
    </>
  );
}

type LinesProps = DiffViewProps & { visible(list: readonly GitReviewComment[]): GitReviewComment[] };

function Hunk({ header, hidden }: { header: string; hidden: number }) {
  return (
    <div className="gr-hunk" data-testid="diff-hunk">
      {hidden > 0 && <span className="gr-hidden">⋯ {hidden} 行未改动</span>}
      <span>{header}</span>
    </div>
  );
}

function AddButton({ row, open, onDraft }: { row: LineRow; open: boolean; onDraft(key: string | null): void }) {
  return (
    <button type="button" className="gr-add" aria-label={`给第 ${row.number} 行加批注`} title="加批注" onClick={() => onDraft(open ? null : row.key)} data-testid="add-comment">
      +
    </button>
  );
}

/** The comments under a line and the draft being written for it. */
function Notes({ row, props }: { row: LineRow; props: LinesProps }) {
  const { placed, visible, draftAt, busy, onEdit, onDelete, onAdd, onDraft } = props;
  return (
    <>
      {visible(placed.get(row.key) ?? []).map((c) => (
        <CommentCard key={c.id} comment={c} busy={busy} onEdit={onEdit} onDelete={onDelete} />
      ))}
      {draftAt === row.key && <CommentDraft busy={busy} onSave={(note) => onAdd(row, note)} onCancel={() => onDraft(null)} />}
    </>
  );
}

/** Line rows are 20px; a hunk header about 29px. A chunk's first guess at its height, before it has been drawn. */
const ROW_PX = 20;
const HUNK_PX = 29;

/**
 * Rows in chunks of CHUNK_ROWS (S13-B): each chunk is `content-visibility: auto`, so the browser lays out and paints
 * only the chunks near the screen. With the whole file drawn at once (thousands of rows, ~90k elements side by side)
 * the window could not make a frame for each new size while being resized, and flickered. `guess` is the chunk's
 * height before it is first drawn (then the browser remembers the real one).
 */
function Chunks<T>({ items, file, guess, render }: { items: readonly T[]; file: string; guess(item: T): number; render(item: T, index: number): ReactNode }) {
  const ranges = useMemo(() => chunkRanges(items.length), [items.length]);
  return (
    <>
      {ranges.map(({ start, count }, c) => {
        let height = 0;
        for (let i = start; i < start + count; i++) height += guess(items[i]!);
        return (
          // Keyed by file: a chunk must not keep another file's remembered height.
          <div key={`${file}#${c}`} className="gr-chunk" data-chunk-start={start} data-chunk-count={count} style={{ containIntrinsicHeight: `auto ${height}px` }}>
            {items.slice(start, start + count).map((item, k) => render(item, start + k))}
          </div>
        );
      })}
    </>
  );
}

/** Columns before the text in the single-column view (numbers, +, mark) and after it, in px. */
const UNIFIED_GUTTER_PX = 44 + 44 + 20 + 18 + 24;

function UnifiedLines(props: LinesProps) {
  const { diff, rows, tokens, draftAt, active, onDraft, onActivate } = props;
  // The longest line sets the width, drawn or not, so the horizontal scroll range does not change while scrolling.
  const columns = useMemo(() => maxColumns(rows), [rows]);
  return (
    <div className="gr-lines" data-testid="diff-lines" style={{ minWidth: `calc(${UNIFIED_GUTTER_PX}px + ${columns}ch)` }}>
      <Chunks
        items={rows}
        file={diff.path}
        guess={(r) => (r.kind === "hunk" ? HUNK_PX : ROW_PX)}
        render={(r, i) =>
          r.kind === "hunk" ? (
            <Hunk key={r.key} header={r.header} hidden={r.hidden} />
          ) : (
            <Fragment key={r.key}>
              <div className={`gr-line ${r.line.kind}${active === i ? " active" : ""}`} data-row={i} data-line={r.key} data-testid="diff-line" onClick={(e) => plainClick(e) && onActivate(i)}>
                <span className="gr-no">{r.line.oldLine ?? ""}</span>
                <span className="gr-no">{r.line.newLine ?? ""}</span>
                {props.readOnly ? <span /> : <AddButton row={r} open={draftAt === r.key} onDraft={onDraft} />}
                <span className="gr-mark" aria-hidden="true">
                  {MARK[r.line.kind]}
                </span>
                <span className="gr-text">
                  <CodeTokens tokens={tokensOf(tokens, r.line)} text={r.line.text} />
                </span>
              </div>
              <Notes row={r} props={props} />
            </Fragment>
          )
        }
      />
    </div>
  );
}

/** "左右对照": one scroll container, two columns per row, so both sides scroll together and stay aligned. */
function SplitLines(props: LinesProps) {
  const { diff, rows, active, placed, visible, draftAt } = props;
  const pairs = useMemo(() => splitRows(rows), [rows]);
  // Deleted lines take their comments on the left; unchanged and added lines on the right.
  const owns = (cell: SideCell | null, side: "old" | "new"): cell is SideCell => !!cell && (side === "old" ? cell.row.line.kind === "del" : cell.row.line.kind !== "del");
  const hasNotes = (cell: SideCell | null, side: "old" | "new") => owns(cell, side) && (draftAt === cell.row.key || visible(placed.get(cell.row.key) ?? []).length > 0);
  return (
    <div className="gr-lines gr-split" data-testid="diff-split">
      <Chunks
        items={pairs}
        file={`${diff.path}|split`}
        guess={(p) => (p.kind === "hunk" ? HUNK_PX : ROW_PX)}
        render={(p) =>
          p.kind === "hunk" ? (
            <Hunk key={p.key} header={p.header} hidden={p.hidden} />
          ) : (
            <Fragment key={p.key}>
              <div className={`gr-pair${active !== null && (p.left?.index === active || p.right?.index === active) ? " active" : ""}`} data-testid="diff-pair">
                <Cell cell={p.left} side="old" commentable={!props.readOnly && owns(p.left, "old")} props={props} />
                <Cell cell={p.right} side="new" commentable={!props.readOnly && owns(p.right, "new")} props={props} />
              </div>
              {(hasNotes(p.left, "old") || hasNotes(p.right, "new")) && (
                <div className="gr-pair-notes">
                  <div>{owns(p.left, "old") && <Notes row={p.left.row} props={props} />}</div>
                  <div>{owns(p.right, "new") && <Notes row={p.right.row} props={props} />}</div>
                </div>
              )}
            </Fragment>
          )
        }
      />
    </div>
  );
}

function Cell({ cell, side, commentable, props }: { cell: SideCell | null; side: "old" | "new"; commentable: boolean; props: LinesProps }) {
  if (!cell) return <div className={`gr-cell blank ${side}`} aria-hidden="true" />;
  const { row, index } = cell;
  const kind = row.line.kind === "context" ? "context" : row.line.kind;
  return (
    <div
      className={`gr-cell ${side} ${kind}`}
      data-row={index}
      {...(commentable ? { "data-line": row.key } : {})}
      data-testid={`diff-cell-${side}`}
      onClick={(e) => plainClick(e) && props.onActivate(index)}
    >
      <span className="gr-no">{(side === "old" ? row.line.oldLine : row.line.newLine) ?? ""}</span>
      {commentable ? <AddButton row={row} open={props.draftAt === row.key} onDraft={props.onDraft} /> : <span />}
      <span className="gr-mark" aria-hidden="true">
        {MARK[kind]}
      </span>
      <span className="gr-text">
        <CodeTokens tokens={tokensOf(props.tokens, row.line, side)} text={row.line.text} />
      </span>
    </div>
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
