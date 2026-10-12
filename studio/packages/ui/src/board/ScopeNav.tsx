import { useState } from "react";
import type { Task, Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import type { Scope } from "./Board.js";

interface ScopeNavProps {
  link: HostLink;
  workspaces: readonly Workspace[];
  tasks: readonly Task[];
  scope: Scope;
  live: boolean;
  onScope(scope: Scope): void;
}

const isCurrent = (a: Scope, b: Scope) => a.kind === b.kind && (a.kind !== "workspace" || (b.kind === "workspace" && a.id === b.id));

/** Left column: scope (all, cross-workspace, each workspace) and registering a workspace. */
export function ScopeNav({ link, workspaces, tasks, scope, live, onScope }: ScopeNavProps) {
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const row = (target: Scope, name: string, count: number, testId: string) => (
    <button type="button" className="nav-row" aria-current={isCurrent(scope, target)} onClick={() => onScope(target)} data-testid={testId}>
      <span className="name">{name}</span>
      <span className="count">{count}</span>
    </button>
  );

  async function register(dir: string) {
    if (!dir.trim()) return;
    setBusy(true);
    setError("");
    try {
      const ws = await call(link, "POST /api/workspaces", {}, { path: dir.trim() });
      setPath("");
      setAdding(false);
      onScope({ kind: "workspace", id: ws.id });
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function pick() {
    const dir = await window.amo?.pickDirectory?.();
    if (dir) await register(dir);
  }

  return (
    <nav className="scope-nav" aria-label="范围">
      <div className="nav-label">范围</div>
      {row({ kind: "all" }, "全部", tasks.length, "scope-all")}
      {row({ kind: "area" }, "跨工作区", tasks.filter((t) => t.scope.kind === "area").length, "scope-area")}
      <div className="nav-label nav-section">工作区</div>
      {workspaces.map((w) => (
        <div key={w.id} title={w.path}>
          {row({ kind: "workspace", id: w.id }, w.name, tasks.filter((t) => t.scope.kind === "workspace" && t.scope.workspaceId === w.id).length, `scope-ws-${w.name}`)}
        </div>
      ))}
      <div className="add-ws">
        {!adding ? (
          <button type="button" className="add-ws-toggle" onClick={() => setAdding(true)}>
            + 登记工作区
          </button>
        ) : (
          <form
            className="add-ws"
            onSubmit={(e) => {
              e.preventDefault();
              void register(path);
            }}
          >
            {window.amo?.pickDirectory && (
              <button type="button" className="btn-ghost" onClick={() => void pick()} disabled={busy}>
                选择文件夹…
              </button>
            )}
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--text-dim)" }}>
              或输入路径
              <input className="field" value={path} onChange={(e) => setPath(e.target.value)} placeholder="D:\\Projects\\MyGame" aria-label="工作区路径" />
            </label>
            {error && <span className="form-error" role="alert">{error}</span>}
            <div className="add-ws-actions">
              <button type="submit" className="btn-primary" disabled={busy || !path.trim()}>
                登记
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  setAdding(false);
                  setError("");
                }}
              >
                取消
              </button>
            </div>
          </form>
        )}
      </div>
      <div className="nav-footer" data-testid="host-status">
        {live ? "Host 运行中" : "Host 重新连接中…"}
      </div>
    </nav>
  );
}
