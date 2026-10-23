import { useEffect, useState } from "react";
import type { GitExcludeState, Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

/**
 * 一键忽略 .amo/ (2026-10-23): the project's `.amo/` (extension packs) left out of git by one line in the repository's
 * `.git/info/exclude`, which stays on this machine; the project's .gitignore is not touched. Shown in 编辑项目 and on
 * the 扩展包 page; nothing when the folder is not in git (`quietWhenDone` also hides it once git ignores `.amo/`).
 */
export function GitExcludeRow({ link, workspace, quietWhenDone = false }: { link: HostLink; workspace: Workspace; quietWhenDone?: boolean }) {
  const [state, setState] = useState<GitExcludeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    call(link, "GET /api/workspaces/:id/git-exclude", { id: workspace.id })
      .then((s) => live && setState(s))
      .catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, [link, workspace.id]);

  async function add() {
    setBusy(true);
    setError("");
    try {
      setState(await call(link, "POST /api/workspaces/:id/git-exclude", { id: workspace.id }));
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!state?.git || (quietWhenDone && state.excluded && !state.tracked)) return null;
  return (
    <div className="git-exclude" data-testid="git-exclude">
      {state.excluded ? (
        <span className="settings-hint" data-testid="git-exclude-done">
          git 已忽略 <code>.amo/</code>（{state.source}）
        </span>
      ) : (
        <div className="git-exclude-row">
          <span className="settings-hint">
            git 还没忽略 <code>.amo/</code>（扩展包）。一键忽略会在本机的 <code>.git/info/exclude</code> 加一行 <code>{state.entry}</code>，不改项目的 .gitignore。
          </span>
          <button type="button" className="btn-ghost small" onClick={() => void add()} disabled={busy} data-testid="git-exclude-add">
            一键忽略
          </button>
        </div>
      )}
      {state.tracked > 0 && <span className="settings-hint">.amo/ 下已有 {state.tracked} 个文件被 git 跟踪，忽略对它们不起作用。</span>}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
