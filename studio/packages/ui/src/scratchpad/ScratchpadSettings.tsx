import { useState } from "react";
import { SCRATCHPAD_MAX_PAGES, type StudioSettings } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { scratchpadBridge } from "./bridge.js";
import { ScratchpadEntry } from "./ScratchpadEntry.js";
import { ShortcutSection } from "./ShortcutSection.js";
import { useScratchpad } from "./useScratchpad.js";

// 设置 → 便签 (S14-B): the global shortcut, the page count (moved here from the window) and how 复制 breaks lines. In a
// plain browser, where there is no scratchpad window, the page itself is edited here too.

const NEWLINE_CHOICES = [
  { safe: false, label: "常规换行", hint: "保留原来的分行（去掉行尾空格和末尾空行）。粘贴到 Studio 的输入框、文档、聊天软件都按原样分行。" },
  { safe: true, label: "安全换行", hint: "把多行合成一行，用空格连接。只在要粘贴进终端里的 CLI、怕一换行就被发出去时才需要。" },
] as const;

export function ScratchpadSettings({ link, settings }: { link: HostLink; settings: StudioSettings | null }) {
  return (
    <>
      <ShortcutSection link={link} shortcut={settings?.scratchpadShortcut ?? ""} />
      <PagesSection link={link} />
      <NewlinesSection link={link} safe={settings?.scratchpadSafeNewlines ?? false} />
      {!scratchpadBridge() && <ScratchpadEntry link={link} />}
    </>
  );
}

function PagesSection({ link }: { link: HostLink }) {
  const pad = useScratchpad(link);
  const count = pad.doc?.pages.length ?? 0;
  const kept = pad.doc?.keptPages ?? [];
  return (
    <section className="settings-section" aria-label="便签页数">
      <span className="settings-heading">页数</span>
      <div className="settings-row">
        <span className="pad-count">
          <button type="button" className="pad-step" aria-label="减少页数" disabled={!pad.doc || count <= 1} onClick={() => pad.setPageCount(count - 1)}>
            −
          </button>
          <span className="pad-count-value" data-testid="pad-page-count">
            {pad.doc ? count : "…"}
          </span>
          <button type="button" className="pad-step" aria-label="增加页数" disabled={!pad.doc || count >= SCRATCHPAD_MAX_PAGES} onClick={() => pad.setPageCount(count + 1)}>
            +
          </button>
        </span>
        <span className="settings-hint">最多 {SCRATCHPAD_MAX_PAGES} 页，便签窗口里用 Ctrl+1…9 切换。</span>
      </div>
      <span className="settings-hint">减少页数不会删掉内容：藏起来的页还留着，再增加页数就能看到。</span>
      {kept.length > 0 && (
        <span className="settings-hint" data-testid="pad-kept-pages">
          第 {kept.join("、")} 页还有内容，现在藏着。
        </span>
      )}
      {pad.state === "error" && pad.error && (
        <span className="form-error" role="alert">
          {pad.error}
        </span>
      )}
    </section>
  );
}

function NewlinesSection({ link, safe }: { link: HostLink; safe: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(next: boolean) {
    if (next === safe) return;
    setBusy(true);
    setError(null);
    try {
      await call(link, "PUT /api/settings", {}, { scratchpadSafeNewlines: next });
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-label="便签复制">
      <span className="settings-heading">复制</span>
      <div className="settings-row">
        <span className="settings-label">复制时的换行</span>
        <div role="radiogroup" aria-label="复制时的换行" className="chips">
          {NEWLINE_CHOICES.map((c) => (
            <button
              key={c.label}
              type="button"
              role="radio"
              className="chip"
              aria-checked={safe === c.safe}
              aria-pressed={safe === c.safe}
              title={c.hint}
              disabled={busy}
              onClick={() => void choose(c.safe)}
              data-testid={c.safe ? "pad-newlines-safe" : "pad-newlines-normal"}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <span className="settings-hint">{NEWLINE_CHOICES.find((c) => c.safe === safe)!.hint}便签窗口的「复制」按这里的设置。</span>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </section>
  );
}
