import { useState } from "react";
import type { RemoteTaskRequest } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { relativeTime } from "../lib/status.js";

/**
 * 远程 step 4 (2026-10-29): another of the person's computers asks this one to run a task — something to deal with, as a
 * pairing request is. Allowing needs a project and a model picked, so 「去处理」 opens the remote page; 拒绝 is right here.
 */
export function FocusTaskRequest({ link, request }: { link: HostLink; request: RemoteTaskRequest }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function refuse() {
    setBusy(true);
    setError(null);
    try {
      await call(link, "POST /api/remote/task-requests/:id/refuse", { id: request.id }, {});
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  }
  return (
    <div className="focus-entry open" data-testid="focus-task-request">
      <div className="focus-row static">
        <span className="dot" style={{ background: "var(--attention)" }} />
        <span className="focus-row-text">
          <span className="focus-title">任务请求 · {request.name}</span>
          <span className="focus-sub">
            请这台电脑跑「{request.title}」· {relativeTime(request.createdAt)}
          </span>
        </span>
      </div>
      <div className="focus-detail">
        <span className="focus-sub focus-wrap">同意时选项目、专题和模型（只能选远端允许的模型），这台电脑建任务开跑，并授权给 {request.name}。</span>
        {error && <span className="focus-error">{error}</span>}
        <div className="focus-actions">
          <button type="button" className="focus-approve" onClick={() => void window.amo?.openInWorkbench?.({ settings: "remote" })} data-testid="focus-task-request-open">
            去处理
          </button>
          <button type="button" className="focus-btn" disabled={busy} onClick={() => void refuse()} data-testid="focus-task-request-refuse">
            拒绝
          </button>
        </div>
      </div>
    </div>
  );
}
