import { useEffect, useState } from "react";
import type { StudioSettings } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent } from "../host/events.js";
import { setThemePref, THEME_LABELS, themePref, type ThemePref } from "../lib/theme.js";

/** Studio-wide settings from the Host, kept live. */
export function useSettings(link: HostLink): StudioSettings | null {
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  useEffect(() => {
    let cancelled = false;
    call(link, "GET /api/settings")
      .then((s) => !cancelled && setSettings(s))
      .catch(() => undefined);
    const off = onHostEvent((e) => {
      if (e.type === "settings.updated") setSettings(e.settings);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [link]);
  return settings;
}

/**
 * 设置: the look (theme, per install) and the common space (a folder for sessions that belong to no single project:
 * the scheduler's rounds, and the default for cross-workspace sessions).
 */
export function SettingsDialog({ link, settings, onClose }: { link: HostLink; settings: StudioSettings | null; onClose(): void }) {
  const [theme, setTheme] = useState<ThemePref>(themePref);
  const [dir, setDir] = useState(settings?.commonWorkspace?.path ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => setDir(settings?.commonWorkspace?.path ?? ""), [settings?.commonWorkspace?.path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function saveCommon(value: string | null) {
    setBusy(true);
    setMessage(null);
    try {
      const next = await call(link, "PUT /api/settings", {}, { commonDir: value });
      setMessage({ text: next.commonWorkspace ? `公共空间：${next.commonWorkspace.path}` : "已清除公共空间" });
    } catch (err) {
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  async function pick() {
    const chosen = await window.amo?.pickDirectory?.();
    if (chosen) setDir(chosen);
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="设置">
        <div className="modal-head">
          <span className="modal-title">设置</span>
          <span className="spacer" />
          <button type="button" className="link-btn" onClick={onClose} aria-label="关闭设置">
            关闭
          </button>
        </div>

        <section className="settings-section" aria-label="界面">
          <span className="settings-heading">界面</span>
          <div className="settings-row">
            <span className="settings-label">主题</span>
            <div role="radiogroup" aria-label="主题" className="chips">
              {(Object.keys(THEME_LABELS) as ThemePref[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  className="chip"
                  aria-checked={theme === p}
                  aria-pressed={theme === p}
                  onClick={() => {
                    setTheme(p);
                    setThemePref(p);
                  }}
                >
                  {THEME_LABELS[p]}
                </button>
              ))}
            </div>
          </div>
          <span className="settings-hint">只影响这台电脑上的 Studio；Focus 悬浮窗会一起切换。</span>
        </section>

        <section className="settings-section" aria-label="公共空间">
          <span className="settings-heading">公共空间</span>
          <span className="settings-hint">不属于某个工程的会话在这里运行：调度 agent 每一轮的会话，以及跨工作区任务默认的会话目录。选好的文件夹会登记成一个名为"公共空间"的工作区。</span>
          <div className="settings-row">
            <input className="field" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="例如 D:\AMO\common" aria-label="公共空间目录" />
            {window.amo?.pickDirectory && (
              <button type="button" className="btn-ghost small" onClick={() => void pick()} disabled={busy}>
                选择…
              </button>
            )}
          </div>
          <div className="settings-row end">
            {settings?.commonWorkspace && (
              <button type="button" className="btn-ghost small" onClick={() => void saveCommon(null)} disabled={busy}>
                清除
              </button>
            )}
            <button type="button" className="btn-primary small" onClick={() => void saveCommon(dir.trim())} disabled={busy || !dir.trim() || dir.trim() === settings?.commonWorkspace?.path}>
              保存
            </button>
          </div>
          {message && (
            <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"} data-testid="settings-message">
              {message.text}
            </span>
          )}
        </section>
      </div>
    </div>
  );
}
