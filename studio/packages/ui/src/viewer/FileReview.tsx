import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GitFileDiff, StateSnapshot, TextFile, Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { showToast } from "../lib/toast.js";
import { DiffView, type ViewMark } from "../gitreview/DiffView.js";
import { commentsChanged, SendBar, useReviewComments } from "../gitreview/comments.js";
import { dropDraft, editDraftKey, newDraftKey } from "../gitreview/drafts.js";
import { FindBar } from "../gitreview/FindBar.js";
import { cycle, diffRows, placeComments } from "../gitreview/logic.js";
import { revealRow } from "../gitreview/reveal.js";
import { OverviewRuler } from "../gitreview/OverviewRuler.js";
import { markRuns, type RulerKind } from "../gitreview/overview.js";
import { useDiffTokens } from "../gitreview/tokens.js";
import { relativeIn } from "./logic.js";

// The viewer's 文件 mode for code (stage 14, S14-A): the file as it is now, drawn as Git Review draws a file (every
// line unchanged, one line number), so its lines take comments the same way: a "+" on each line, the comment under
// it, and the same send bar. Comments are on the file and line, not on a session (range `file`): the same file opened
// from two conversations shows the same drafts; the send bar starts at the conversation that opened it last. Ctrl+G
// goes to a line, Ctrl+F finds.

/** The file as an unchanged diff: what DiffView draws and the highlight worker colours (once per file read). */
function asDiff(file: TextFile, path: string): GitFileDiff {
  const texts = (file.text ?? "").replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  return {
    range: "working",
    path,
    binary: false,
    tooLarge: false,
    lines: texts.map((text, i) => ({ kind: "context", oldLine: i + 1, newLine: i + 1, text })),
    hunks: [],
  };
}

export function FileReview({
  link,
  state,
  workspace,
  file,
  line,
  endLine,
  openKey,
  defaultSession,
  active,
  highlights,
  onActiveRow,
}: {
  link: HostLink;
  state: StateSnapshot;
  /** The project the file is in; comments need one. */
  workspace: Workspace | null;
  file: TextFile;
  line?: number | undefined;
  endLine?: number | undefined;
  /** Changes with every open (another file, or the same one again): scroll back to `line`. */
  openKey: string;
  /** The session comments go to unless another is picked: the conversation that opened the file, or the latest. */
  defaultSession: string | null;
  /** In front (the viewer's 文件 mode): keys are its own. */
  active: boolean;
  /** 查看包 (2026-10-23): the agent's 重点, drawn on the lines with their notes. */
  highlights?: readonly ViewMark[];
  /** The line being looked at changed (Tab, a click, find, an open): its row, null for none. */
  onActiveRow?: (row: number | null) => void;
}) {
  // Comments name the file relative to its project, as Review does.
  const rel = workspace ? relativeIn(file.path, workspace.path) : null;
  const diff = useMemo(() => asDiff(file, rel ?? file.path), [file, rel]);
  const rows = useMemo(() => diffRows(diff, "full"), [diff]);
  const tokens = useDiffTokens(diff);
  const comments = useReviewComments(link, workspace?.id ?? "", !!workspace && rel !== null);
  const { placed, elsewhere } = useMemo(() => placeComments(rel ? comments : [], rel ?? "", "file", rows), [comments, rel, rows]);
  const [draftAt, setDraftAt] = useState<string | null>(null);
  const [active_, setActive] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState(defaultSession ?? "");
  const [goto, setGoto] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const last = line ? Math.max(line, endLine ?? line) : 0;

  // Opened again (maybe from another conversation): the send bar follows it.
  useEffect(() => setTarget(defaultSession ?? ""), [defaultSession, openKey]);

  // To the asked line or range on every open: a range that fits shows whole a third of the way down; a longer one
  // starts near the top.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Opened at a line: that line is the current one, so Tab goes on from it (as after clicking a 重点 on top).
    setActive(line ? line - 1 : null);
    if (!line) {
      el.scrollTop = 0;
      return;
    }
    scrollToLine(el, line, (last - line + 1) * 20 < el.clientHeight * 0.6 ? el.clientHeight / 3 : 40);
  }, [openKey, file]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => onActiveRow?.(active_), [active_]); // eslint-disable-line react-hooks/exhaustive-deps

  // The marked lines, for Tab: the commented ones and the 重点 (a line's row is its number less one).
  const markRows = useMemo(() => {
    const at = new Set(rows.flatMap((r, i) => (r.kind === "line" && placed.has(r.key) ? [i] : [])));
    for (const h of highlights ?? []) at.add(h.from - 1);
    return [...at].filter((i) => i >= 0 && i < rows.length).sort((a, b) => a - b);
  }, [rows, placed, highlights]);
  // The overview ruler as the scrollbar, as in Git Review (2026-10-23): no changes here, the 重点 and the comments.
  const plainKinds = useMemo<RulerKind[]>(() => rows.map(() => "context"), [rows]);
  const rulerMarks = useMemo(() => {
    const hl = new Set<string>();
    for (const h of highlights ?? []) for (let n = h.from; n <= h.to; n++) hl.add(`new:${n}`);
    const keyOf = (i: number) => [rows[i]!.key];
    return [...markRuns(rows.length, keyOf, hl, "hl"), ...markRuns(rows.length, keyOf, new Set(placed.keys()), "note")];
  }, [rows, highlights, placed]);
  const toRow = (row: number) => {
    setActive(row);
    const el = scroller.current;
    if (el) void revealRow(el, row).then((r) => r?.scrollIntoView({ block: "center" }));
  };

  // Ctrl+G goes to a line; as in Git Review (2026-10-23): Tab / Shift+Tab between the marked lines, w / s a page.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        setGoto(true);
        return;
      }
      const el = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || el?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Tab") {
        const to = cycle(markRows, active_, e.shiftKey ? -1 : 1);
        if (to === null) return;
        e.preventDefault();
        toRow(to);
      } else if (e.key === "w" || e.key === "s") {
        const box = scroller.current;
        if (!box) return;
        e.preventDefault();
        box.scrollBy({ top: (e.key === "s" ? 1 : -1) * Math.max(40, box.clientHeight - 60) });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, markRows, active_]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      showToast({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  const ws = rel !== null ? workspace : null;
  const drafts = comments.filter((c) => c.state === "draft");
  const findTexts = useMemo(() => rows.map((r) => (r.kind === "line" ? r.line.text : "")), [rows]);
  const topRow = () => {
    const el = scroller.current;
    if (!el) return 0;
    const top = el.getBoundingClientRect().top;
    const first = [...el.querySelectorAll<HTMLElement>("[data-row]")].find((r) => r.getBoundingClientRect().bottom > top);
    return first ? Number(first.dataset.row) : 0;
  };

  return (
    <div className="vw-review" data-testid="viewer-code" data-highlighted={tokens ? "" : undefined}>
      <div className="gr-scroll-wrap">
        <FindBar active={active && !goto} container={scroller} texts={findTexts} rowSelector={(row) => `[data-row="${row}"] .gr-text`} cellSelector=".gr-text" fromRow={topRow} onCurrent={setActive} />
        {goto && (
          <GoToLine
            lines={rows.length}
            onGo={(n) => {
              setGoto(false);
              setActive(n - 1);
              if (scroller.current) scrollToLine(scroller.current, n, scroller.current.clientHeight / 3);
            }}
            onClose={() => setGoto(false)}
          />
        )}
        <div className="gr-scroll ruled" ref={scroller}>
          <DiffView
            diff={diff}
            rows={rows}
            split={false}
            plain
            marked={line ? { from: line, to: last } : null}
            {...(highlights ? { highlights } : {})}
            tokens={tokens}
            placed={placed}
            elsewhere={elsewhere}
            showSent={false}
            draftAt={draftAt}
            active={active_}
            busy={busy}
            readOnly={!ws}
            draftKey={(rowKey) => newDraftKey(ws?.id ?? "", rel ?? "", rowKey)}
            onDraft={setDraftAt}
            onActivate={setActive}
            onAdd={(row, note) =>
              ws &&
              rel &&
              run(async () => {
                await call(link, "POST /api/workspaces/:id/review-comments", { id: ws.id }, { range: "file", path: rel, side: "new", line: row.number, lineText: row.line.text, note });
                dropDraft(newDraftKey(ws.id, rel, row.key));
                setDraftAt(null);
                commentsChanged(ws.id);
              })
            }
            onEdit={(id, note) =>
              ws &&
              run(async () => {
                await call(link, "PATCH /api/review-comments/:id", { id }, { note });
                dropDraft(editDraftKey(id));
                commentsChanged(ws.id);
              })
            }
            onDelete={(id) =>
              ws &&
              run(async () => {
                await call(link, "DELETE /api/review-comments/:id", { id });
                dropDraft(editDraftKey(id));
                commentsChanged(ws.id);
              })
            }
            onLocate={(c) => {
              const el = scroller.current;
              if (el && c.side === "new") scrollToLine(el, c.line, el.clientHeight / 3);
            }}
          />
        </div>
        {rows.length > 0 && <OverviewRuler scroller={scroller} kinds={plainKinds} marks={rulerMarks} />}
      </div>
      {/* The keys of this view, so they can be found (2026-10-23); r 重新载入 is on its button. */}
      <div className="vw-keys" data-testid="viewer-keys">
        {markRows.length > 0 && (
          <span>
            <kbd className="gr-key">Tab</kbd>
            <kbd className="gr-key">Shift Tab</kbd> 下一处 / 上一处{highlights?.length ? "重点或批注" : "批注"}
          </span>
        )}
        <span>
          <kbd className="gr-key">w</kbd>
          <kbd className="gr-key">s</kbd> 翻页
        </span>
        <span>
          <kbd className="gr-key">Ctrl G</kbd> 跳到行
        </span>
        <span>
          <kbd className="gr-key">Ctrl F</kbd> 查找
        </span>
      </div>
      {/* The project's drafts (written here or in Review) go out from here too; shown once there are some. */}
      {ws && (drafts.length > 0 || draftAt) && <SendBar link={link} state={state} workspace={ws} comments={comments} target={target} onTarget={setTarget} busy={busy} run={run} />}
    </div>
  );
}

/** Puts line `n` (1-based) `lead` px below the top of the view; its chunk is drawn first if it was not. */
function scrollToLine(scroller: HTMLElement, n: number, lead: number) {
  void revealRow(scroller, n - 1).then((row) => {
    if (!row) return;
    row.scrollIntoView({ block: "start" });
    scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - lead;
  });
}

/** Ctrl+G's box: a line number, Enter to go there, Esc to close. */
function GoToLine({ lines, onGo, onClose }: { lines: number; onGo(line: number): void; onClose(): void }) {
  const [value, setValue] = useState("");
  const n = Number(value);
  const ok = Number.isInteger(n) && n >= 1 && n <= lines;
  return (
    <form
      className="find-bar goto-bar"
      role="dialog"
      aria-label="跳到行"
      data-testid="goto-line"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onGo(n);
      }}
    >
      <input
        className="field"
        autoFocus
        inputMode="numeric"
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/[^\d]/g, ""))}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        onBlur={onClose}
        placeholder={`跳到行（1–${lines}）`}
        aria-label="行号"
        data-testid="goto-input"
      />
      <span className="find-count">{value && !ok ? `只有 ${lines} 行` : "Enter 跳过去"}</span>
    </form>
  );
}
