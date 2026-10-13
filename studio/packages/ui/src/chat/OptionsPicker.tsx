import type { ProfileChoices, SessionOptions } from "@amo-studio/protocol";
import { activeModel, defaultModel, effortLabel } from "../lib/choices.js";

// 型号 / 思考强度 / 权限 for one profile, as its CLI offers them. Empty values mean the profile's defaults.

export function OptionsPicker({
  choices,
  value,
  onChange,
  disabled,
  layout = "row",
}: {
  choices: ProfileChoices | null;
  value: SessionOptions;
  onChange(next: SessionOptions): void;
  disabled?: boolean;
  /** "stack" for narrow columns. */
  layout?: "row" | "stack";
}) {
  if (!choices) return <span className="options-loading">正在读取可选模型…</span>;
  const model = activeModel(choices, value);
  const fallback = defaultModel(choices);
  const efforts = model?.efforts ?? [];
  const permissionDefault = choices.permissions.find((p) => p.id === choices.defaultPermission);
  const set = (patch: Partial<Record<keyof SessionOptions, string>>) => {
    const next: SessionOptions = { ...value };
    for (const [k, v] of Object.entries(patch) as Array<[keyof SessionOptions, string]>) {
      if (v) next[k] = v;
      else delete next[k];
    }
    // An effort the newly chosen model does not take falls back to that model's default.
    if (patch.model !== undefined && next.effort) {
      const m = activeModel(choices, next);
      if (m && !m.efforts.includes(next.effort)) delete next.effort;
    }
    onChange(next);
  };
  return (
    <div className={`options-picker ${layout}`} data-testid="options-picker">
      <label className="inline-field">
        型号
        <select value={value.model ?? ""} disabled={disabled} onChange={(e) => set({ model: e.target.value })}>
          <option value="">默认{fallback ? `（${fallback.label}）` : ""}</option>
          {choices.models.map((m) => (
            <option key={m.id} value={m.id} title={m.description}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label className="inline-field">
        思考强度
        <select value={value.effort ?? ""} disabled={disabled || efforts.length === 0} onChange={(e) => set({ effort: e.target.value })}>
          <option value="">默认{model?.defaultEffort ? `（${effortLabel(model.defaultEffort)}）` : ""}</option>
          {efforts.map((e) => (
            <option key={e} value={e}>
              {effortLabel(e)}
            </option>
          ))}
        </select>
      </label>
      <label className="inline-field">
        权限
        <select value={value.permission ?? ""} disabled={disabled} onChange={(e) => set({ permission: e.target.value })}>
          <option value="">默认{permissionDefault ? `（${permissionDefault.label}）` : ""}</option>
          {choices.permissions.map((p) => (
            <option key={p.id} value={p.id} disabled={!!p.unavailable} title={p.unavailable ?? p.description}>
              {p.label}
              {p.unavailable ? "（此机器不可用）" : ""}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
