import { useState } from "react";
import type { ModelProfile, PresetDraft } from "@amo-studio/protocol";
import { defaultProfile, pickable, profileLabel } from "../lib/profiles.js";

/**
 * A pack's session preset, filled in, for the person to check before anything is sent: the prompt comes from project
 * files (maybe someone else's), so it is shown and editable, with the model and any warnings. "开始" creates the session.
 */
export function PresetDraftForm({
  draft,
  profiles,
  workspaceName,
  busy,
  onStart,
  onCancel,
}: {
  draft: PresetDraft;
  profiles: readonly ModelProfile[];
  /** Shown for cross-workspace tasks: where the session will run. */
  workspaceName?: string;
  busy: boolean;
  onStart(input: { profileId: string; text: string }): void;
  onCancel(): void;
}) {
  const [profileId, setProfileId] = useState(draft.profileId ?? defaultProfile(profiles)?.id ?? "");
  const [text, setText] = useState(draft.text);
  return (
    <div className="preset-draft" data-testid="preset-draft" role="dialog" aria-label="按预设新建会话">
      <div className="anno-head">
        <span className="anno-title">按预设新建会话：{draft.title}</span>
        {workspaceName && <span className="pack-path">在 {workspaceName}</span>}
      </div>
      <span className="pack-item-sub">提示词来自工程里的扩展包，发出前请看一遍，可以直接修改。</span>
      {draft.warnings.length > 0 && (
        <ul className="pack-problems" data-testid="preset-warnings">
          {draft.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <textarea className="preset-text" value={text} onChange={(e) => setText(e.target.value)} rows={8} aria-label="预设提示词" />
      <div className="composer-bar">
        <label className="inline-field">
          模型
          <select value={profileId} onChange={(e) => setProfileId(e.target.value)} aria-label="预设模型">
            {pickable(profiles, profileId).map((p) => (
              <option key={p.id} value={p.id}>
                {profileLabel(p)}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <button type="button" className="btn-ghost" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="button" className="btn-primary" onClick={() => onStart({ profileId, text: text.trim() })} disabled={busy || !profileId || !text.trim()}>
          开始
        </button>
      </div>
    </div>
  );
}
