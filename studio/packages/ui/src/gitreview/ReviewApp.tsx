import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { showToast } from "../lib/toast.js";
import {
  composeGitReviewMessage,
  GIT_RANGES,
  rangeBase,
  type GitChangedFile,
  type GitChanges,
  type GitCommitChanges,
  type GitFileDiff,
  type GitRange,
  type GitReviewComment,
  type StateSnapshot,
  type Workspace,
} from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useHostState } from "../host/useHostState.js";
import { openInApps, openInEditor, revealInExplorer } from "../lib/openin.js";
import { DiffView } from "./DiffView.js";
import { FileList, FileMenu, Splitter, type FileMenuAt } from "./FileList.js";
import { ancestors, fileOrder, readPrefs, writePrefs, type ListLayout, type ReviewPrefs } from "./filetree.js";
import { changeStarts, countLabel, diffRows, draftCounts, parseReviewHash, placeComments, sessionChoices, STATUS_NAME, step, type DiffMode, type ReviewTarget } from "./logic.js";
import { editorLine } from "./splitview.js";
import { DiffCache, type DiffRequest } from "./diffcache.js";
import { diffTokensFor, useDiffTokens } from "./tokens.js";
import { MarkButton } from "../marks/MarkButton.js";
import { OverviewRuler } from "./OverviewRuler.js";
import { pairKinds, rowKinds } from "./overview.js";
import { splitRows } from "./splitview.js";
import { CommitPicker } from "./CommitPicker.js";
import { openReview } from "./open.js";
import { formatWhen } from "../attach/refs.js";

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
  return <ReviewPage key={`${ws.id}@${target.commit ?? ""}`} link={host.link} state={host.state} workspace={ws} sessionId={target.sessionId ?? null} commit={target.commit ?? null} />;
}

type Toast = { text: string; error?: boolean } | null;

const MODES: { id: DiffMode; label: string }[] = [
  { id: "changes", label: "只看改动" },
  { id: "full", label: "完整文件" },
];

const LAYOUTS: { split: boolean; label: string; hint: string }[] = [
  { split: false, label: "单栏", hint: "新旧行上下排在一栏里" },
  { split: true, label: "左右对照", hint: "左边旧版，右边新版，两边一起滚动" },
];

const LIST_LAYOUTS: { id: ListLayout; label: string }[] = [
  { id: "tree", label: "目录树" },
  { id: "flat", label: "平铺" },
];

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "");

function ReviewPage({ link, state, workspace, sessionId, commit }: { link: HostLink; state: StateSnapshot; workspace: Workspace; sessionId: string | null; commit: string | null }) {
  const [range, setRange] = useState<GitRange>("working");
  // The view choices (list width and layout, 单栏 / 左右对照, 只看改动 / 完整文件) stay on this machine.
  const [prefs, setPrefs] = useState<ReviewPrefs>(readPrefs);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  useEffect(() => writePrefs(prefs), [prefs]);
  const pref = useCallback(<K extends keyof ReviewPrefs>(key: K, value: ReviewPrefs[K]) => setPrefs((p) => ({ ...p, [key]: value })), []);
  const mode = prefs.mode;
  const setMode = (m: DiffMode) => pref("mode", m);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const [menu, setMenu] = useState<FileMenuAt | null>(null);
  const [vscode, setVscode] = useState(false);
  const [changes, setChanges] = useState<GitChanges | null>(null);
  // A commit's window: the commit and its files (`changes` stays empty).
  const [shownCommit, setShownCommit] = useState<GitCommitChanges | null>(null);
  const [picking, setPicking] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [comments, setComments] = useState<readonly GitReviewComment[]>([]);
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
    const c = shownCommit?.commit;
    document.title = commit ? `提交 ${short(c?.sha ?? commit)}${c ? ` · ${c.subject}` : ""} · ${workspace.name}` : `Git Review · ${workspace.name}`;
  }, [workspace.name, commit, shownCommit]);

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
    call(link, "GET /api/workspaces/:id/git/changes", { id: workspace.id }, undefined, { range })
      .then((c) => {
        if (!live) return;
        setChanges(c);
        setSelected((cur) => (cur && c.files.some((f) => f.path === cur) ? cur : (fileOrder(c.files, prefsRef.current.layout)[0]?.path ?? null)));
      })
      .catch((err: unknown) => live && fail(err));
    return () => {
      live = false;
    };
  }, [link, workspace.id, range, reload, commit]);
  // A commit's files, once: a commit does not change.
  useEffect(() => {
    if (!commit) return;
    let live = true;
    call(link, "GET /api/workspaces/:id/git/commit", { id: workspace.id }, undefined, { sha: commit })
      .then((c) => {
        if (!live) return;
        setShownCommit(c);
        setSelected(fileOrder(c.files, prefsRef.current.layout)[0]?.path ?? null);
      })
      .catch((err: unknown) => live && setCommitError(err instanceof HostApiError ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [link, workspace.id, commit]);

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

  // A commit's window is read-only: no comments there.
  const loadComments = useCallback(
    () =>
      commit
        ? Promise.resolve()
        : call(link, "GET /api/workspaces/:id/review-comments", { id: workspace.id })
            .then(setComments)
            .catch(fail),
    [link, workspace.id, commit],
  );
  useEffect(() => void loadComments(), [loadComments]);

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
  const scroller = useRef<HTMLDivElement>(null);
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
  const choices = sessionChoices(state, workspace.id);
  // The session named by the window's address only counts while it is a live session of this project.
  const chosen = choices.some((c) => c.id === target) ? target : "";
  const targetLabel = choices.find((c) => c.id === chosen)?.label ?? "";

  // A row n / p moved to, or a located comment, scrolls into view once drawn.
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  useEffect(() => {
    if (!scrollTo) return;
    document.querySelector(scrollTo)?.scrollIntoView({ block: "center" });
    setScrollTo(null);
  }, [scrollTo, rows]);

  // j / k (or ↓ / ↑) between files, n / p between changes; not while typing.
  useEffect(() => {
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
      } else if (k === "n" || k === "p") {
        const to = step(changeRows, active ?? (k === "n" ? -1 : rows.length), k === "n" ? 1 : -1);
        if (to === null) return;
        e.preventDefault();
        setActive(to);
        setScrollTo(`[data-row="${to}"]`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [order, selected, changeRows, active, rows.length]);

  const status = changes?.status;
  // VS Code opens at the line n / p moved to (or that was clicked), else at the line being commented, else at the top.
  const draftRow = draftAt ? rows.findIndex((r) => r.key === draftAt) : -1;
  const openLine = editorLine(rows, active ?? (draftRow >= 0 ? draftRow : null));
  const closeMenu = useCallback(() => setMenu(null), []);
  const send = () =>
    run(async () => {
      const r = await call(link, "POST /api/workspaces/:id/review-comments/send", { id: workspace.id }, { sessionId: chosen });
      setToast({ text: `已把 ${r.sent.length} 条批注发给「${targetLabel}」。` });
      await loadComments();
    });

  return (
    <div className="gr-app">
      <header className="gr-head">
        <span className="gr-title">{commit ? "提交" : "Git Review"}</span>
        <span className="gr-project">{workspace.name}</span>
        {commit && (
          <span className="gr-commit" data-testid="review-commit" title={shownCommit ? `${shownCommit.commit.sha}\n${shownCommit.commit.author} <${shownCommit.commit.email}>` : commit}>
            <code>{short(shownCommit?.commit.sha ?? commit)}</code>
            {shownCommit && (
              <>
                <span className="gr-commit-subject">{shownCommit.commit.subject}</span>
                <span className="gr-dim">
                  {shownCommit.commit.author} · {formatWhen(shownCommit.commit.date)}
                  {shownCommit.commit.parents.length > 1 ? " · 合并提交，对比第一个父提交" : shownCommit.commit.parents.length === 0 ? " · 第一个提交" : ""}
                </span>
              </>
            )}
          </span>
        )}
        {status?.repo && (
          <span className="gr-branch" data-testid="review-branch" title={status.root}>
            {status.branch ?? `分离的 HEAD ${short(status.head)}`}
            {range === "branch" && (status.base ? ` · 对比 ${status.base}（基点 ${short(status.mergeBase)}）` : " · 没有找到默认分支，同工作区改动")}
          </span>
        )}
        <span className="spacer" />
        {(commit || status?.repo) && (
          <button type="button" className="btn-ghost small" onClick={() => setPicking(true)} title="这个分支的提交：搜索说明、hash 或作者，在新窗口查看" data-testid="review-history">
            历史
          </button>
        )}
        {!commit && (
          <div className="gr-seg" role="group" aria-label="对比范围">
            {GIT_RANGES.map((r) => (
              <button key={r.id} type="button" aria-pressed={range === r.id} title={r.hint} onClick={() => setRange(r.id)}>
                {r.label}
              </button>
            ))}
          </div>
        )}
        <div className="gr-seg" role="group" aria-label="显示方式">
          {MODES.map((m) => (
            <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <div className="gr-seg" role="group" aria-label="版式">
          {LAYOUTS.map((l) => (
            <button key={l.label} type="button" aria-pressed={prefs.split === l.split} title={l.hint} onClick={() => pref("split", l.split)}>
              {l.label}
            </button>
          ))}
        </div>
        {!commit && (
          <button
            type="button"
            className="btn-ghost small"
            onClick={() => {
              cache.clear();
              setReload((n) => n + 1);
            }}
            title="重新读取改动"
          >
            刷新
          </button>
        )}
      </header>

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
            <div className="gr-files-hint gr-dim">j / k 切换文件，n / p 跳到改动</div>
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
            {file && (
              <div className="gr-file-head" data-testid="review-file-head">
                <span className="gr-path">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
                <span className="gr-dim">{file.untracked ? "未跟踪的新文件" : STATUS_NAME[file.status]}</span>
                <span className="spacer" />
                <span className="gr-dim">{countLabel(file)}</span>
                {vscode && (
                  <button
                    type="button"
                    className="btn-ghost small"
                    disabled={file.status === "deleted"}
                    title={file.status === "deleted" ? "文件已删除" : `在 VS Code 里打开到第 ${openLine} 行`}
                    onClick={() => openFile(file, "vscode", openLine)}
                    data-testid="review-open-vscode"
                  >
                    VS Code 打开
                  </button>
                )}
                <button
                  type="button"
                  className="btn-ghost small"
                  disabled={file.status === "deleted"}
                  title={file.status === "deleted" ? "文件已删除" : "在资源管理器里选中这个文件"}
                  onClick={() => openFile(file, "explorer")}
                  data-testid="review-reveal"
                >
                  在资源管理器中显示
                </button>
                {file.status !== "deleted" && <MarkButton link={link} file={{ path: file.path, workspaceId: workspace.id }} line={active !== null ? openLine : null} />}
              </div>
            )}
            <div className="gr-scroll-wrap">
              <div className="gr-scroll" ref={scroller}>
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
                    onDraft={setDraftAt}
                    onActivate={setActive}
                    onAdd={(row, note) =>
                      run(async () => {
                        await call(link, "POST /api/workspaces/:id/review-comments", { id: workspace.id }, { range, path: file.path, side: row.side, line: row.number, lineText: row.line.text, note });
                        setDraftAt(null);
                        await loadComments();
                      })
                    }
                    onEdit={(id, note) => run(async () => (await call(link, "PATCH /api/review-comments/:id", { id }, { note }), await loadComments()))}
                    onDelete={(id) => run(async () => (await call(link, "DELETE /api/review-comments/:id", { id }), await loadComments()))}
                    onLocate={(c) => {
                      setMode("full");
                      setScrollTo(`[data-line="${c.side}:${c.line}"]`);
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
        <footer className="gr-bar gr-dim">只读：这个提交的改动，对比它的{shownCommit?.commit.parents.length ? "第一个父提交" : "空仓库"}。批注请在工作区改动里写。</footer>
      ) : (
        <footer className="gr-bar">
          <span data-testid="review-draft-count">草稿批注 {drafts.length} 条</span>
          {sentCount > 0 && (
            <label className="gr-check">
              <input type="checkbox" checked={showSent} onChange={(e) => setShowSent(e.target.checked)} />
              显示已发送（{sentCount}）
            </label>
          )}
          <span className="spacer" />
          <label className="inline-field">
            发给
            <select value={chosen} onChange={(e) => setTarget(e.target.value)} data-testid="review-session" aria-label="发给哪个会话">
              <option value="">选择会话…</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !drafts.length || !chosen}
            title={drafts.length ? composeGitReviewMessage(drafts, workspace.name) : "还没有草稿批注"}
            onClick={() => void send()}
            data-testid="review-send"
          >
            发给会话{drafts.length ? `（${drafts.length}）` : ""}
          </button>
        </footer>
      )}

      {picking && <CommitPicker link={link} workspaceId={workspace.id} onPick={(c) => openReview({ workspaceId: workspace.id, commit: c })} onClose={() => setPicking(false)} />}
    </div>
  );
}
