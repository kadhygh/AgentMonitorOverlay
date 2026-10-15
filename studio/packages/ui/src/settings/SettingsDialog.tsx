import { useEffect, useState } from "react";
import type { StudioSettings } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent } from "../host/events.js";
import { setThemePref, THEME_LABELS, themePref, type ThemePref } from "../lib/theme.js";
import { ModelsPage } from "./ModelsPage.js";
import { FeaturesSection } from "./FeaturesSection.js";
import { ScratchpadSettings } from "../scratchpad/ScratchpadSettings.js";
import { DataPage } from "./DataPage.js";
import { QuotaPage } from "./QuotaPage.js";
import { setTranscriptView, TRANSCRIPT_VIEW_HINTS, TRANSCRIPT_VIEW_LABELS, useTranscriptView, type TranscriptView } from "../chat/prefs.js";
import { useChatSettings } from "../chat/cli/chatSettings.js";

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

/** The pages of 设置, one per area, in the left column. */
const PAGES = [
  { id: "ui", label: "界面" },
  { id: "models", label: "模型" },
  { id: "quota", label: "额度" },
  { id: "common", label: "公共目录" },
  { id: "features", label: "功能" },
  { id: "scratchpad", label: "便签" },
  { id: "data", label: "数据管理" },
] as const;
type SettingsPage = (typeof PAGES)[number]["id"];

// The page last open, for the next time 设置 opens in this window.
let lastPage: SettingsPage = "ui";

/**
 * 设置, in pages: 界面 (the look, per install), 模型 (how Claude signs in, keys, 常用预设), 公共目录 (a folder for sessions
 * that belong to no single project: the scheduler's rounds, and the default for cross-workspace sessions), 功能 and 便签.
 */
export function SettingsDialog({ link, settings, onClose }: { link: HostLink; settings: StudioSettings | null; onClose(): void }) {
  const [page, setPage] = useState<SettingsPage>(lastPage);
  const [theme, setTheme] = useState<ThemePref>(themePref);
  const view = useTranscriptView();
  const chat = useChatSettings(link);
  const [dir, setDir] = useState(settings?.commonWorkspace?.path ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => setDir(settings?.commonWorkspace?.path ?? ""), [settings?.commonWorkspace?.path]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function saveCommon(value: string) {
    setBusy(true);
    setMessage(null);
    try {
      const next = await call(link, "PUT /api/settings", {}, { commonDir: value });
      setMessage({ text: `公共目录：${next.commonWorkspace.path}` });
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

  function open(next: SettingsPage) {
    lastPage = next;
    setPage(next);
    setMessage(null);
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings-modal" role="dialog" aria-modal="true" aria-label="设置">
        <div className="modal-head">
          <span className="modal-title">设置</span>
          <span className="spacer" />
          <button type="button" className="link-btn" onClick={onClose} aria-label="关闭设置">
            关闭
          </button>
        </div>
        <div className="settings-body">
          <div className="settings-nav" role="tablist" aria-label="设置分类" aria-orientation="vertical">
            {PAGES.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                id={`settings-tab-${p.id}`}
                aria-selected={page === p.id}
                aria-controls="settings-page"
                className="settings-tab"
                onClick={() => open(p.id)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  const i = PAGES.findIndex((x) => x.id === page);
                  const next = PAGES[(i + (e.key === "ArrowDown" ? 1 : PAGES.length - 1)) % PAGES.length]!.id;
                  open(next);
                  document.getElementById(`settings-tab-${next}`)?.focus();
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="settings-page" id="settings-page" role="tabpanel" aria-labelledby={`settings-tab-${page}`} key={page}>
            {page === "ui" && (
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
                <div className="settings-row">
                  <span className="settings-label">工作步骤展示</span>
                  <div role="radiogroup" aria-label="工作步骤展示" className="chips">
                    {(Object.keys(TRANSCRIPT_VIEW_LABELS) as TranscriptView[]).map((v) => (
                      <button
                        key={v}
                        type="button"
                        role="radio"
                        className="chip"
                        aria-checked={view === v}
                        aria-pressed={view === v}
                        title={TRANSCRIPT_VIEW_HINTS[v]}
                        onClick={() => setTranscriptView(v)}
                      >
                        {TRANSCRIPT_VIEW_LABELS[v]}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="settings-hint">{TRANSCRIPT_VIEW_HINTS[view]}。</span>
                <div className="settings-row">
                  <span className="settings-label">建议的下一句</span>
                  <div role="radiogroup" aria-label="建议的下一句" className="chips">
                    {([true, false] as const).map((on) => (
                      <button
                        key={String(on)}
                        type="button"
                        role="radio"
                        className="chip"
                        aria-checked={chat.settings.promptSuggestions === on}
                        aria-pressed={chat.settings.promptSuggestions === on}
                        onClick={() => void chat.update({ promptSuggestions: on }).catch((err: unknown) => setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true }))}
                      >
                        {on ? "显示" : "关闭"}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="settings-hint">Claude 会话每轮回答后，在输入框上方给出建议的下一句，点一下填进输入框。默认关闭：每轮会多一次很小的模型请求。</span>
                {message && (
                  <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"} data-testid="settings-message">
                    {message.text}
                  </span>
                )}
              </section>
            )}

            {page === "models" && <ModelsPage link={link} settings={settings} />}
            {page === "quota" && <QuotaPage link={link} settings={settings} />}

            {page === "common" && (
              <section className="settings-section" aria-label="公共目录">
                <span className="settings-heading">公共目录</span>
                <span className="settings-hint">没有指定项目的任务、调度 agent，以及没选项目的专题会话都在这个文件夹里运行。默认是数据目录下的 common 文件夹。</span>
                <div className="settings-row">
                  <input className="field" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="例如 D:\AMO\common" aria-label="公共目录" />
                  {window.amo?.pickDirectory && (
                    <button type="button" className="btn-ghost small" onClick={() => void pick()} disabled={busy}>
                      选择…
                    </button>
                  )}
                </div>
                <div className="settings-row end">
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
            )}
            {page === "features" && <FeaturesSection link={link} disabled={settings?.disabledFeatures ?? []} />}
            {page === "scratchpad" && <ScratchpadSettings link={link} settings={settings} />}
            {page === "data" && <DataPage link={link} />}
          </div>
        </div>
      </div>
    </div>
  );
}
