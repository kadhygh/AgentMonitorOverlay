import { useEffect, useState } from "react";
import type { ModelProfile, SessionOptions, SessionPreset } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { optionsSummary, useProfileChoices } from "../lib/choices.js";
import { pickable, profileLabel } from "../lib/profiles.js";
import { OptionsPicker } from "../chat/OptionsPicker.js";

// 设置 → 常用预设: saved combinations of model profile, 型号, 思考强度 and 权限. They show as chips next to the composer of
// sessions on the same profile (one click switches) and on the new-task page.

export function PresetsSection({ link, presets }: { link: HostLink; presets: readonly SessionPreset[] }) {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [name, setName] = useState("");
  const [profileId, setProfileId] = useState("");
  const [options, setOptions] = useState<SessionOptions>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const { choices } = useProfileChoices(link, profileId || null);

  useEffect(() => {
    call(link, "GET /api/state")
      .then((s) => {
        setProfiles(s.profiles);
        setProfileId((cur) => cur || s.profiles[0]?.id || "");
      })
      .catch(() => undefined);
  }, [link]);

  async function save(next: SessionPreset[], done: string) {
    setBusy(true);
    setMessage(null);
    try {
      await call(link, "PUT /api/settings", {}, { presets: next });
      setMessage({ text: done });
      return true;
    } catch (err) {
      setMessage({ text: err instanceof HostApiError ? err.message : String(err), error: true });
      return false;
    } finally {
      setBusy(false);
    }
  }

  const label = (id: string) => {
    const p = profiles.find((x) => x.id === id);
    return p ? profileLabel(p) : id;
  };

  return (
    <section className="settings-section" aria-label="常用预设">
      <span className="settings-heading">常用预设</span>
      <span className="settings-hint">把常用的「模型 + 型号 + 思考强度 + 权限」存起来，会话输入框旁和新建任务页会显示成按钮，一键切换。</span>
      {presets.length > 0 && (
        <ul className="preset-list">
          {presets.map((p) => (
            <li key={p.id} data-testid="preset-row">
              <span className="preset-name">{p.name}</span>
              <PresetSummary link={link} preset={p} profile={label(p.profileId)} />
              <span className="spacer" />
              <button type="button" className="link-btn" disabled={busy} onClick={() => void save(presets.filter((x) => x.id !== p.id), `已删除预设「${p.name}」`)}>
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="preset-form">
        <div className="settings-row">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="预设名称，例如 GPT 深度思考" aria-label="预设名称" maxLength={40} />
          <select
            className="field"
            value={profileId}
            onChange={(e) => {
              setProfileId(e.target.value);
              setOptions({});
            }}
            aria-label="预设的模型"
          >
            {pickable(profiles, profileId).map((p) => (
              <option key={p.id} value={p.id}>
                {profileLabel(p)}
              </option>
            ))}
          </select>
        </div>
        <OptionsPicker choices={choices} value={options} onChange={setOptions} />
        <div className="settings-row end">
          <button
            type="button"
            className="btn-primary small"
            disabled={busy || !name.trim() || !profileId}
            onClick={() =>
              void save([...presets, { id: "", name: name.trim(), profileId, options }], `已保存预设「${name.trim()}」`).then((ok) => {
                if (ok) {
                  setName("");
                  setOptions({});
                }
              })
            }
          >
            添加预设
          </button>
        </div>
      </div>
      {message && (
        <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"} data-testid="preset-message">
          {message.text}
        </span>
      )}
    </section>
  );
}

/** "Codex · GPT 订阅 · gpt-6.1-sol · 高 · 完全访问", with the profile's own names for the options. */
function PresetSummary({ link, preset, profile }: { link: HostLink; preset: SessionPreset; profile: string }) {
  const { choices } = useProfileChoices(link, preset.profileId);
  return (
    <span className="settings-hint">
      {profile} · {optionsSummary(choices, preset.options)}
    </span>
  );
}
