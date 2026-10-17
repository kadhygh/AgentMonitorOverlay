import { useEffect, useRef, useState } from "react";
import type { ModelProfile, Session, SessionOptions, SessionPreset } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { activeModel, optionsSummary, sameOptions, useProfileChoices } from "../lib/choices.js";
import { rememberPick } from "../lib/recents.js";
import { EffortBars, FastToggle, Mark, nextEffort, PermissionTiles, pickLabel } from "./pickers.js";

// Under the composer: what the session runs with — model, effort, permissions — each one click away
// (design/ui-directions/new-task.html, "会话中切换"). Clicking the model or the permissions opens that group above the
// composer; the effort bars are clicked directly. Models switch only within the session's own account (the context
// stays); another account needs a new session. Codex takes a change from the next turn, Claude at once.

type Tray = "model" | "permission" | null;

export function SessionOptionsBar({
  link,
  session,
  profile,
  presets,
  disabled,
}: {
  link: HostLink;
  session: Session;
  profile: ModelProfile | undefined;
  presets: readonly SessionPreset[];
  disabled: boolean;
}) {
  const { choices } = useProfileChoices(link, session.profileId);
  const [tray, setTray] = useState<Tray>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error?: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const mine = presets.filter((p) => p.profileId === session.profileId);
  const model = choices ? activeModel(choices, session.options) : undefined;
  const when = session.runtime === "claude" ? "立即生效" : "下一轮生效";

  useEffect(() => {
    if (!tray) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setTray(null);
    };
    window.addEventListener("keydown", close);
    window.addEventListener("mousedown", close);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("mousedown", close);
    };
  }, [tray]);

  useEffect(() => {
    if (!note || note.error) return;
    const t = setTimeout(() => setNote(null), 3200);
    return () => clearTimeout(t);
  }, [note]);

  // Fast is sent only when it is what changed: presets carry model, effort and permissions, not speed.
  async function apply(next: SessionOptions, what: string, fast?: boolean) {
    setBusy(true);
    setTray(null);
    try {
      await call(
        link,
        "PATCH /api/sessions/:id/options",
        { id: session.id },
        fast === undefined ? { model: next.model ?? null, effort: next.effort ?? null, permission: next.permission ?? null } : { fast },
      );
      setNote({ text: `${what}，${when}` });
    } catch (err) {
      setNote({ text: err instanceof HostApiError ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }

  const setModel = (id: string, label: string) => {
    const next: SessionOptions = { ...session.options, model: id };
    // An effort the new model does not take falls back to its default.
    const m = choices?.models.find((x) => x.id === id);
    if (m && next.effort && !m.efforts.includes(next.effort)) delete next.effort;
    rememberPick({ profileId: session.profileId, model: m?.isDefault ? null : id });
    void apply(next, `型号换成「${label}」`);
  };
  const setEffort = (effort: string) => void apply({ ...session.options, effort }, "思考强度已改");
  const setFast = (on: boolean) => void apply(session.options, on ? "Fast 已开" : "Fast 已关", on);
  const setPermission = (id: string) => void apply({ ...session.options, permission: id }, `权限换成「${choices?.permissions.find((p) => p.id === id)?.label ?? id}」`);

  // Alt M: models, Alt P: permissions, Alt E: one effort up.
  useEffect(() => {
    if (disabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if (k === "m" || k === "p") {
        e.preventDefault();
        const want: Tray = k === "m" ? "model" : "permission";
        setTray((t) => (t === want ? null : want));
      } else if (k === "e" && model) {
        e.preventDefault();
        const next = nextEffort(model.efforts, session.options.effort ?? model.defaultEffort);
        if (next) setEffort(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // The model by name also when it is the profile's default ("Opus 5.5", not just "Claude").
  const label = pickLabel(profile, model?.id ?? session.options.model ?? null, choices?.models);
  const permission = choices?.permissions.find((p) => p.id === (session.options.permission ?? choices.defaultPermission));

  return (
    <div className="session-options" ref={box}>
      {tray && choices && (
        <div className="tray" role="dialog" aria-label={tray === "model" ? "换型号" : "权限"} data-testid="options-tray">
          <div className="tray-h">
            {tray === "model" ? "换型号" : "权限"}
            <span className="tray-note">{tray === "model" ? `只在 ${profile?.label ?? "同一家"} 里换，上下文不变，${when}` : when}</span>
            <kbd>{tray === "model" ? "Alt M" : "Alt P"}</kbd>
          </div>
          {tray === "model" ? (
            <>
              <div className="tray-row" role="group" aria-label="型号">
                {choices.models.map((m) => (
                  <button key={m.id} type="button" className="mtile" aria-pressed={model?.id === m.id} disabled={busy} title={m.description} onClick={() => setModel(m.id, m.label)}>
                    <Mark profile={profile} small />
                    <span className="mtile-main">{m.label}</span>
                  </button>
                ))}
              </div>
              <span className="tray-note">要换到别家的模型，新开一个会话。</span>
            </>
          ) : (
            <PermissionTiles choices={choices} value={session.options.permission ?? null} onChange={setPermission} disabled={busy} />
          )}
        </div>
      )}
      <div className="status-line" data-testid="session-options" title={optionsSummary(choices, session.options)}>
        <button
          type="button"
          className="seg-btn"
          aria-expanded={tray === "model"}
          disabled={disabled || !choices}
          onClick={() => setTray((t) => (t === "model" ? null : "model"))}
          onContextMenu={(e) => {
            // Right click: the same models, as on the tiles elsewhere.
            e.preventDefault();
            setTray("model");
          }}
          data-testid="switch-model"
        >
          <Mark profile={profile} small />
          <span>{label.main}</span>
        </button>
        {model && model.efforts.length > 0 && (
          <EffortBars efforts={model.efforts} value={session.options.effort ?? null} fallback={model.defaultEffort} onChange={setEffort} disabled={disabled || busy} small />
        )}
        {session.runtime === "codex" && <FastToggle fast={model?.fast} value={session.options.fast} onChange={setFast} disabled={disabled || busy} small when={when} />}
        <button
          type="button"
          className="seg-btn"
          aria-expanded={tray === "permission"}
          disabled={disabled || !choices}
          onClick={() => setTray((t) => (t === "permission" ? null : "permission"))}
          data-testid="switch-permission"
        >
          <span aria-hidden="true">⛨</span>
          <span>{permission?.label ?? "默认权限"}</span>
        </button>
      </div>
      {mine.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`preset-chip${sameOptions(p.options, session.options) ? " active" : ""}`}
          aria-pressed={sameOptions(p.options, session.options)}
          disabled={disabled || busy}
          title={optionsSummary(choices, p.options)}
          onClick={() => void apply(p.options, `已换成预设「${p.name}」`)}
          data-testid="preset-chip"
        >
          {p.name}
        </button>
      ))}
      {note && (
        <span className={note.error ? "form-error" : "applied"} role={note.error ? "alert" : "status"} data-testid="options-note">
          {note.error ? note.text : `✓ ${note.text}`}
        </span>
      )}
    </div>
  );
}
