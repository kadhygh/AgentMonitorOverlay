import { useEffect, useMemo, useRef, useState } from "react";
import type { GitFileDiff, GitReviewComment, ProposalViewItem, StateSnapshot, ViewPack, Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { showToast } from "../lib/toast.js";
import { DiffView } from "../gitreview/DiffView.js";
import { dropDraft, newDraftKey } from "../gitreview/drafts.js";
import { changeStarts, cycle, diffRows, sessionChoices, step, type DiffMode } from "../gitreview/logic.js";
import { revealRow } from "../gitreview/reveal.js";
import { useDiffTokens } from "../gitreview/tokens.js";
import { proposalMessage, type ProposalComment } from "./logic.js";

// A 查看包's 改动预览 (2026-10-23): what the agent proposes a file becomes, shown against the file as Git Review shows
// a change (单栏 / 左右对照, 只看改动 / 完整文件). Nothing on disk changes, so there is no 书签; comments are for this
// look only — kept in the window, sent back to the conversation as one message.

export function ProposalItemView({ link, state, pack, workspace, item, active }: { link: HostLink; state: StateSnapshot; pack: ViewPack; workspace: Workspace; item: ProposalViewItem; active: boolean }) {
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [split, setSplit] = useState(false);
  const [mode, setMode] = useState<DiffMode>(item.isNew ? "full" : "changes");
  const [comments, setComments] = useState<ProposalComment[]>([]);
  const [draftAt, setDraftAt] = useState<string | null>(null);
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const choices = useMemo(() => sessionChoices(state, workspace.id, pack.sessionId ?? undefined), [state, workspace.id, pack.sessionId]);
  const [target, setTarget] = useState(pack.sessionId ?? choices[0]?.id ?? "");

  useEffect(() => {
    let live = true;
    call(link, "GET /api/viewpacks/:id/items/:itemId/diff", { id: pack.id, itemId: item.id })
      .then((d) => live && setDiff(d))
      .catch((err: unknown) => live && setError(err instanceof HostApiError ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [link, pack.id, item.id, item.proposed]);

  const rows = useMemo(() => (diff ? diffRows(diff, mode) : []), [diff, mode]);
  const tokens = useDiffTokens(diff);
  // DiffView draws comments as Review's; these live only here.
  const asComment = (c: ProposalComment): GitReviewComment => ({
    id: c.id,
    workspaceId: workspace.id,
    range: "working",
    path: item.path,
    side: c.side,
    line: c.line,
    lineText: c.lineText,
    note: c.note,
    state: "draft",
    sessionId: null,
    createdAt: "",
    updatedAt: "",
    sentAt: null,
  });
  const placed = useMemo(() => {
    const keys = new Set(rows.filter((r) => r.kind === "line").map((r) => r.key));
    const map = new Map<string, GitReviewComment[]>();
    for (const c of comments) {
      const key = `${c.side}:${c.line}`;
      if (keys.has(key)) map.set(key, [...(map.get(key) ?? []), asComment(c)]);
    }
    return map;
  }, [comments, rows]); // eslint-disable-line react-hooks/exhaustive-deps
  const elsewhere = useMemo(() => comments.filter((c) => !placed.has(`${c.side}:${c.line}`)).map(asComment), [comments, placed]); // eslint-disable-line react-hooks/exhaustive-deps
  const draftKey = (rowKey: string) => newDraftKey(`viewpack:${pack.id}`, item.id, rowKey);

  // Git Review's keys (2026-10-23): e 单栏 ⇄ 左右对照, a / d 只看改动 / 完整文件, n / p (l / ;) between changes,
  // Tab / Shift+Tab between the commented lines, w / s a page; not while typing.
  const scroller = useRef<HTMLDivElement>(null);
  const changeRows = useMemo(() => changeStarts(rows), [rows]);
  const markRows = useMemo(() => rows.flatMap((r, i) => (r.kind === "line" && placed.has(r.key) ? [i] : [])), [rows, placed]);
  useEffect(() => {
    if (!active) return;
    const toRow = (row: number) => {
      setActiveRow(row);
      if (scroller.current) void revealRow(scroller.current, row).then((r) => r?.scrollIntoView({ block: "center" }));
    };
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || el?.closest?.("input, textarea, select, [contenteditable]")) return;
      // Either case: Caps Lock or Shift does not change what a key does (2026-10-23).
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === "e") {
        e.preventDefault();
        setSplit((v) => !v);
      } else if (k === "a" || k === "d") {
        e.preventDefault();
        setMode(k === "a" ? "changes" : "full");
      } else if (k === "n" || k === "p" || k === "l" || k === ";") {
        const on = k === "n" || k === "l";
        const to = step(changeRows, activeRow ?? (on ? -1 : rows.length), on ? 1 : -1);
        if (to === null) return;
        e.preventDefault();
        toRow(to);
      } else if (k === "Tab") {
        const to = cycle(markRows, activeRow, e.shiftKey ? -1 : 1);
        if (to === null) return;
        e.preventDefault();
        toRow(to);
      } else if (k === "w" || k === "s") {
        const box = scroller.current;
        if (!box) return;
        e.preventDefault();
        box.scrollBy({ top: (k === "s" ? 1 : -1) * Math.max(40, box.clientHeight - 60) });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, changeRows, markRows, activeRow, rows.length]);

  async function send() {
    if (!target || !comments.length) return;
    setBusy(true);
    try {
      await call(link, "POST /api/sessions/:id/messages", { id: target }, { text: proposalMessage(pack, item, comments) });
      setComments([]);
      showToast({ text: "批注已发回会话" });
    } catch (err) {
      showToast({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vp-item" data-testid="viewpack-proposal">
      <div className="vp-item-head">
        <span className="vp-item-path">
          {item.path}
          <span className="vp-tag">{item.isNew ? "新文件 · 改动预览" : "改动预览"}</span>
        </span>
        <div className="vw-actions">
          <div className="gr-seg" role="group" aria-label="范围">
            <button type="button" aria-pressed={mode === "changes"} title="只看改动（A）" onClick={() => setMode("changes")}>
              只看改动
              <kbd className="gr-key">A</kbd>
            </button>
            <button type="button" aria-pressed={mode === "full"} title="完整文件（D）" onClick={() => setMode("full")}>
              完整文件
              <kbd className="gr-key">D</kbd>
            </button>
          </div>
          <div className="gr-seg" role="group" aria-label="显示方式" title="E：单栏和左右对照来回切换">
            <button type="button" aria-pressed={!split} onClick={() => setSplit(false)}>
              单栏
            </button>
            <button type="button" aria-pressed={split} onClick={() => setSplit(true)}>
              左右对照
            </button>
            <kbd className="gr-key gr-seg-key">E</kbd>
          </div>
        </div>
      </div>
      <div className="vp-note vp-note-dim">{item.note ? `${item.note}\n` : ""}这只是预览：磁盘上的文件没有改。批注只在这个窗口里，发回会话后清空。</div>
      <div className="gr-scroll-wrap">
        <div className="gr-scroll vp-proposal-scroll" ref={scroller}>
          {error && <div className="gr-notice">读不到改动：{error}</div>}
          {!diff && !error && <div className="gr-notice">正在比较…</div>}
          {diff && (
            <DiffView
              diff={diff}
              rows={rows}
              split={split}
              tokens={tokens}
              placed={placed}
              elsewhere={elsewhere}
              showSent={false}
              draftAt={draftAt}
              active={active ? activeRow : null}
              busy={busy}
              draftKey={draftKey}
              onDraft={setDraftAt}
              onActivate={setActiveRow}
              onAdd={(row, note) => {
                setComments((cs) => [...cs, { id: `c${Date.now()}${cs.length}`, side: row.side, line: row.number, lineText: row.line.text, note }]);
                dropDraft(draftKey(row.key));
                setDraftAt(null);
              }}
              onEdit={(id, note) => setComments((cs) => cs.map((c) => (c.id === id ? { ...c, note } : c)))}
              onDelete={(id) => setComments((cs) => cs.filter((c) => c.id !== id))}
              onLocate={() => setMode("full")}
            />
          )}
        </div>
      </div>
      {comments.length > 0 && (
        <div className="vp-send" data-testid="viewpack-send">
          <span>{comments.length} 条批注</span>
          <select className="field" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="发给哪个会话">
            {choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <button type="button" className="btn-primary small" disabled={busy || !target} onClick={() => void send()} data-testid="viewpack-send-button">
            发回会话
          </button>
        </div>
      )}
    </div>
  );
}
