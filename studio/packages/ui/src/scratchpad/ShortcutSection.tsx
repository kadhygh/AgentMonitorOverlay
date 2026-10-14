import { useEffect, useState, type KeyboardEvent } from "react";
import { DEFAULT_SCRATCHPAD_SHORTCUT } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { scratchpadBridge, type ShortcutStatus } from "./bridge.js";
import { shortcutFromKey, shortcutLabel } from "./logic.js";

// 设置 → 便签: the global shortcut that shows and hides the scratchpad window. It is kept in the Host settings; the
// app registers it and says here whether that worked (another program may hold the key).

export function ShortcutSection({ link, shortcut }: { link: HostLink; shortcut: string }) {
  const bridge = scratchpadBridge();
  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ShortcutStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    bridge
      ?.shortcutStatus()
      .then((s) => !cancelled && setStatus(s))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening of 设置
  }, []);

  async function save(next: string) {
    setBusy(true);
    setError(null);
    try {
      await call(link, "PUT /api/settings", {}, { scratchpadShortcut: next });
      if (!bridge) return;
      const result = await bridge.applyShortcut();
      setStatus(result);
      // The key is held elsewhere and the previous one still works: keep the setting on what works (the message stays).
      if (result.error && result.active && result.active !== next) await call(link, "PUT /api/settings", {}, { scratchpadShortcut: result.active });
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Tab") return;
    e.preventDefault();
    // Esc leaves the field without closing 设置.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.currentTarget.blur();
      return;
    }
    const got = shortcutFromKey(e);
    if ("pending" in got) return;
    if ("invalid" in got) {
      setError("需要 Ctrl、Alt 或 Win 加一个键，或者单独的 F1–F24");
      return;
    }
    e.currentTarget.blur();
    if (got.shortcut !== shortcut) void save(got.shortcut);
  }

  const line = error
    ? { text: error, alert: true }
    : !bridge
      ? { text: "快捷键只在 Studio 应用里生效。", alert: false }
      : status?.error
        ? { text: status.error, alert: true }
        : status && status.wanted === shortcut
          ? { text: status.active ? `已生效：${shortcutLabel(status.active)}` : "快捷键已关闭，可以点标题栏的「便签」打开。", alert: false }
          : null;

  return (
    <section className="settings-section" aria-label="便签">
      <span className="settings-heading">便签</span>
      <span className="settings-hint">便签是一个置顶的小窗，所有任务共用，可以粘贴图片。在任何程序里按快捷键都能唤出或隐藏它。</span>
      <div className="settings-row">
        <span className="settings-label">快捷键</span>
        <input
          className="field pad-shortcut"
          readOnly
          value={capturing ? "请按下新的组合键…" : shortcutLabel(shortcut)}
          aria-label="便签快捷键"
          data-testid="scratchpad-shortcut"
          disabled={busy}
          onFocus={() => {
            setCapturing(true);
            setError(null);
          }}
          onBlur={() => setCapturing(false)}
          onKeyDown={onKey}
        />
        <button type="button" className="btn-ghost small" disabled={busy || shortcut === DEFAULT_SCRATCHPAD_SHORTCUT} onClick={() => void save(DEFAULT_SCRATCHPAD_SHORTCUT)}>
          恢复默认
        </button>
        <button type="button" className="btn-ghost small" disabled={busy || !shortcut} onClick={() => void save("")}>
          关闭
        </button>
      </div>
      {line && (
        <span className={line.alert ? "form-error" : "settings-hint"} role={line.alert ? "alert" : "status"} data-testid="scratchpad-shortcut-status">
          {line.text}
        </span>
      )}
    </section>
  );
}
