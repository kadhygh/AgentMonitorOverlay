import { useCallback, useEffect, useMemo, useState } from "react";
import { composeGitReviewMessage, GIT_RANGES, type GitChanges, type GitFileDiff, type GitRange, type GitReviewComment, type StateSnapshot, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useHostState } from "../host/useHostState.js";
import { DiffView } from "./DiffView.js";
import { changeStarts, countLabel, diffRows, draftCounts, groupByFolder, listOrder, parseReviewHash, placeComments, sessionChoices, STATUS_LETTER, STATUS_NAME, step, type DiffMode, type ReviewTarget } from "./logic.js";

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

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "");

function ReviewPage({ link, state, workspace, sessionId }: { link: HostLink; state: StateSnapshot; workspace: Workspace; sessionId: string | null }) {
  const [range, setRange] = useState<GitRange>("working");
  const [mode, setMode] = useState<DiffMode>("changes");
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

  const fail = (err: unknown) => setToast({ text: err instanceof HostApiError ? err.message : String(err), error: true });

  // The changed files of the range; the selection stays on its file when it is still changed.
  useEffect(() => {
    let live = true;
    call(link, "GET /api/workspaces/:id/git/changes", { id: workspace.id }, undefined, { range })
      .then((c) => {
        if (!live) return;
        setChanges(c);
        setSelected((cur) => (cur && c.files.some((f) => f.path === cur) ? cur : (listOrder(c.files)[0]?.path ?? null)));
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
  const order = useMemo(() => listOrder(changes?.files ?? []), [changes]);
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
          <nav className="gr-files" aria-label="改动的文件">
            <div className="gr-files-head">
              {changes ? `${changes.files.length} 个文件` : "正在读取…"}
              <span className="gr-dim"> · j / k 切换文件，n / p 跳到改动</span>
            </div>
            {changes && !changes.files.length && <div className="gr-empty">这个范围没有改动。</div>}
            {changes?.truncated && <div className="gr-empty">改动的文件太多，只列出前 {changes.files.length} 个。</div>}
            {groupByFolder(changes?.files ?? []).map((g) => (
              <div key={g.folder} className="gr-group">
                {g.folder && <div className="gr-folder">{g.folder}/</div>}
                {g.files.map(({ file: f, name }) => (
                  <button
                    key={f.path}
                    type="button"
                    className="gr-file"
                    aria-current={f.path === selected}
                    onClick={() => setSelected(f.path)}
                    title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                    data-testid="review-file"
                  >
                    <span className={`gr-status ${f.status}${f.untracked ? " untracked" : ""}`} title={f.untracked ? "未跟踪的新文件" : STATUS_NAME[f.status]}>
                      {STATUS_LETTER[f.status]}
                    </span>
                    <span className="gr-name">{name}</span>
                    {perFile.get(f.path) ? <span className="gr-badge">{perFile.get(f.path)}</span> : null}
                    <span className="gr-count">
                      {f.binary ? (
                        "二进制"
                      ) : (
                        <>
                          <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
                        </>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <section className="gr-diff" aria-label="文件改动">
            {file && (
              <div className="gr-file-head" data-testid="review-file-head">
                <span className="gr-path">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
                <span className="gr-dim">{file.untracked ? "未跟踪的新文件" : STATUS_NAME[file.status]}</span>
                <span className="spacer" />
                <span className="gr-dim">{countLabel(file)}</span>
              </div>
            )}
            <div className="gr-scroll">
              {!file && changes && <div className="gr-notice">选择左侧的文件查看改动。</div>}
              {file && !shown && <div className="gr-notice">正在读取…</div>}
              {file && shown && (
                <DiffView
                  diff={shown}
                  rows={rows}
                  placed={placed}
                  elsewhere={elsewhere}
                  showSent={showSent}
                  draftAt={draftAt}
                  active={active}
                  busy={busy}
                  onDraft={setDraftAt}
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
