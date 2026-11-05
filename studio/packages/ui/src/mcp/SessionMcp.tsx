import { useCallback, useEffect, useState } from "react";
import type { McpApply, McpSessionState, Session } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { EntryLine, openMcpSettings, useMcpChanges } from "./shared.js";

// The composer's 「MCP」 (2026-11-04, plans/done/mcp.md): which MCP servers this session has, ticked on or off for it alone;
// the rest follow its project and 设置 → MCP. A new session of the same task starts with the same choices.

/** The session's MCP, kept up to date; `refresh` reads the running process's statuses again (Claude). */
export function useSessionMcp(link: HostLink, session: Session) {
  const [state, setState] = useState<McpSessionState | null>(null);
  const own = JSON.stringify(session.options.mcp ?? {});
  const refresh = useCallback(() => {
    if (session.runtime === "remote") return;
    call(link, "GET /api/sessions/:id/mcp", { id: session.id })
      .then(setState)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again when the session's own choices change
  }, [link, session.id, session.runtime, own]);
  useEffect(refresh, [refresh]);
  useMcpChanges(refresh);
  return { state, setState, refresh };
}

const APPLY: Record<McpApply, string> = {
  now: "已生效，下一次调用工具就能用",
  "next-message": "从下一条消息起生效",
  "after-turn": "这一轮回复结束后生效",
  "codex-restart": "Codex 下次启动后生效",
  "not-running": "已保存",
};

export function SessionMcpTray({ link, session, state, onState, disabled }: { link: HostLink; session: Session; state: McpSessionState | null; onState(s: McpSessionState): void; disabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);

  async function choose(name: string, choice: boolean | null) {
    setBusy(true);
    setNote(null);
    // Shown at once; the Host's answer replaces it (or the error, and the next read, puts it back).
    if (state)
      onState({
        ...state,
        entries: state.entries.map((e) => {
          if (e.name !== name) return e;
          const { choice: _old, ...rest } = e;
          return choice === null ? { ...rest, on: e.inherited } : { ...rest, on: choice, choice };
        }),
      });
    try {
      const next = await call(link, "PUT /api/sessions/:id/mcp", { id: session.id }, { choices: { [name]: choice } });
      onState(next);
      setNote({ text: APPLY[next.apply] });
    } catch (err) {
      setNote({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  const entries = state?.entries ?? [];
  return (
    <>
      <div className="tray-h">
        MCP
        <span className="tray-note">{state?.perSession === false ? "Codex 的 MCP 在它启动时就定了，这里只能看；它自己 config.toml 里的不在这里列" : "只改这个会话；同一任务新开的会话会沿用"}</span>
      </div>
      <div className="mcp-tray-list" data-testid="mcp-tray">
        {!state && <span className="tray-note">正在读取…</span>}
        {state && entries.length === 0 && <span className="tray-note">没有可用的 MCP（Studio 自带的 amo 一直都在）。</span>}
        {entries.map((e) =>
          state?.perSession === false ? (
            <EntryLine key={e.name} entry={e} />
          ) : (
            <label key={e.name} className="mcp-entry" data-testid={`mcp-tray-${e.name}`}>
              <input type="checkbox" checked={e.on} disabled={disabled || busy} onChange={(ev) => void choose(e.name, ev.target.checked === e.inherited ? null : ev.target.checked)} />
              <EntryLine entry={e} />
              {e.choice !== undefined && <span className="tray-note">本会话单独{e.choice ? "打开" : "关掉"}的</span>}
            </label>
          ),
        )}
      </div>
      <div className="mcp-tray-foot">
        {note && (
          <span className={note.error ? "form-error" : "applied"} role={note.error ? "alert" : "status"} data-testid="mcp-tray-note">
            {note.error ? note.text : `✓ ${note.text}`}
          </span>
        )}
        <button type="button" className="link-btn" onClick={openMcpSettings} data-testid="mcp-manage">
          管理 MCP…
        </button>
      </div>
    </>
  );
}
