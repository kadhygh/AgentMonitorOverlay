import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { showToast } from "../lib/toast.js";
import {
  rangeBase,
  type GitChangedFile,
  type GitChanges,
  type GitCommitChanges,
  type GitFileDiff,
  type GitRange,
  type StateSnapshot,
  type Workspace,
} from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useHostState } from "../host/useHostState.js";
import { openInApps, openInEditor, revealInExplorer } from "../lib/openin.js";
import { DiffView } from "./DiffView.js";
import { FileList, FileMenu, Splitter, type FileMenuAt } from "./FileList.js";
import { ancestors, fileOrder, readPrefs, writePrefs, type ListLayout, type ReviewPrefs } from "./filetree.js";
import { changeStarts, diffRows, draftCounts, parseReviewHash, placeComments, step, type DiffMode, type DiffRow, type ReviewTarget } from "./logic.js";
import { captureAnchor, restoreAnchor, type ViewAnchor } from "./anchor.js";
import { revealRow } from "./reveal.js";
import { commentsChanged, SendBar, useReviewComments } from "./comments.js";
import { dropDraft, editDraftKey, newDraftKey } from "./drafts.js";
import { FindBar } from "./FindBar.js";
import { editorLine } from "./splitview.js";
import { DiffCache, type DiffRequest } from "./diffcache.js";
import { diffTokensFor, useDiffTokens } from "./tokens.js";
import { findChangedFile } from "../viewer/logic.js";
import { OverviewRuler } from "./OverviewRuler.js";
import { pairKinds, rowKinds } from "./overview.js";
import { splitRows } from "./splitview.js";
import { CommitPicker, readHistory } from "./CommitPicker.js";
import { openReview, switchReview } from "./open.js";
import { FileHead, ReviewHead } from "./ReviewHead.js";

// The Git Review window (#review?workspace=…&session=…): a project's changed files on the left, one file's diff on
// the right, comments on lines, and "发给会话" to send the drafts to a session as one message. With `&commit=…`
// (S13-B, from 历史) it shows one commit's changes against its first parent instead, read-only.

export function ReviewApp() {
  const host = useHostState();
  const [target, setTarget] = useState<ReviewTarget | null>(() => parseReviewHash(location.hash));
  // Opened again for another session: the window stays, the hash changes.
  useEffect(() => {
    const on = () => setTarget(parseReviewHash(location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  if (host.kind !== "ready") return <div className="placeholder">{host.kind === "connecting" ? "正在连接 Host…" : `未连接：${host.reason}`}</div>;
  const ws = target && host.state.workspaces.find((w) => w.id === target.workspaceId);
  if (!target || !ws) return <div className="placeholder">项目不存在或已移除。</div>;
  return (
    <ReviewPage
      key={`${ws.id}@${target.commit ?? ""}@${target.base ?? ""}`}
      link={host.link}
      state={host.state}
      workspace={ws}
      sessionId={target.sessionId ?? null}
      commit={target.commit ?? null}
      base={target.base ? { sha: target.base, label: target.baseLabel ?? null } : null}
      select={target.file && !target.commit ? { path: target.file, nonce: target.nonce ?? "" } : null}
    />
  );
}

/** A file the page was asked to show (stage 13: 用 git diff 看, and the viewer's 改动 mode). */
export interface ReviewSelect {
  /** Absolute, or relative to the project. */
  path: string;
  /** A new value asks again (the same file opened twice). */
  nonce: string;
}

type Toast = { text: string; error?: boolean } | null;

const LIST_LAYOUTS: { id: ListLayout; label: string }[] = [
  { id: "tree", label: "目录树" },
  { id: "flat", label: "平铺" },
];

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "");

export function ReviewPage({
  link,
  state,
  workspace,
  sessionId,
  commit = null,
  base: given = null,
  select = null,
  embedded = false,
  inactive = false,
}: {
  link: HostLink;
  state: StateSnapshot;
  workspace: Workspace;
  sessionId: string | null;
  /** A commit's window (S13-B, from 历史): that commit's changes, read-only. */
  commit?: string | null;
  /**
   * 外部打开 Review (2026-10-18): what to compare with instead — the working tree against it (本分支 with this base,
   * comments as usual), or with `commit`, the commit against it.
   */
  base?: { sha: string; label: string | null } | null;
  select?: ReviewSelect | null;
  /** Inside the viewer window (its 改动 mode): the viewer names the window. */
  embedded?: boolean;
  /** Kept but not in front (the viewer's 文件 mode): keys are not its own. */
  inactive?: boolean;
}) {
  const [range, setRange] = useState<GitRange>(given && !commit ? "branch" : "working");
  // The view choices (list width and layout, 单栏 / 左右对照, 只看改动 / 完整文件) stay on this machine.
  const [prefs, setPrefs] = useState<ReviewPrefs>(readPrefs);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  useEffect(() => writePrefs(prefs), [prefs]);
  const pref = useCallback(<K extends keyof ReviewPrefs>(key: K, value: ReviewPrefs[K]) => setPrefs((p) => ({ ...p, [key]: value })), []);
  const mode = prefs.mode;
  // A switch of view keeps the line being commented (or the one at the top) where it was on screen (S14-A).
  const scroller = useRef<HTMLDivElement>(null);
  const pendingAnchor = useRef<ViewAnchor | null>(null);
  const rowsRef = useRef<readonly DiffRow[]>([]);
  const keepPlace = () => {
    const el = scroller.current;
    pendingAnchor.current = el ? captureAnchor(el, rowsRef.current) : null;
  };
  const setMode = (m: DiffMode) => {
    if (m === mode) return;
    keepPlace();
    pref("mode", m);
  };
  const setSplit = (split: boolean) => {
    if (split === prefs.split) return;
    keepPlace();
    pref("split", split);
  };
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const [menu, setMenu] = useState<FileMenuAt | null>(null);
  const [vscode, setVscode] = useState(false);
  const [changes, setChanges] = useState<GitChanges | null>(null);
  // A commit's window: the commit and its files (`changes` stays empty).
  const [shownCommit, setShownCommit] = useState<GitCommitChanges | null>(null);
  // 历史: from its button (typing into the search box) or from h (j / k pick, typing starts a search).
  const [picking, setPicking] = useState<null | "search" | "keys">(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [target, setTarget] = useState<string>(sessionId ?? "");
  const [showSent, setShowSent] = useState(false);
  const [draftAt, setDraftAt] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const setToast = (t: Toast) => void (t && showToast(t));

  // Diffs once read stay (刷新 forgets them); neighbours and the file under the pointer are read ahead, and their
  // colours worked out ahead in the highlight worker.
  const cache = useMemo(
    () =>
      new DiffCache(
        ({ range: r, base, file: f, commit: sha }) =>
          sha
            ? call(link, "GET /api/workspaces/:id/git/commit-diff", { id: workspace.id }, undefined, { sha, base, path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}) })
            : call(link, "GET /api/workspaces/:id/git/diff", { id: workspace.id }, undefined, {
                range: r,
                path: f.path,
                ...(f.oldPath ? { oldPath: f.oldPath } : {}),
                base,
                untracked: f.untracked ? "1" : "0",
              }),
        (d) => void diffTokensFor(d),
      ),
    [link, workspace.id],
  );

  useEffect(() => setTarget(sessionId ?? ""), [sessionId]);
  useEffect(() => {
    if (embedded) return;
    const c = shownCommit?.commit;
    document.title = commit ? `提交 ${short(c?.sha ?? commit)}${c ? ` · ${c.subject}` : ""} · ${workspace.name}` : `Git Review · ${workspace.name}`;
  }, [workspace.name, commit, shownCommit, embedded]);

  const fail = (err: unknown, prefix = "") => setToast({ text: prefix + (err instanceof HostApiError ? err.message : String(err)), error: true });

  // "VS Code 打开" shows only when the machine has VS Code.
  useEffect(() => {
    let live = true;
    openInApps(link)
      .then((a) => live && setVscode(a.vscode))
      .catch(() => live && setVscode(false));
    return () => {
      live = false;
    };
  }, [link]);
  const openFile = (f: GitChangedFile, app: "vscode" | "explorer", line?: number) => {
    const ref = { path: f.path, workspaceId: workspace.id };
    (app === "vscode" ? openInEditor(link, ref, line) : revealInExplorer(link, ref)).catch((err: unknown) => fail(err, app === "vscode" ? "VS Code 打开失败：" : "在资源管理器中显示失败："));
  };

  // The selected file's folders open (j / k may walk into a folded one).
  useEffect(() => {
    if (!selected) return;
    setClosed((c) => {
      const up = ancestors(selected).filter((a) => c.has(a));
      return up.length ? new Set([...c].filter((x) => !up.includes(x))) : c;
    });
  }, [selected]);
  const toggleFolder = (folder: string) =>
    setClosed((c) => {
      const next = new Set(c);
      if (!next.delete(folder)) next.add(folder);
      return next;
    });

  // The changed files of the range; the selection stays on its file when it is still changed.
  useEffect(() => {
    if (commit) return;
    let live = true;
    call(link, "GET /api/workspaces/:id/git/changes", { id: workspace.id }, undefined, { range, ...(range === "branch" && given ? { base: given.sha, ...(given.label ? { label: given.label } : {}) } : {}) })
      .then((c) => {
        if (!live) return;
        setChanges(c);
        setSelected((cur) => (cur && c.files.some((f) => f.path === cur) ? cur : (fileOrder(c.files, prefsRef.current.layout)[0]?.path ?? null)));
      })
      .catch((err: unknown) => live && fail(err));
    return () => {
      live = false;
    };
  }, [link, workspace.id, range, reload, commit, given?.sha, given?.label]); // eslint-disable-line react-hooks/exhaustive-deps -- the base by value
  // 历史 read ahead, once the window's own files are in (and again on 刷新): h opens it at once.
  const hasHistory = !!commit || !!changes?.status.repo;
  useEffect(() => {
    if (!hasHistory) return;
    const t = setTimeout(() => readHistory(link, workspace.id).catch(() => undefined), 300);
    return () => clearTimeout(t);
  }, [link, workspace.id, hasHistory, reload]);
  // A commit's files, once: a commit does not change.
  useEffect(() => {
    if (!commit) return;
    let live = true;
    call(link, "GET /api/workspaces/:id/git/commit", { id: workspace.id }, undefined, { sha: commit, ...(given ? { base: given.sha } : {}) })
      .then((c) => {
        if (!live) return;
        setShownCommit(c);
        setSelected(fileOrder(c.files, prefsRef.current.layout)[0]?.path ?? null);
      })
      .catch((err: unknown) => live && setCommitError(err instanceof HostApiError ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [link, workspace.id, commit, given?.sha]); // eslint-disable-line react-hooks/exhaustive-deps -- the base by value

  // Asked for a file (用 git diff 看): the uncommitted changes (or, opened with a base, the working tree against it), read
  // again, then that file, or a word that it has none.
  const wanted = useRef<ReviewSelect | null>(null);
  // The open that last read the changes: on mounting they are being read anyway, and the same open again (the viewer
  // resolving a relative path once the file is read) needs no second read (2026-10-20: git ran twice or three times).
  const readFor = useRef<string | null>(null);
  const pickWanted = (c: GitChanges) => {
    const want = wanted.current;
    if (!want || c.range !== (given ? "branch" : "working")) return;
    wanted.current = null;
    const hit = findChangedFile(c.files, want.path, workspace.path);
    if (hit) setSelected(hit.path);
    else if (c.status.repo) setToast({ text: "这个文件没有未提交的改动" });
  };
  useEffect(() => {
    if (!select || commit) return;
    wanted.current = select;
    const mounting = readFor.current === null;
    const sameOpen = !!select.nonce && readFor.current === select.nonce;
    readFor.current = select.nonce;
    setRange(given ? "branch" : "working");
    if (mounting) return;
    if (sameOpen) {
      if (changes) pickWanted(changes);
      return;
    }
    cache.clear();
    setReload((n) => n + 1);
  }, [select?.path, select?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (changes) pickWanted(changes);
  }, [changes]); // eslint-disable-line react-hooks/exhaustive-deps

  // What the list shows: the range's changes, or the commit's files.
  const listed = commit ? shownCommit : changes;
  const file = listed?.files.find((f) => f.path === selected) ?? null;
  const fileKey = file ? `${file.oldPath ?? ""}>${file.path}` : "";
  // The commit the listing compared with: a diff then takes one git call.
  const base = commit ? (shownCommit?.base ?? null) : changes?.status.repo && changes.range === range ? rangeBase(range, changes.status) : null;
  const sha = shownCommit?.commit.sha ?? null;
  const request = useCallback((f: GitChangedFile): DiffRequest | null => (base ? { range, base, file: f, ...(sha ? { commit: sha } : {}) } : null), [range, base, sha]);
  // Another file or range: start over. A refresh keeps the page (and a comment being written) until the new diff arrives.
  useEffect(() => {
    setDraftAt(null);
    setActive(null);
  }, [fileKey, range]);
  useEffect(() => {
    const req = file && request(file);
    if (!req) {
      if (!file) setDiff(null);
      return;
    }
    // Read before (or read ahead): at once, no request.
    const hit = cache.peek(req);
    if (hit) {
      setDiff(hit);
      return;
    }
    let live = true;
    cache
      .load(req)
      .then((d) => live && setDiff(d))
      .catch((err: unknown) => live && fail(err));
    return () => {
      live = false;
    };
    // The file object changes on every reload; its identity is its path and old path.
  }, [cache, request, fileKey, reload]);

  // A commit's window is read-only: no comments there. Shared with the window's other views of them (the viewer).
  const comments = useReviewComments(link, workspace.id, !commit);
  const loadComments = () => commentsChanged(workspace.id);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  // The diff of the file and range in front (a refresh or a switch is on its way otherwise).
  const shown = diff && file && diff.path === file.path && (sha ? diff.commit === sha : !diff.commit && diff.range === range) ? diff : null;
  const rows = useMemo(() => (shown ? diffRows(shown, mode) : []), [shown, mode]);
  const changeRows = useMemo(() => changeStarts(rows), [rows]);
  // The overview ruler's items: rows, or side-by-side pairs.
  const rulerKinds = useMemo(() => (prefs.split ? pairKinds(splitRows(rows)) : rowKinds(rows)), [rows, prefs.split]);
  rowsRef.current = rows;
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    pendingAnchor.current = null;
    if (anchor && scroller.current) void restoreAnchor(scroller.current, rows, anchor);
  }, [rows, prefs.split]);
  const { placed, elsewhere } = useMemo(() => placeComments(comments, selected ?? "", range, rows), [comments, selected, range, rows]);
  const order = useMemo(() => fileOrder(listed?.files ?? [], prefs.layout), [listed, prefs.layout]);
  // Syntax colours of both versions, from the highlight worker; plain text until they arrive.
  const tokens = useDiffTokens(shown);
  // Once the file in front is shown, the next files (and the one before) are read ahead.
  useEffect(() => {
    if (!shown) return;
    const i = order.findIndex((f) => f.path === shown.path);
    if (i < 0) return;
    cache.prefetch([order[i + 1], order[i + 2], order[i - 1], order[i + 3]].flatMap((f) => (f && request(f) ? [request(f)!] : [])));
  }, [shown, order, cache, request]);
  const readAhead = useCallback(
    (f: GitChangedFile) => {
      const req = request(f);
      if (req && !cache.peek(req)) cache.prefetch([req]);
    },
    [cache, request],
  );
  const drafts = comments.filter((c) => c.state === "draft");
  const sentCount = comments.length - drafts.length;
  const perFile = draftCounts(comments);

  // A row n / p moved to, or a located comment's line (by its key), scrolls into view; its chunk is drawn first.
  const [scrollTo, setScrollTo] = useState<{ row: number } | { key: string } | null>(null);
  useEffect(() => {
    if (!scrollTo) return;
    setScrollTo(null);
    const row = "row" in scrollTo ? scrollTo.row : rows.findIndex((r) => r.key === scrollTo.key);
    if (row < 0 || !scroller.current) return;
    void revealRow(scroller.current, row).then((el) => el?.scrollIntoView({ block: "center" }));
  }, [scrollTo, rows]);

  // j / k (or ↓ / ↑) between files, n / p (or l / ;) between changes, h opens 历史; not while typing or picking.
  useEffect(() => {
    if (inactive || picking) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || el?.closest?.("input, textarea, select, [contenteditable]")) return;
      const k = e.key;
      if (k === "j" || k === "k" || k === "ArrowDown" || k === "ArrowUp") {
        if (!order.length) return;
        e.preventDefault();
        const i = order.findIndex((f) => f.path === selected);
        const next = k === "j" || k === "ArrowDown" ? Math.min(order.length - 1, i + 1) : Math.max(0, i - 1);
        setSelected(order[next]!.path);
      } else if (k === "n" || k === "p" || k === "l" || k === ";") {
        // l / ; sit next to j / k: l on to the next change like j, ; back like k.
        const on = k === "n" || k === "l";
        const to = step(changeRows, active ?? (on ? -1 : rows.length), on ? 1 : -1);
        if (to === null) return;
        e.preventDefault();
        setActive(to);
        setScrollTo({ row: to });
      } else if (k === "h" && (commit || changes?.status.repo)) {
        e.preventDefault();
        setPicking("keys");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, selected, changeRows, active, rows.length, inactive, picking, commit, changes]);

  const status = changes?.status;
  // VS Code opens at the line n / p moved to (or that was clicked), else at the line being commented, else at the top.
  const draftRow = draftAt ? rows.findIndex((r) => r.key === draftAt) : -1;
  const openLine = editorLine(rows, active ?? (draftRow >= 0 ? draftRow : null));
  const closeMenu = useCallback(() => setMenu(null), []);
  // Ctrl+F: the rows' text (hunk headers are not searched).
  const findTexts = useMemo(() => rows.map((r) => (r.kind === "line" ? r.line.text : "")), [rows]);

  return (
    <div className="gr-app">
      <ReviewHead
        workspaceName={workspace.name}
        commit={commit}
        shownCommit={shownCommit}
        status={status}
        range={range}
        mode={mode}
        split={prefs.split}
        onHistory={() => setPicking("search")}
        onRange={setRange}
        onMode={setMode}
        onSplit={setSplit}
        onRefresh={() => {
          cache.clear();
          setReload((n) => n + 1);
        }}
      />

      {status && !status.repo ? (
        <div className="placeholder" data-testid="review-not-git">
          {status.reason ?? "不是 git 仓库"}：{workspace.path} 不在 git 管理之下，没有可以 Review 的改动。
        </div>
      ) : (
        <div className="gr-body">
          <nav className="gr-files" aria-label="改动的文件" style={{ width: prefs.listWidth }}>
            <div className="gr-files-head">
              <span>{listed ? `${listed.files.length} 个文件` : commitError ? "" : "正在读取…"}</span>
              <span className="spacer" />
              <div className="gr-seg small" role="group" aria-label="列表方式">
                {LIST_LAYOUTS.map((l) => (
                  <button key={l.id} type="button" aria-pressed={prefs.layout === l.id} onClick={() => pref("layout", l.id)}>
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="gr-files-hint gr-dim">j / k 切换文件，l / ;（或 n / p）跳到改动，h 历史</div>
            {commitError && (
              <div className="gr-empty" data-testid="review-commit-error">
                读不到这个提交：{commitError}
              </div>
            )}
            {listed && !listed.files.length && <div className="gr-empty">{commit ? "这个提交没有改动这个项目里的文件。" : "这个范围没有改动。"}</div>}
            {listed?.truncated && <div className="gr-empty">改动的文件太多，只列出前 {listed.files.length} 个。</div>}
            {listed && (
              <FileList
                files={listed.files}
                layout={prefs.layout}
                selected={selected}
                perFile={perFile}
                closed={closed}
                onToggle={toggleFolder}
                onSelect={setSelected}
                onHover={readAhead}
                onMenu={(f, x, y) => setMenu({ file: f, x, y })}
              />
            )}
          </nav>
          <Splitter width={prefs.listWidth} onChange={(w) => pref("listWidth", w)} />

          <section className="gr-diff" aria-label="文件改动">
            {file && <FileHead link={link} workspaceId={workspace.id} file={file} vscode={vscode} openLine={openLine} lineChosen={active !== null} onOpen={(app, line) => openFile(file, app, line)} />}
            <div className="gr-scroll-wrap">
              {file && shown && (
                <FindBar
                  active={!inactive}
                  container={scroller}
                  texts={findTexts}
                  rowSelector={(row) => `[data-row="${row}"] .gr-text`} cellSelector=".gr-text"
                  fromRow={() => {
                    const el = scroller.current;
                    const a = el && captureAnchor(el, rows);
                    return a ? Math.max(0, rows.findIndex((r) => r.kind === "line" && r.side === a.side && r.number === a.number)) : 0;
                  }}
                  onCurrent={setActive}
                />
              )}
              {/* With the overview ruler, the ruler is the vertical scrollbar (B2). */}
              <div className={file && shown && rows.length > 0 ? "gr-scroll ruled" : "gr-scroll"} ref={scroller}>
                {!file && listed && <div className="gr-notice">选择左侧的文件查看改动。</div>}
                {file && !shown && <div className="gr-notice gr-loading">正在读取…</div>}
                {file && shown && (
                  <DiffView
                    diff={shown}
                    rows={rows}
                    split={prefs.split}
                    tokens={tokens}
                    placed={placed}
                    elsewhere={elsewhere}
                    showSent={showSent}
                    draftAt={draftAt}
                    active={active}
                    busy={busy}
                    readOnly={!!commit}
                    draftKey={(rowKey) => newDraftKey(workspace.id, file.path, rowKey)}
                    onDraft={setDraftAt}
                    onActivate={setActive}
                    onAdd={(row, note) =>
                      run(async () => {
                        await call(link, "POST /api/workspaces/:id/review-comments", { id: workspace.id }, { range, path: file.path, side: row.side, line: row.number, lineText: row.line.text, note });
                        dropDraft(newDraftKey(workspace.id, file.path, row.key));
                        setDraftAt(null);
                        loadComments();
                      })
                    }
                    onEdit={(id, note) =>
                      run(async () => {
                        await call(link, "PATCH /api/review-comments/:id", { id }, { note });
                        dropDraft(editDraftKey(id));
                        loadComments();
                      })
                    }
                    onDelete={(id) =>
                      run(async () => {
                        await call(link, "DELETE /api/review-comments/:id", { id });
                        dropDraft(editDraftKey(id));
                        loadComments();
                      })
                    }
                    onLocate={(c) => {
                      pref("mode", "full");
                      setScrollTo({ key: `${c.side}:${c.line}` });
                    }}
                  />
                )}
              </div>
              {file && shown && rows.length > 0 && <OverviewRuler scroller={scroller} kinds={rulerKinds} />}
            </div>
          </section>
        </div>
      )}

      {menu && <FileMenu at={menu} vscode={vscode} onOpen={(app) => openFile(menu.file, app)} onClose={closeMenu} />}

      {commit ? (
        <footer className="gr-bar gr-dim" data-testid="review-commit-footer">
          只读：{given ? `对比 ${short(given.sha)} 的改动` : `这个提交的改动，对比它的${shownCommit?.commit.parents.length ? "第一个父提交" : "空仓库"}`}。批注请在工作区改动里写。
        </footer>
      ) : (
        <SendBar link={link} state={state} workspace={workspace} comments={comments} target={target} onTarget={setTarget} busy={busy} run={run}>
          {sentCount > 0 && (
            <label className="gr-check">
              <input type="checkbox" checked={showSent} onChange={(e) => setShowSent(e.target.checked)} />
              显示已发送（{sentCount}）
            </label>
          )}
        </SendBar>
      )}

      {picking && (
        // A commit's window switches to the picked commit (a right click opens a new window); the working tree's
        // window opens each commit in a window of its own.
        <CommitPicker
          link={link}
          workspaceId={workspace.id}
          current={sha ?? commit}
          onPick={(c) => (commit ? switchReview({ workspaceId: workspace.id, commit: c }) : openReview({ workspaceId: workspace.id, commit: c }))}
          {...(commit ? { onPickNew: (c: string) => openReview({ workspaceId: workspace.id, commit: c }) } : {})}
          keys={picking === "keys"}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
