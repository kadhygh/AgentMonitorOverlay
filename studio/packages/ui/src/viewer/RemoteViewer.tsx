import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { RemoteFetchedFile, StateSnapshot } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent } from "../host/events.js";
import { formatBytes } from "../attach/refs.js";
import { fileName } from "../files/paths.js";
import type { ViewerTarget } from "./logic.js";

// 远程 step 3 (2026-10-29, plans/remote-session.md): a remote task's file in the viewer. It is on the computer the task
// runs on, so this Host fetches it first (through the team server) and keeps it in this computer's data folder; the
// viewer says 「正在从 <设备> 取文件…」 with how far it came, as 正在启动 does for a session, then shows the copy as it shows
// any file. Fetching fails with the reason (that computer away, too big, not a kind remote viewing takes, not in the
// task's folder); a copy fetched before is shown while that computer is away, saying so.

/** What the page shows a fetched remote file with. */
export interface RemoteShown {
  taskId: string;
  rel: string;
  key: string;
  device: string;
  /** Why this is the copy from last time (that computer away, the grant gone). */
  stale?: string;
  /** Fetch it again (重新载入). */
  reload(): void;
}

type Fetching = { kind: "loading"; received: number; total: number } | { kind: "ok"; file: RemoteFetchedFile } | { kind: "error"; message: string };

let fetches = 0;

export function RemoteViewer({ link, state, target, render }: { link: HostLink; state: StateSnapshot; target: ViewerTarget; render(target: ViewerTarget, remote: RemoteShown): ReactNode }) {
  const taskId = target.remote!;
  const task = state.tasks.find((t) => t.id === taskId);
  const device = task?.remote?.name ?? "运行任务的电脑";
  const [again, setAgain] = useState(0);
  const [st, setSt] = useState<Fetching>({ kind: "loading", received: 0, total: 0 });

  useEffect(() => {
    let live = true;
    const fetchId = `vf-${Date.now()}-${++fetches}`;
    setSt({ kind: "loading", received: 0, total: 0 });
    const off = onHostEvent((e) => {
      if (live && e.type === "remote.file" && e.fetchId === fetchId) setSt((s) => (s.kind === "loading" ? { kind: "loading", received: e.received, total: e.total } : s));
    });
    call(link, "POST /api/remote/files", {}, { taskId, path: target.path, ...(target.cwd ? { cwd: target.cwd } : {}), fetchId })
      .then((file) => live && setSt({ kind: "ok", file }))
      .catch((err: unknown) => live && setSt({ kind: "error", message: err instanceof HostApiError ? err.message : String(err) }));
    return () => {
      live = false;
      off();
    };
  }, [link, taskId, target.path, target.cwd, target.nonce, again]);

  useEffect(() => {
    if (st.kind !== "ok") document.title = `${fileName(target.path)} · 查看器`;
  }, [st.kind, target.path]);

  const shown = useMemo<RemoteShown | null>(
    () => (st.kind === "ok" ? { taskId, rel: st.file.rel, key: st.file.key, device: st.file.device, ...(st.file.stale ? { stale: st.file.stale } : {}), reload: () => setAgain((n) => n + 1) } : null),
    [st, taskId],
  );
  const local = useMemo<ViewerTarget | null>(
    () => (st.kind === "ok" ? { path: st.file.path, ...(target.line ? { line: target.line, ...(target.endLine ? { endLine: target.endLine } : {}) } : {}), ...(target.sessionId ? { sessionId: target.sessionId } : {}), nonce: `${target.nonce ?? ""}:${again}` } : null),
    [st, target.line, target.endLine, target.sessionId, target.nonce, again],
  );

  if (st.kind === "ok" && shown && local) return <>{render(local, shown)}</>;
  const pct = st.kind === "loading" && st.total > 0 ? Math.min(100, Math.round((st.received / st.total) * 100)) : null;
  return (
    <div className="vw-app vw-remote" data-testid="viewer" data-remote-state={st.kind}>
      <div className="vw-remote-box" role={st.kind === "error" ? "alert" : "status"} aria-live="polite" data-testid="viewer-remote">
        <span className="vw-remote-name">{fileName(target.path)}</span>
        {st.kind === "loading" ? (
          <>
            <span className="starting-spin" aria-hidden="true" />
            <span className="starting-label" data-testid="viewer-remote-loading">
              正在从 {device} 取文件…
            </span>
            <div className="vw-remote-bar" aria-hidden="true">
              <span style={{ width: `${pct ?? 0}%` }} className={pct === null ? "unknown" : undefined} />
            </div>
            <span className="vw-remote-amount" data-testid="viewer-remote-progress">
              {st.total > 0 ? `${formatBytes(st.received)} / ${formatBytes(st.total)}` : "等对方回应…"}
            </span>
          </>
        ) : (
          <>
            <span className="vw-remote-fail">取不到这个文件</span>
            <span className="vw-remote-why" data-testid="viewer-remote-error">
              {st.kind === "error" ? st.message : ""}
            </span>
            <button type="button" className="btn-ghost small" onClick={() => setAgain((n) => n + 1)} data-testid="viewer-remote-retry">
              再试一次
            </button>
          </>
        )}
      </div>
    </div>
  );
}
