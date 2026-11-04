import { useCallback, useEffect, useState } from "react";
import type { McpProjectState, Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { ChoiceChips, EntryLine, useMcpChanges } from "./shared.js";

/**
 * 编辑项目 → MCP (2026-11-04): which MCP servers this project's sessions get — each follows the global choice (设置 →
 * MCP) unless turned on or off here; the project's own .mcp.json and ~/.claude.json entry are listed too. Saved at once.
 */
export function ProjectMcp({ link, workspace }: { link: HostLink; workspace: Workspace }) {
  const [state, setState] = useState<McpProjectState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    call(link, "GET /api/mcp/projects/:id", { id: workspace.id })
      .then(setState)
      .catch((err: unknown) => setError(err instanceof HostApiError ? err.message : String(err)));
  }, [link, workspace.id]);
  useEffect(reload, [reload]);
  useMcpChanges(reload);

  async function choose(name: string, choice: boolean | null) {
    setBusy(true);
    setError(null);
    try {
      setState(await call(link, "PUT /api/mcp/projects/:id", { id: workspace.id }, { choices: { [name]: choice } }));
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-field" data-testid="edit-project-mcp">
      <span>MCP</span>
      <span className="settings-hint">这个项目的会话用哪些 MCP（全局的在 设置 → MCP）。点了立即保存；正在运行的会话从下一次调用工具或下一条消息起用上。</span>
      <div className="edit-project-mcp mcp-list">
        {!state && !error && <span className="settings-hint">正在读取…</span>}
        {state && state.entries.length === 0 && <span className="settings-hint">没有可用的 MCP。在 设置 → MCP 里添加。</span>}
        {state?.entries.map((e) => (
          <EntryLine key={e.name} entry={e}>
            <ChoiceChips entry={e} aboveLabel="全局" disabled={busy} onChange={(c) => void choose(e.name, c)} />
          </EntryLine>
        ))}
      </div>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
