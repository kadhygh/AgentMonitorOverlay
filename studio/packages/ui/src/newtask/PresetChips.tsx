import type { ModelProfile, SessionOptions, SessionPreset } from "@amo-studio/protocol";
import { sameOptions } from "../lib/choices.js";
import { samePick, type ModelPick } from "../lib/recents.js";

/**
 * 常用预设: one click sets the model and its options. Shared by the new-task page and the 新会话 dialog (2026-11-17: the
 * same choices wherever a session is set up).
 */
export function PresetChips({ presets, profiles, pick, options, onPick }: { presets: readonly SessionPreset[]; profiles: readonly ModelProfile[]; pick: ModelPick; options: Omit<SessionOptions, "model">; onPick(pick: ModelPick, options: Omit<SessionOptions, "model">): void }) {
  const shown = presets.filter((p) => profiles.some((x) => x.id === p.profileId && !x.hidden && !x.unavailable));
  if (!shown.length) return null;
  return (
    <div className="cbar presets" role="group" aria-label="常用预设">
      <span className="pick-lab">预设</span>
      {shown.map((p) => {
        const next = { profileId: p.profileId, model: p.options.model ?? null };
        const { model: _model, ...rest } = p.options;
        const active = samePick(next, pick) && sameOptions(rest, options);
        return (
          <button key={p.id} type="button" className="chip small" aria-pressed={active} onClick={() => onPick(next, rest)} data-testid="preset-chip">
            {p.name}
          </button>
        );
      })}
    </div>
  );
}
