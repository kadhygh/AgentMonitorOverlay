import { useEffect, useState } from "react";
import { MAX_SUBSESSION_NOTES, SUBSESSION_NOTE_MAX, type StudioSettings, type SubsessionNote } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { modelName, useChoicesFor } from "../lib/choices.js";
import { pickable } from "../lib/profiles.js";
import { useProfiles } from "../lib/balance.js";
import { normalPick } from "../lib/recents.js";
import { Mark } from "../chat/pickers.js";

// 设置 → 子会话 (2026-10-26): per model, the person's note on using it as a sub-session — what it suits, how to brief
// it. The main model reads them in its role card (amo_whoami) and with 「@子会话N」 (@ 开子会话…).

const keyOf = (n: { profileId: string; model: string | null }) => `${n.profileId}/${n.model ?? ""}`;

export function SubsessionPage({ link, settings }: { link: HostLink; settings: StudioSettings | null }) {
  const profiles = useProfiles(link);
  const saved = settings?.subsessionNotes ?? [];
  // Rows being written: what was typed, kept until it is saved (a row added without a note yet lives only here).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<SubsessionNote[]>([]);
  const [profileId, setProfileId] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const visible = profiles ? pickable(profiles) : [];
  useEffect(() => {
    if (!profileId && visible[0]) setProfileId(visible[0].id);
  }, [profileId, visible]);
  const rows = [...saved, ...added.filter((a) => !saved.some((s) => keyOf(s) === keyOf(a)))];
  const choices = useChoicesFor(link, [...new Set([...rows.map((n) => n.profileId), ...(profileId ? [profileId] : [])])]);
  const profile = (id: string) => profiles?.find((p) => p.id === id);
  const nameOf = (n: { profileId: string; model: string | null }) => {
    const models = choices.get(n.profileId)?.models;
    if (n.model) return modelName(models?.find((m) => m.id === n.model)) ?? n.model;
    const d = modelName(models?.find((m) => m.isDefault));
    return d ? `默认（${d}）` : "默认型号";
  };

  async function save(next: SubsessionNote[]) {
    setError(null);
    try {
      await call(link, "PUT /api/settings", {}, { subsessionNotes: next.filter((n) => n.note.trim()) });
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
    if (text === n.note.trim() && saved.some((s) => keyOf(s) === key)) return;
    const next = rows.map((r) => (keyOf(r) === key ? { ...r, note: text } : { ...r, note: textOf(r) }));
    if (await save(next)) {
      setDrafts((d) => {
        const { [key]: _gone, ...rest } = d;
        return rest;
      });
      if (text) setAdded((a) => a.filter((x) => keyOf(x) !== key));
    }
  }
  async function remove(n: SubsessionNote) {
    const key = keyOf(n);
    setAdded((a) => a.filter((x) => keyOf(x) !== key));
    setDrafts(({ [key]: _gone, ...rest }) => rest);
    if (saved.some((s) => keyOf(s) === key)) await save(saved.filter((s) => keyOf(s) !== key));
  }
  function add() {
    const pick = normalPick({ profileId, model: model || null });
    if (rows.some((r) => keyOf(r) === keyOf(pick))) return setError("这个模型已经有说明了，直接改上面那条");
    setError(null);
    setAdded((a) => [...a, { ...pick, note: "" }]);
    setModel("");
  }

  if (!profiles) return <span className="settings-hint">正在读取渠道…</span>;
  const models = choices.get(profileId)?.models ?? [];
  return (
    <section className="settings-section" aria-label="子会话">
      <span className="settings-heading">子会话</span>
      <span className="settings-hint">
        给模型写一段作为子会话时的用法：适合做什么、不适合做什么、怎么交代任务。这些是写给主模型看的：它在 AMO 的身份说明（amo_whoami）里读到，用 @ 开子会话… 选了这个模型时消息里也会带上。每段最多 {SUBSESSION_NOTE_MAX} 字。
      </span>
      {rows.length > 0 && (
        <ul className="subsession-notes" data-testid="subsession-notes">
          {rows.map((n) => (
            <li key={keyOf(n)} className="subsession-note" data-testid="subsession-note">
              <div className="settings-row">
                <Mark profile={profile(n.profileId)} small />
                <span className="quick-name">
                  <b>{nameOf(n)}</b>
                  <span className="channel-sub">{profile(n.profileId)?.label ?? n.profileId}</span>
                </span>
                <button type="button" className="quick-btn" aria-label={`删除 ${nameOf(n)} 的说明`} title="删除" onClick={() => void remove(n)} data-testid="subsession-note-remove">
                  ✕
                </button>
              </div>
              <textarea
                className="side-textarea"
                rows={3}
                maxLength={SUBSESSION_NOTE_MAX}
                aria-label={`${nameOf(n)} 作为子会话的说明`}
                placeholder="例如：便宜、快，适合照详细计划改代码和跑命令；不擅长自己做设计决定。交代时写清改哪些文件、怎么验证。"
                value={textOf(n)}
                onChange={(e) => setDrafts((d) => ({ ...d, [keyOf(n)]: e.target.value }))}
                onBlur={() => void commit(n)}
                data-testid="subsession-note-text"
              />
            </li>
          ))}
        </ul>
      )}
      {rows.length < MAX_SUBSESSION_NOTES && (
        <div className="settings-row">
          <select className="field" value={profileId} onChange={(e) => (setProfileId(e.target.value), setModel(""))} aria-label="子会话说明的渠道" data-testid="subsession-profile">
            {visible.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <select className="field" value={model} onChange={(e) => setModel(e.target.value)} aria-label="子会话说明的型号" data-testid="subsession-model">
            <option value="">
              默认
              {(() => {
                const d = modelName(models.find((m) => m.isDefault));
                return d ? `（${d}）` : "";
              })()}
            </option>
            {models
              .filter((m) => !m.isDefault)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {modelName(m) ?? m.id}
                </option>
              ))}
          </select>
          <button type="button" className="btn-primary small" disabled={!profileId} onClick={add} data-testid="subsession-add">
            添加说明
          </button>
        </div>
      )}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </section>
  );
}
