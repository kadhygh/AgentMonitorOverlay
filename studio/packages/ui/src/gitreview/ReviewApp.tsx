import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { composeGitReviewMessage, GIT_RANGES, type GitChangedFile, type GitChanges, type GitFileDiff, type GitRange, type GitReviewComment, type StateSnapshot, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useHostState } from "../host/useHostState.js";
import { highlightLines, languageForPath, useGrammarLoads } from "../lib/highlight.js";
import { openInApps, openInEditor, revealInExplorer } from "../lib/openin.js";
import { DiffView } from "./DiffView.js";
import { FileList, FileMenu, Splitter, type FileMenuAt } from "./FileList.js";
import { ancestors, fileOrder, readPrefs, writePrefs, type ListLayout, type ReviewPrefs } from "./filetree.js";
import { changeStarts, countLabel, diffRows, draftCounts, parseReviewHash, placeComments, sessionChoices, STATUS_NAME, step, type DiffMode, type ReviewTarget } from "./logic.js";
import { diffTokens, editorLine } from "./splitview.js";

// The Git Review window (#review?workspace=…&session=…): a project's changed files on the left, one file's diff on
// the right, comments on lines, and "发给会话" to send the drafts to a session as one message.

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
  return <ReviewPage key={ws.id} link={host.link} state={host.state} workspace={ws} sessionId={target.sessionId ?? null} />;
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

function ReviewPage({ link, state, workspace, sessionId }: { link: HostLink; state: StateSnapshot; workspace: Workspace; sessionId: string | null }) {
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
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [comments, setComments] = useState<readonly GitReviewComment[]>([]);
  const [target, setTarget] = useState<string>(sessionId ?? "");
  const [showSent, setShowSent] = useState(false);
  const [draftAt, setDraftAt] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast>(null);

  useEffect(() => setTarget(sessionId ?? ""), [sessionId]);
  useEffect(() => {
    document.title = `Git Review · ${workspace.name}`;
  }, [workspace.name]);

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
  }, [link, workspace.id, range, reload]);

  const file = changes?.files.find((f) => f.path === selected) ?? null;
  const fileKey = file ? `${file.oldPath ?? ""}>${file.path}` : "";
  // Another file or range: start over. A refresh keeps the page (and a comment being written) until the new diff arrives.
  useEffect(() => {
    setDraftAt(null);
    setActive(null);
  }, [fileKey, range]);
  useEffect(() => {
    if (!file) {
      setDiff(null);
      return;
    }
    let live = true;
    call(link, "GET /api/workspaces/:id/git/diff", { id: workspace.id }, undefined, { range, path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}) })
      .then((d) => live && setDiff(d))
      .catch((err: unknown) => live && fail(err));
    return () => {
      live = false;
    };
    // The file object changes on every reload; its identity is its path and old path.
  }, [link, workspace.id, range, fileKey, reload]);

  const loadComments = useCallback(
    () =>
      call(link, "GET /api/workspaces/:id/review-comments", { id: workspace.id })
        .then(setComments)
        .catch(fail),
    [link, workspace.id],
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
  const shown = diff && file && diff.path === file.path && diff.range === range ? diff : null;
  const rows = useMemo(() => (shown ? diffRows(shown, mode) : []), [shown, mode]);
  const changeRows = useMemo(() => changeStarts(rows), [rows]);
  const { placed, elsewhere } = useMemo(() => placeComments(comments, selected ?? "", range, rows), [comments, selected, range, rows]);
  const order = useMemo(() => fileOrder(changes?.files ?? [], prefs.layout), [changes, prefs.layout]);
  // Syntax colours of both versions, worked out once per file (and again when its grammar finishes loading).
  const grammarLoads = useGrammarLoads();
  const lang = shown ? languageForPath(shown.path) : null;
  const tokens = useMemo(() => (shown && lang ? diffTokens(shown.lines, (code) => highlightLines(code, lang)) : null), [shown, lang, grammarLoads]);
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
        <span className="gr-title">Git Review</span>
        <span className="gr-project">{workspace.name}</span>
        {status?.repo && (
          <span className="gr-branch" data-testid="review-branch" title={status.root}>
            {status.branch ?? `分离的 HEAD ${short(status.head)}`}
            {range === "branch" && (status.base ? ` · 对比 ${status.base}（基点 ${short(status.mergeBase)}）` : " · 没有找到默认分支，同工作区改动")}
          </span>
        )}
        <span className="spacer" />
        <div className="gr-seg" role="group" aria-label="对比范围">
          {GIT_RANGES.map((r) => (
            <button key={r.id} type="button" aria-pressed={range === r.id} title={r.hint} onClick={() => setRange(r.id)}>
              {r.label}
            </button>
          ))}
        </div>
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
        <button type="button" className="btn-ghost small" onClick={() => setReload((n) => n + 1)} title="重新读取改动">
          刷新
        </button>
      </header>

      {toast && (
        <div role="status" className={toast.error ? "toast toast-error" : "toast"} data-testid="toast">
          <span>{toast.text}</span>
          <button type="button" className="toast-close" aria-label="关闭提示" onClick={() => setToast(null)}>
            ×
          </button>
        </div>
      )}

      {status && !status.repo ? (
        <div className="placeholder" data-testid="review-not-git">
          {status.reason ?? "不是 git 仓库"}：{workspace.path} 不在 git 管理之下，没有可以 Review 的改动。
        </div>
      ) : (
        <div className="gr-body">
          <nav className="gr-files" aria-label="改动的文件" style={{ width: prefs.listWidth }}>
            <div className="gr-files-head">
              <span>{changes ? `${changes.files.length} 个文件` : "正在读取…"}</span>
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
            {changes && !changes.files.length && <div className="gr-empty">这个范围没有改动。</div>}
            {changes?.truncated && <div className="gr-empty">改动的文件太多，只列出前 {changes.files.length} 个。</div>}
            {changes && (
              <FileList
                files={changes.files}
                layout={prefs.layout}
                selected={selected}
                perFile={perFile}
                closed={closed}
                onToggle={toggleFolder}
                onSelect={setSelected}
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
              </div>
            )}
            <div className="gr-scroll">
              {!file && changes && <div className="gr-notice">选择左侧的文件查看改动。</div>}
              {file && !shown && <div className="gr-notice">正在读取…</div>}
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
          </section>
        </div>
      )}

      {menu && <FileMenu at={menu} vscode={vscode} onOpen={(app) => openFile(menu.file, app)} onClose={closeMenu} />}

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
    </div>
  );
}
