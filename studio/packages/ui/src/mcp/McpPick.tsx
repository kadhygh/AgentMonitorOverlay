import { useEffect, useState } from "react";
import { MCP_SOURCE_LABELS, REMOTE_MCP_SINCE, type McpOffer, type McpOfferEntry } from "@amo-studio/protocol";
import { HostApiError } from "../host/client.js";
import "./mcp.css";

// 选 MCP (2026-11-17): one picker for every place a session is set up — 新任务, 新会话, 分支, here or on another computer
// (远程选 MCP, the user: 控制端开任务、开会话时能选被控端的 MCP; 新会话 dialog, the user: 这感觉 amo 内几处可以尽量统一逻辑).
// The list (McpOffer) is the same wherever it comes from: names, where they come from, notes, whether they are on —
// never a command, address or key. Only what the person changes here is sent; the Host takes only names of its list.

export type McpOfferLoad = { list: McpOffer } | { error: string } | null;

/** The list, read again when `key` changes (the model or project picked); `load` null: nothing to read. */
export function useMcpOffer(load: (() => Promise<McpOffer>) | null, key: string): McpOfferLoad {
  const [state, setState] = useState<McpOfferLoad>(null);
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

/** The choice after a click: back to the list's own default drops it (nothing to send for it). */
export function toggleMcp(want: Record<string, boolean>, e: McpOfferEntry): Record<string, boolean> {
  const on = want[e.name] ?? e.on;
  const next = { ...want };
  if (!on === e.on) delete next[e.name];
  else next[e.name] = !on;
  return next;
}

/**
 * What goes with the session: the changes of names the list (as read now) has, when it takes choices — a project or
 * model picked since leaves the others behind. Undefined: nothing to send.
 */
export function mcpToSend(state: McpOfferLoad, want: Record<string, boolean>): Record<string, boolean> | undefined {
  if (!state || "error" in state || !state.list.perSession || state.list.locked) return undefined;
  const names = new Set(state.list.entries.map((e) => e.name));
  const out = Object.fromEntries(Object.entries(want).filter(([n]) => names.has(n)));
  return Object.keys(out).length ? out : undefined;
}

/**
 * The list to tick. `where`: another computer's (its name) — the texts say so. `old`: that computer's Studio is too old
 * to list or take them — greyed, saying what to update to (the session still starts, with that computer's own MCP).
 * `locked` (from the list): that computer's 远程设置 does not let devices pick — shown, greyed, saying why.
 */
export function McpPick({ where, state, want, onWant, old, disabled, testId = "mcp-pick" }: { where?: string; state: McpOfferLoad; want: Record<string, boolean>; onWant(next: Record<string, boolean>): void; old?: boolean; disabled?: boolean; testId?: string }) {
  const on = (e: McpOfferEntry) => want[e.name] ?? e.on;
  const there = where ? `${where} 上` : "";
  let body: React.ReactNode;
  if (old) body = <span className="settings-hint">{where} 上的 Studio 要更新到 {REMOTE_MCP_SINCE} 或更新的版本，才能在这里选它的 MCP；现在会话按那台电脑自己的 MCP 设置开。</span>;
  else if (!state) body = <span className="settings-hint">正在读取{where ? ` ${where} 上的` : ""} MCP…</span>;
  else if ("error" in state)
    body = (
      <span className="form-error" role="alert">
        读不到{where ? ` ${where} 上的` : ""} MCP：{state.error}
      </span>
    );
  else if (!state.list.entries.length) body = <span className="settings-hint">{where ? `${where} 上` : "这里"}没有别的 MCP（Studio 自带的 amo 一直都在）。</span>;
  else {
    const fixed = !state.list.perSession || !!state.list.locked;
    body = (
      <>
        <div className="rmcp-list" role="group" aria-label={`${there}MCP`}>
          {state.list.entries.map((e) => (
            <button
              key={e.name}
              type="button"
              className="rmcp-chip"
              aria-pressed={on(e)}
              disabled={disabled || fixed}
              title={[`来源：${MCP_SOURCE_LABELS[e.source] ?? e.source}`, e.note, want[e.name] !== undefined ? `在这里${want[e.name] ? "打开" : "关掉"}的（默认${e.on ? "开" : "关"}）` : null].filter(Boolean).join("\n")}
              onClick={() => onWant(toggleMcp(want, e))}
              data-testid={`${testId}-${e.name}`}
            >
              {on(e) ? "✓" : "○"} {e.name}
              {want[e.name] !== undefined && <span className="rmcp-changed"> · 改过</span>}
            </button>
          ))}
        </div>
        {state.list.locked ? (
          <span className="settings-hint" role="note" data-testid={`${testId}-locked`}>
            {state.list.locked}
          </span>
        ) : (
          <span className="settings-hint">
            {state.list.perSession
              ? `默认和${where ? ` ${where} 上` : "这个项目里"}新开的会话一样；点一下改开关，只改这个会话。`
              : `Codex 的 MCP 在它启动时就定了，不能按会话选：按${where ? ` ${where} 的` : ""}全局设置。`}
          </span>
        )}
      </>
    );
  }
  return (
    <div className={`rmcp${old ? " rmcp-old" : ""}`} data-testid={testId}>
      {body}
    </div>
  );
}
