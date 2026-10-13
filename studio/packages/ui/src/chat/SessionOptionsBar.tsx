import { useEffect, useRef, useState } from "react";
import type { Session, SessionOptions, SessionPreset } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { optionsSummary, sameOptions, useProfileChoices } from "../lib/choices.js";
import { OptionsPicker } from "./OptionsPicker.js";

// In the composer: what the session runs with (型号 · 思考强度 · 权限), a panel to switch them, and the 常用预设 of this
// session's profile as one-click chips. Codex takes a change from the next turn; Claude at once.

export function SessionOptionsBar({ link, session, presets, disabled }: { link: HostLink; session: Session; presets: readonly SessionPreset[]; disabled: boolean }) {
  const { choices } = useProfileChoices(link, session.profileId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const mine = presets.filter((p) => p.profileId === session.profileId);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", close);
    window.addEventListener("mousedown", close);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("mousedown", close);
    };
  }, [open]);

  async function apply(next: SessionOptions) {
    setBusy(true);
    setError(null);
    try {
      await call(link, "PATCH /api/sessions/:id/options", { id: session.id }, { model: next.model ?? null, effort: next.effort ?? null, permission: next.permission ?? null });
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const running = session.status === "running" || session.status === "awaiting-approval";
  return (
    <div className="session-options" ref={box}>
      <button
        type="button"
        className="composer-model"
        aria-expanded={open}
        aria-label="模型与权限"
        title="切换型号、思考强度和权限"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        data-testid="session-options"
      >
        {optionsSummary(choices, session.options)}
      </button>
      {mine.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`preset-chip${sameOptions(p.options, session.options) ? " active" : ""}`}
          aria-pressed={sameOptions(p.options, session.options)}
          disabled={disabled || busy}
          title={optionsSummary(choices, p.options)}
          onClick={() => void apply(p.options)}
          data-testid="preset-chip"
        >
          {p.name}
        </button>
      ))}
      {open && (
        <div className="options-panel" role="dialog" aria-label="模型与权限">
          <OptionsPicker choices={choices} value={session.options} onChange={(next) => void apply(next)} disabled={busy} layout="stack" />
          <span className="settings-hint">
            {session.runtime === "codex" ? (running ? "这一轮已在运行，改动从下一轮开始生效。" : "改动从下一轮开始生效。") : "改动立即生效。"}
            常用组合可以在 设置 → 常用预设 里保存。
          </span>
          {error && (
            <span className="form-error" role="alert">
              {error}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
