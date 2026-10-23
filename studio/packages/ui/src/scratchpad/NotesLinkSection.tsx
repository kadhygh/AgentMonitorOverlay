import { useCallback, useEffect, useState } from "react";
import { shortcutLabel } from "./logic.js";
import type { NotesStatus, ScratchpadBridge } from "./bridge.js";

// 设置 → 便签 inside Studio (2026-10-23): the 便签 is a program of its own, installed with Studio. Restarting Studio does
// not close it and its settings are its own; here is only whether it runs and the way to it.

export function NotesLinkSection({ bridge }: { bridge: ScratchpadBridge }) {
  const [status, setStatus] = useState<NotesStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(() => {
    void bridge
      .notesStatus?.()
      .then(setStatus)
      .catch(() => setStatus({ running: false }));
  }, [bridge]);
  useEffect(read, [read]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      read();
    }
  }

  const running = status?.running ?? false;
  return (
    <section className="settings-section" aria-label="便签" data-testid="notes-link">
      <span className="settings-heading">便签</span>
      <span className="settings-hint">便签是独立的小程序，跟 Studio 一起安装。Studio 重启不会关掉它，它的设置也在它自己那里（托盘图标右键 → 设置…）。</span>
      <div className="settings-row">
        <span className={`notes-dot${running ? " on" : ""}`} aria-hidden="true" />
        <span data-testid="notes-link-state">{status === null ? "正在查看…" : running ? "运行中" : "没有在运行"}</span>
        {running && status?.active && <span className="settings-hint">· 快捷键 {shortcutLabel(status.active)}</span>}
      </div>
      {status?.error && (
        <span className="form-error" role="alert">
          {status.error}
        </span>
      )}
      <div className="settings-row">
        {running ? (
          <button type="button" className="btn-primary small" disabled={busy} onClick={() => void act(() => bridge.open())}>
            显示便签
          </button>
        ) : (
          <button type="button" className="btn-primary small" disabled={busy || status === null} onClick={() => void act(() => bridge.startNotes?.() ?? bridge.open())} data-testid="notes-start">
            启动便签
          </button>
        )}
        <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void act(() => bridge.openNotesSettings?.() ?? Promise.resolve())}>
          打开便签设置
        </button>
      </div>
      <span className="settings-hint">顶栏的「便签」按钮也一样：开着就呼出，没开就先启动再呼出。</span>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </section>
  );
}
