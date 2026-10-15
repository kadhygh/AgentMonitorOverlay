import { useEffect, useState } from "react";
import { MAX_QUICK_MODELS, type ModelProfile, type QuickModel, type StudioSettings } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { modelName, useChoicesFor } from "../lib/choices.js";
import { pickable } from "../lib/profiles.js";
import { Mark } from "../chat/pickers.js";

// 设置 → 模型 → 快速选择 (2026-10-15): the model tiles of the new-task page, Quick Start and the new-session form —
// which ones, in which order (Alt 1–6). Without a choice the row shows the models used last.

export function QuickModelsSection({ link, settings, profiles }: { link: HostLink; settings: StudioSettings | null; profiles: readonly ModelProfile[] }) {
  const list = settings?.quickModels ?? [];
  const visible = pickable(profiles);
  const [profileId, setProfileId] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!profileId && visible[0]) setProfileId(visible[0].id);
  }, [profileId, visible]);
  const choices = useChoicesFor(link, [...new Set([...list.map((q) => q.profileId), ...(profileId ? [profileId] : [])])]);
  const profile = (id: string) => profiles.find((p) => p.id === id);
  const nameOf = (q: QuickModel) => {
    const models = choices.get(q.profileId)?.models;
    if (q.model) return modelName(models?.find((m) => m.id === q.model)) ?? q.model;
    const d = modelName(models?.find((m) => m.isDefault));
    return d ? `默认（${d}）` : "默认";
  };

  async function save(next: QuickModel[]) {
    setError(null);
    try {
      await call(link, "PUT /api/settings", {}, { quickModels: next });
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    }
  }
  const move = (i: number, d: -1 | 1) => {
    const next = [...list];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x!);
    void save(next);
  };
  const add = () => {
    const q = { profileId, model: model || null };
    if (list.some((x) => x.profileId === q.profileId && x.model === q.model)) return setError("已经在里面了");
    void save([...list, q]);
    setModel("");
  };

  const models = choices.get(profileId)?.models ?? [];
  return (
    <section className="settings-section" aria-label="快速选择">
      <div className="settings-row">
        <span className="settings-heading">快速选择</span>
        <span className="spacer" />
        {list.length > 0 && (
          <button type="button" className="btn-ghost small" onClick={() => void save([])} data-testid="quick-reset">
            改回最近用过的
          </button>
        )}
      </div>
      <span className="settings-hint">
        新建任务、快速开始和新会话里那一排模型按这里的顺序显示（Alt 1–{MAX_QUICK_MODELS}），最多 {MAX_QUICK_MODELS} 个。没设置时显示最近用过的。
      </span>
      {list.length > 0 && (
        <ol className="quick-list" data-testid="quick-list">
          {list.map((q, i) => (
            <li key={`${q.profileId}/${q.model ?? ""}`} className="quick-row" data-testid="quick-row">
              <span className="quick-key">Alt {i + 1}</span>
              <Mark profile={profile(q.profileId)} small />
              <span className="quick-name">
                <b>{nameOf(q)}</b>
                <span className="channel-sub">{profile(q.profileId)?.label ?? q.profileId}</span>
              </span>
              <button type="button" className="quick-btn" aria-label="上移" title="上移" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" className="quick-btn" aria-label="下移" title="下移" disabled={i === list.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button type="button" className="quick-btn" aria-label={`移除 ${nameOf(q)}`} title="移除" onClick={() => void save(list.filter((_, j) => j !== i))} data-testid="quick-remove">
                ✕
              </button>
            </li>
          ))}
        </ol>
      )}
      {list.length < MAX_QUICK_MODELS && (
        <div className="settings-row">
          <select className="field" value={profileId} onChange={(e) => (setProfileId(e.target.value), setModel(""))} aria-label="快速选择的渠道" data-testid="quick-profile">
            {visible.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <select className="field" value={model} onChange={(e) => setModel(e.target.value)} aria-label="快速选择的型号" data-testid="quick-model">
            <option value="">默认{(() => {
              const d = modelName(models.find((m) => m.isDefault));
              return d ? `（${d}）` : "";
            })()}</option>
            {models
              .filter((m) => !m.isDefault)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {modelName(m) ?? m.id}
                </option>
              ))}
          </select>
          <button type="button" className="btn-primary small" disabled={!profileId} onClick={add} data-testid="quick-add">
            添加
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
