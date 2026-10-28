import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import type { GitFileDiff, GitReviewComment } from "@amo-studio/protocol";
import { commentWhere } from "@amo-studio/protocol";
import { CodeTokens } from "../lib/CodeTokens.js";
import { dropDraft, draftText, editDraftKey, setDraftText, useEditing } from "./drafts.js";
import type { DiffRow } from "./logic.js";
import { LazyChunks } from "./LazyChunks.js";
import { CHUNK_ROWS, maxColumns } from "./overview.js";
import { splitRows, tokensOf, type DiffTokens, type LineRow, type SideCell } from "./splitview.js";

// The right side of the review window: one file's rows ("只看改动" or "完整文件"), in one column or side by side
// ("左右对照"), syntax-coloured, a "+" on each line to comment, and the comments under their lines. Stage 14 (S14-A):
// also the viewer's 文件 mode (`plain`: the file as it is now, one line number, the asked lines marked); text being
// written lives in drafts.ts, so it survives the view being drawn another way.

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
  /** The viewer's 文件 mode (S14-A): every line unchanged, one line number, no +/− column. */
  plain?: boolean;
  /** Lines to mark (the viewer's asked line or range), by new line number. */
  marked?: { from: number; to: number } | null;
  /**
   * 查看包 (2026-10-23): the agent's 重点 in the file view (`plain`) — their lines tinted, each note under its last
   * line. By new line number.
   */
  highlights?: readonly ViewMark[];
  /** Where the text of a new comment on a row (`side:line`) is kept until saved (drafts.ts). */
  draftKey(rowKey: string): string;
  onDraft(key: string | null): void;
  /** A click on a line makes it the active one (VS Code opens there). */
  onActivate(index: number): void;
  onAdd(row: LineRow, note: string): void;
  onEdit(id: string, note: string): void;
  onDelete(id: string): void;
  /** Shows a comment's line in "完整文件". */
  onLocate(comment: GitReviewComment): void;
}

/** A 重点 of a 查看包 file: lines (new numbering) and the agent's note ("" for none). */
export interface ViewMark {
  from: number;
  to: number;
  note: string;
}

const MARK = { add: "+", del: "−", context: " " } as const;

/** " hl" on a line inside a 重点, " hl hl-start" on its first line (the icon); "" otherwise. */
function hlClass(highlights: readonly ViewMark[] | undefined, n: number | null): string {
  if (n === null || !highlights?.length) return "";
  if (!highlights.some((h) => n >= h.from && n <= h.to)) return "";
  return highlights.some((h) => h.from === n) ? " hl hl-start" : " hl";
}

/** The notes of the 重点 that end on each (new) line. */
function useNotesAt(highlights: readonly ViewMark[] | undefined): Map<number, ViewMark[]> {
  return useMemo(() => {
    const by = new Map<number, ViewMark[]>();
    for (const h of highlights ?? []) if (h.note) by.set(h.to, [...(by.get(h.to) ?? []), h]);
    return by;
  }, [highlights]);
}

function HighlightNotes({ notes }: { notes: readonly ViewMark[] | undefined }) {
  return (
    <>
      {notes?.map((h) => (
        <div key={`${h.from}-${h.to}`} className="gr-hl-note" data-testid="highlight-note">
          <span className="gr-hl-where">{h.from === h.to ? `第 ${h.from} 行` : `第 ${h.from}–${h.to} 行`}</span>
          {h.note}
        </div>
      ))}
    </>
  );
}

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
  const { placed, visible, draftAt, busy, onEdit, onDelete, onAdd, onDraft, draftKey } = props;
  const key = draftKey(row.key);
  return (
    <>
      {visible(placed.get(row.key) ?? []).map((c) => (
        <CommentCard key={c.id} comment={c} busy={busy} onEdit={onEdit} onDelete={onDelete} />
      ))}
      {draftAt === row.key && (
        <CommentDraft
          busy={busy}
          store={key}
          anchor={row.key}
          onSave={(note) => onAdd(row, note)}
          onCancel={() => {
            dropDraft(key);
            onDraft(null);
          }}
        />
      )}
    </>
  );
}

/** Line rows are 20px; a hunk header about 29px. A chunk's first guess at its height, before it has been drawn. */
const ROW_PX = 20;
const HUNK_PX = 29;

/**
 * Rows whose chunks stay drawn: the active one, the one a comment is being written for, those with comments shown
 * (few, and what one looks for in a diff), the viewer's marked lines.
 */
function keepRows({ rows, active, draftAt, marked, plain, placed, visible, highlights }: LinesProps): number[] {
  const out: number[] = [];
  if (active !== null) out.push(active);
  rows.forEach((r, i) => {
    if (r.kind === "line" && (r.key === draftAt || visible(placed.get(r.key) ?? []).length > 0)) out.push(i);
  });
  // The viewer's 文件 mode has one row a line, in order.
  if (plain && marked) out.push(marked.from - 1, marked.to - 1);
  if (plain) for (const h of highlights ?? []) out.push(h.from - 1, h.to - 1);
  return out;
}

/** Columns before the text in the single-column view (numbers, +, mark) and after it, in px. */
const UNIFIED_GUTTER_PX = 44 + 44 + 20 + 18 + 24;

/** The viewer's 文件 mode: the line number column, as wide as the largest number. */
const plainNumberPx = (lines: number) => (String(lines).length + 2) * 8;

function UnifiedLines(props: LinesProps) {
  const { diff, rows, tokens, draftAt, active, onDraft, onActivate, plain, marked, highlights = [] } = props;
  // The longest line sets the width, drawn or not, so the horizontal scroll range does not change while scrolling.
  const columns = useMemo(() => maxColumns(rows), [rows]);
  const numberPx = plainNumberPx(diff.lines.length);
  const gutter = plain ? numberPx + 20 + 24 : UNIFIED_GUTTER_PX;
  const mark = (n: number | null) => {
    if (n === null) return "";
    const hl = hlClass(highlights, n);
    if (!marked || n < marked.from || n > marked.to) return hl;
    return ` marked${n === marked.from ? " first" : ""}${n === marked.to ? " last" : ""}${hl}`;
  };
  const notesAt = useNotesAt(highlights);
  return (
    <div
      className={plain ? "gr-lines gr-plain" : "gr-lines"}
      data-testid="diff-lines"
      style={{ minWidth: `calc(${gutter}px + ${columns}ch)`, ...(plain ? ({ "--gr-no-w": `${numberPx}px` } as CSSProperties) : {}) }}
    >
      <LazyChunks
        items={rows}
        size={CHUNK_ROWS}
        chunkClass="gr-chunk"
        file={diff.path}
        guess={(r) => (r.kind === "hunk" ? HUNK_PX : ROW_PX)}
        keep={keepRows(props)}
        itemOfRow={(row) => (row >= 0 && row < rows.length ? row : null)}
        render={(r, i) =>
          r.kind === "hunk" ? (
            <Hunk key={r.key} header={r.header} hidden={r.hidden} />
          ) : (
            <Fragment key={r.key}>
              <div
                className={`gr-line ${r.line.kind}${active === i ? " active" : ""}${mark(r.line.newLine)}`}
                data-row={i}
                data-line={r.key}
                data-testid="diff-line"
                onClick={(e) => plainClick(e) && onActivate(i)}
              >
                {!plain && <span className="gr-no">{r.line.oldLine ?? ""}</span>}
                <span className="gr-no">{r.line.newLine ?? ""}</span>
                {props.readOnly ? <span /> : <AddButton row={r} open={draftAt === r.key} onDraft={onDraft} />}
                {!plain && (
                  <span className="gr-mark" aria-hidden="true">
                    {MARK[r.line.kind]}
                  </span>
                )}
                <span className="gr-text">
                  <CodeTokens tokens={tokensOf(tokens, r.line)} text={r.line.text} />
                </span>
              </div>
              {r.line.newLine !== null && <HighlightNotes notes={notesAt.get(r.line.newLine)} />}
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
  // Which pair shows each row (by its index among the unified rows).
  const pairOf = useMemo(() => {
    const map = new Map<number, number>();
    pairs.forEach((p, i) => {
      if (p.kind === "hunk") return;
      if (p.left) map.set(p.left.index, i);
      if (p.right) map.set(p.right.index, i);
    });
    return map;
  }, [pairs]);
  // Deleted lines take their comments on the left; unchanged and added lines on the right.
  const owns = (cell: SideCell | null, side: "old" | "new"): cell is SideCell => !!cell && (side === "old" ? cell.row.line.kind === "del" : cell.row.line.kind !== "del");
  const hasNotes = (cell: SideCell | null, side: "old" | "new") => owns(cell, side) && (draftAt === cell.row.key || visible(placed.get(cell.row.key) ?? []).length > 0);
  const notesAt = useNotesAt(props.highlights);
  return (
    <div className="gr-lines gr-split" data-testid="diff-split">
      <LazyChunks
        items={pairs}
        size={CHUNK_ROWS}
        chunkClass="gr-chunk"
        file={`${diff.path}|split`}
        guess={(p) => (p.kind === "hunk" ? HUNK_PX : ROW_PX)}
        keep={keepRows(props).flatMap((r) => pairOf.get(r) ?? [])}
        itemOfRow={(row) => pairOf.get(row) ?? null}
        render={(p) =>
          p.kind === "hunk" ? (
            <Hunk key={p.key} header={p.header} hidden={p.hidden} />
          ) : (
            <Fragment key={p.key}>
              <div className={`gr-pair${active !== null && (p.left?.index === active || p.right?.index === active) ? " active" : ""}`} data-testid="diff-pair">
                <Cell cell={p.left} side="old" commentable={!props.readOnly && owns(p.left, "old")} props={props} />
                <Cell cell={p.right} side="new" commentable={!props.readOnly && owns(p.right, "new")} props={props} />
              </div>
              {p.right?.row.line.newLine != null && <HighlightNotes notes={notesAt.get(p.right.row.line.newLine)} />}
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
      className={`gr-cell ${side} ${kind}${side === "new" ? hlClass(props.highlights, row.line.newLine) : ""}`}
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

export function CommentDraft({
  busy,
  onSave,
  onCancel,
  store,
  anchor,
  initial = "",
  label = "批注内容",
  placeholder = "对这一行的意见或问题（Ctrl+Enter 保存）",
}: {
  busy: boolean;
  onSave(note: string): void;
  onCancel(): void;
  /** Where the text is kept until saved (drafts.ts). */
  store: string;
  /** The row it belongs to (`side:line`): a switch of view keeps this line in place. */
  anchor: string;
  initial?: string;
  label?: string;
  placeholder?: string;
}) {
  const [note, setNoteState] = useState(() => draftText(store) ?? initial);
  const setNote = (text: string) => {
    setNoteState(text);
    setDraftText(store, text);
  };
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);
  const save = () => note.trim() && onSave(note.trim());
  return (
    <form
      className="gr-draft"
      data-testid="comment-draft"
      data-anchor={anchor}
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
        placeholder={placeholder}
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
  // Being edited is kept with the text (drafts.ts): the box opens again wherever the comment is drawn next.
  const editing = useEditing(comment.id);
  const editKey = editDraftKey(comment.id);
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
        <CommentDraft busy={busy} store={editKey} anchor={`${comment.side}:${comment.line}`} initial={comment.note} label="修改批注" onSave={(note) => onEdit(comment.id, note)} onCancel={() => dropDraft(editKey)} />
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
            <button type="button" className="link-btn" onClick={() => setDraftText(editKey, comment.note)}>
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
