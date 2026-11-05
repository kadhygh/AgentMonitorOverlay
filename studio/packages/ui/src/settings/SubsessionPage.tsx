import { useEffect, useRef, useState } from "react";
import { MAX_SUBSESSION_NOTES, SUBSESSION_NOTE_MAX, type ModelOption, type ModelProfile, type StudioSettings, type SubsessionNote, type SubsessionPermission } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { modelName, useChoicesFor } from "../lib/choices.js";
import { pickable } from "../lib/profiles.js";
import { useProfiles } from "../lib/balance.js";
import { normalPick } from "../lib/recents.js";
import { EffortBars, Mark } from "../chat/pickers.js";

// 设置 → 子会话 (2026-10-26): per model, the person's note on using it as a sub-session — what it suits, how to brief
// it. The main model reads them in its role card (amo_whoami) and with 「@子会话N」 (@ 开子会话…).
// Each channel shows its models as chips (10-26, the two dropdowns put a note on the wrong channel): a click opens that
// one's note below. 「整个渠道」 holds a note for all its models; a model's own note goes before it.
// 2026-11-05 (the user: 「每种模型可能都要有自己的设置方式」): each model's block also holds its defaults as a sub-session —
// effort (its own list), Fast (where it has one), permission — the first choice in @ 开子会话… and what session_start
// uses when the agent leaves them out. 「整个渠道」's effort is its default model's; its Fast and permission go for all.

const LEVELS: Array<{ id: SubsessionPermission | null; label: string; hint: string }> = [
  { id: null, label: "默认", hint: "和开它的会话一样（换了 CLI 用那个 CLI 的默认）" },
  { id: "read-only", label: "只读", hint: "只看不改" },
  { id: "write", label: "可写", hint: "能改它的文件夹，越界要问" },
  { id: "full", label: "完全放开", hint: "不用沙箱、不用审批，适合连续跑很多命令" },
];
const hasContent = (n: SubsessionNote) => !!n.note.trim() || !!n.effort || n.fast !== undefined || !!n.permission;

const keyOf = (n: { profileId: string; model: string | null }) => `${n.profileId}/${n.model ?? ""}`;

export function SubsessionPage({ link, settings }: { link: HostLink; settings: StudioSettings | null }) {
  const profiles = useProfiles(link);
  const saved = settings?.subsessionNotes ?? [];
  // Notes being written: what was typed, kept until it is saved (one opened without a note yet lives only here).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<SubsessionNote[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const page = useRef<HTMLElement>(null);
  const rows = [...saved, ...added.filter((a) => !saved.some((s) => keyOf(s) === keyOf(a)))];
  const channels = (profiles ?? []).filter((p) => pickable(profiles ?? []).includes(p) || rows.some((r) => r.profileId === p.id));
  const choices = useChoicesFor(
    link,
    channels.map((p) => p.id),
  );
  useEffect(() => {
    if (!focusKey) return;
    page.current?.querySelector<HTMLTextAreaElement>(`textarea[data-key="${CSS.escape(focusKey)}"]`)?.focus();
    setFocusKey(null);
  }, [focusKey, rows.length]);

  const nameOf = (n: { profileId: string; model: string | null }) => {
    if (!n.model) return "整个渠道";
    return modelName(choices.get(n.profileId)?.models.find((m) => m.id === n.model)) ?? n.model;
  };

  async function save(next: SubsessionNote[]) {
    setError(null);
    try {
      await call(link, "PUT /api/settings", {}, { subsessionNotes: next.filter(hasContent) });
      return true;
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      return false;
    }
  }
  const textOf = (n: SubsessionNote) => drafts[keyOf(n)] ?? n.note;
  async function commit(n: SubsessionNote) {
    const key = keyOf(n);
    const text = (drafts[key] ?? n.note).trim();
    const stored = saved.some((s) => keyOf(s) === key);
    if (text === n.note.trim() && (stored || !text)) {
      // Opened and left empty stays open (2026-11-05: its defaults may be set next; ✕ closes it).
      return;
    }
    const next = rows.map((r) => (keyOf(r) === key ? { ...r, note: text } : { ...r, note: textOf(r) }));
    if (await save(next)) {
      setDrafts(({ [key]: _gone, ...rest }) => rest);
      setAdded((a) => a.filter((x) => keyOf(x) !== key));
    }
  }
  /** A default changed: saved at once (with the notes as typed so far). */
  async function setDefaults(n: SubsessionNote, patch: Partial<Pick<SubsessionNote, "effort" | "fast" | "permission">>) {
    const key = keyOf(n);
    const merged = (r: SubsessionNote): SubsessionNote => {
      const out: SubsessionNote = { ...r, note: textOf(r) };
      for (const [k, v] of Object.entries(patch) as Array<[keyof typeof patch, unknown]>) {
        if (v === undefined) delete out[k];
        else (out as unknown as Record<string, unknown>)[k] = v;
      }
      return out;
    };
    const next = rows.map((r) => (keyOf(r) === key ? merged(r) : { ...r, note: textOf(r) }));
    if (await save(next)) setAdded((a) => a.filter((x) => keyOf(x) !== key));
  }
  async function remove(n: SubsessionNote) {
    const key = keyOf(n);
    setAdded((a) => a.filter((x) => keyOf(x) !== key));
    setDrafts(({ [key]: _gone, ...rest }) => rest);
    if (saved.some((s) => keyOf(s) === key)) await save(saved.filter((s) => keyOf(s) !== key));
  }
  function open(pick: { profileId: string; model: string | null }) {
    const n = normalPick(pick);
    const key = keyOf(n);
    if (!rows.some((r) => keyOf(r) === key)) {
      if (rows.length >= MAX_SUBSESSION_NOTES) return setError(`最多 ${MAX_SUBSESSION_NOTES} 段说明`);
      setAdded((a) => [...a, { ...n, note: "" }]);
    }
    setError(null);
    setFocusKey(key);
  }

  /** The model an entry is about: its own, or (「整个渠道」) the account's default one. */
  const modelOf = (p: ModelProfile, n: SubsessionNote): ModelOption | undefined => {
    const models = choices.get(p.id)?.models ?? [];
    return n.model ? models.find((m) => m.id === n.model) : (models.find((m) => m.isDefault) ?? models[0]);
  };

  if (!profiles) return <span className="settings-hint">正在读取渠道…</span>;
  const chipsOf = (p: ModelProfile) => {
    const models = choices.get(p.id)?.models ?? [];
    // The default model's own note is the channel's (a pick of the default is stored without a model).
    return [
      { model: null as string | null, label: "整个渠道" },
      ...models.filter((m) => !m.isDefault).map((m) => ({ model: m.id as string | null, label: modelName(m) ?? m.id })),
    ];
  };
  return (
    <section ref={page} className="settings-section" aria-label="子会话">
      <span className="settings-heading">子会话</span>
      <span className="settings-hint">
        每个型号作为子会话时的默认选项和用法。默认选项（思考强度、Fast、权限）是 @ 开子会话… 的初始值，主模型自己开子会话没写这几项时也用它们。用法写给主模型看：适合做什么、不适合做什么、怎么交代任务；它在 AMO 的身份说明（amo_whoami）里读到，用 @ 开子会话… 选了这个型号时消息里也会带上。点渠道下面的型号来设；「整个渠道」的用法、Fast 和权限对它的所有型号都适用（思考强度只管默认型号），某个型号另设了就用那个。用法每段最多{" "}
        {SUBSESSION_NOTE_MAX} 字，离开输入框时保存；选项改了马上保存。
      </span>
      <ul className="subsession-channels" data-testid="subsession-channels">
        {channels.map((p) => {
          const notes = rows.filter((r) => r.profileId === p.id);
          return (
            <li key={p.id} className="subsession-channel" data-testid="subsession-channel" data-profile={p.id}>
              <div className="settings-row">
                <Mark profile={p} small />
                <b className="subsession-channel-name">{p.label}</b>
                {p.hidden && <span className="settings-hint">（已隐藏）</span>}
              </div>
              <div className="settings-row subsession-chips" role="group" aria-label={`${p.label} 的型号`}>
                {chipsOf(p).map((c) => {
                  const has = notes.some((n) => (n.model ?? null) === c.model && saved.some((s) => keyOf(s) === keyOf(n)));
                  return (
                    <button
                      key={c.model ?? ""}
                      type="button"
                      className="chip small"
                      aria-pressed={has}
                      title={has ? "已经设过，点一下去改" : "设这个型号"}
                      onClick={() => open({ profileId: p.id, model: c.model })}
                      data-testid="subsession-chip"
                    >
                      {has ? "✓ " : "+ "}
                      {c.label}
                    </button>
                  );
                })}
              </div>
              {notes.map((n) => (
                <div key={keyOf(n)} className="subsession-note" data-testid="subsession-note" data-model={n.model ?? ""}>
                  <div className="settings-row">
                    <span className="settings-label">{nameOf(n)}</span>
                    <button type="button" className="quick-btn" aria-label={`删除 ${p.label} ${nameOf(n)} 的设置`} title="删除" onClick={() => void remove(n)} data-testid="subsession-note-remove">
                      ✕
                    </button>
                  </div>
                  <NoteDefaults note={n} model={modelOf(p, n)} onChange={(patch) => void setDefaults(n, patch)} />
                  <textarea
                    className="side-textarea"
                    rows={textOf(n).split("\n").length > 3 ? 8 : 3}
                    maxLength={SUBSESSION_NOTE_MAX}
                    aria-label={`${p.label} ${nameOf(n)} 作为子会话的说明`}
                    placeholder="例如：便宜、快，适合照详细计划改代码和跑命令；不擅长自己做设计决定。交代时写清改哪些文件、怎么验证。"
                    value={textOf(n)}
                    data-key={keyOf(n)}
                    onChange={(e) => setDrafts((d) => ({ ...d, [keyOf(n)]: e.target.value }))}
                    onBlur={() => void commit(n)}
                    data-testid="subsession-note-text"
                  />
                </div>
              ))}
            </li>
          );
        })}
      </ul>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </section>
  );
}

/** A model's defaults as a sub-session: its efforts, Fast where it has one, the permission level. */
function NoteDefaults({ note, model, onChange }: { note: SubsessionNote; model: ModelOption | undefined; onChange(patch: Partial<Pick<SubsessionNote, "effort" | "fast" | "permission">>): void }) {
  const account = note.model === null;
  return (
    <div className="subsession-defaults" data-testid="subsession-defaults">
      <div className="settings-row">
        <span className="subsession-defaults-label">思考强度{account ? "（默认型号）" : ""}</span>
        {model && model.efforts.length > 0 ? (
          <>
            <EffortBars efforts={model.efforts} value={note.effort && model.efforts.includes(note.effort) ? note.effort : null} fallback={model.defaultEffort} onChange={(effort) => onChange({ effort })} small />
            {note.effort && (
              <button type="button" className="link-btn" onClick={() => onChange({ effort: undefined })}>
                用默认
              </button>
            )}
          </>
        ) : (
          <span className="settings-hint">{model ? "这个型号没有思考强度可选" : "正在读取…"}</span>
        )}
      </div>
      {model?.fast && (
        <label className="settings-row">
          <span className="subsession-defaults-label">Fast</span>
          <input type="checkbox" checked={note.fast === true} onChange={(e) => onChange({ fast: e.currentTarget.checked ? true : undefined })} data-testid="subsession-default-fast" />
          <span className="settings-hint">{model.fast.description ?? "更快的响应速度"}</span>
        </label>
      )}
      <div className="settings-row" role="group" aria-label={`${account ? "整个渠道" : (model?.label ?? "")} 的默认权限`}>
        <span className="subsession-defaults-label">权限</span>
        {LEVELS.map((l) => (
          <button key={l.label} type="button" className="chip small" title={l.hint} aria-pressed={(note.permission ?? null) === l.id} onClick={() => onChange({ permission: l.id ?? undefined })} data-testid="subsession-default-permission">
            {l.label}
          </button>
        ))}
      </div>
    </div>
  );
}
