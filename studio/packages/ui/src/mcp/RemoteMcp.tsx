import { useEffect, useState } from "react";
import { MCP_SOURCE_LABELS, REMOTE_MCP_SINCE, type RemoteMcpEntry, type RemoteMcpList } from "@amo-studio/protocol";
import { HostApiError } from "../host/client.js";
import "./mcp.css";

// 远程选 MCP (2026-11-17, the user: 控制端开任务、开会话时能选被控端的 MCP): the MCP servers of the computer a remote task
// runs on, ticked for the session started there (新会话, 新任务, 分支). They start as that computer would start them; only
// what the person changes here is sent, and that computer takes only names of its own list. Only names, where they come
// from and its notes come over — never a command, an address or a key.

export type RemoteMcpLoad = { list: RemoteMcpList } | { error: string } | null;

/** That computer's list, read again when `key` changes (the model or project picked); `load` null: nothing to read. */
export function useRemoteMcp(load: (() => Promise<RemoteMcpList>) | null, key: string): RemoteMcpLoad {
  const [state, setState] = useState<RemoteMcpLoad>(null);
  useEffect(() => {
    setState(null);
    if (!load) return;
    let live = true;
    load().then(
      (list) => live && setState({ list }),
      (err: unknown) => live && setState({ error: err instanceof HostApiError ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again only when what it is for changes
  }, [key, !!load]);
  return state;
}

/** The choice after a click: back to that computer's own default drops it (nothing to send for it). */
export function toggleMcp(want: Record<string, boolean>, e: RemoteMcpEntry): Record<string, boolean> {
  const on = want[e.name] ?? e.on;
  const next = { ...want };
  if (!on === e.on) delete next[e.name];
  else next[e.name] = !on;
  return next;
}

/**
 * The list to tick. `old`: that computer's Studio is too old to list or take them — greyed, saying what to update to
 * (the session still starts, with that computer's own MCP settings).
 */
export function RemoteMcpPick({ name, state, want, onWant, old, disabled }: { name: string; state: RemoteMcpLoad; want: Record<string, boolean>; onWant(next: Record<string, boolean>): void; old?: boolean; disabled?: boolean }) {
  const on = (e: RemoteMcpEntry) => want[e.name] ?? e.on;
  let body: React.ReactNode;
  if (old) body = <span className="settings-hint">{name} 上的 Studio 要更新到 {REMOTE_MCP_SINCE} 或更新的版本，才能在这里选它的 MCP；现在会话按那台电脑自己的 MCP 设置开。</span>;
  else if (!state) body = <span className="settings-hint">正在读取 {name} 上的 MCP…</span>;
  else if ("error" in state)
    body = (
      <span className="form-error" role="alert">
        读不到 {name} 上的 MCP：{state.error}
      </span>
    );
  else if (!state.list.entries.length) body = <span className="settings-hint">{name} 上没有别的 MCP（Studio 自带的 amo 一直都在）。</span>;
  else
    body = (
      <>
        <div className="rmcp-list" role="group" aria-label={`${name} 上的 MCP`}>
          {state.list.entries.map((e) => (
            <button
              key={e.name}
              type="button"
              className="rmcp-chip"
              aria-pressed={on(e)}
              disabled={disabled || !state.list.perSession}
              title={[`来源：${MCP_SOURCE_LABELS[e.source] ?? e.source}`, e.note, want[e.name] !== undefined ? `在这里${want[e.name] ? "打开" : "关掉"}的（${name} 默认${e.on ? "开" : "关"}）` : null].filter(Boolean).join("\n")}
              onClick={() => onWant(toggleMcp(want, e))}
              data-testid={`remote-mcp-${e.name}`}
            >
              {on(e) ? "✓" : "○"} {e.name}
              {want[e.name] !== undefined && <span className="rmcp-changed"> · 改过</span>}
            </button>
          ))}
        </div>
        <span className="settings-hint">{state.list.perSession ? `默认和 ${name} 上新开的会话一样；点一下改开关，只改这个会话。` : `Codex 的 MCP 在它启动时就定了，不能按会话选：按 ${name} 的全局设置。`}</span>
      </>
    );
  return (
    <div className={`rmcp${old ? " rmcp-old" : ""}`} data-testid="remote-mcp">
      {body}
    </div>
  );
}
