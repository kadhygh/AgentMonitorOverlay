import { useEffect, useState, type DragEvent } from "react";
import { MAX_QUICK_MODELS, type ModelProfile, type QuickModel, type StudioSettings } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { modelName, useChoicesFor } from "../lib/choices.js";
import { pickable } from "../lib/profiles.js";
import { autoPicks, normalPick, samePick, uniquePicks } from "../lib/recents.js";
import { Mark } from "../chat/pickers.js";

// 设置 → 模型 → 快速选择 (2026-10-15): the model tiles of the new-task page, Quick Start and the new-session form —
// which ones, in which order (Alt 1–6). 2026-10-18: the rows are dragged into order (or Alt ↑ / Alt ↓); without a
// choice the page shows the row as it is now (the models used last, then each channel's default), and any change to
// it — a drag, a removal, an addition — keeps it as the person's own.

const keyOf = (q: QuickModel) => `${q.profileId}/${q.model ?? ""}`;

export function QuickModelsSection({ link, settings, profiles }: { link: HostLink; settings: StudioSettings | null; profiles: readonly ModelProfile[] }) {
  const own = uniquePicks(settings?.quickModels ?? []);
  const visible = pickable(profiles);
  const auto = own.length === 0;
  const list: QuickModel[] = auto ? autoPicks(visible) : own;
  const [profileId, setProfileId] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ key: string; after: boolean } | null>(null);
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
      await call(link, "PUT /api/settings", {}, { quickModels: next.slice(0, MAX_QUICK_MODELS) });
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    }
  }
  function move(from: string, to: string, after: boolean) {
    if (from === to) return;
    const item = list.find((q) => keyOf(q) === from);
    if (!item) return;
    const rest = list.filter((q) => keyOf(q) !== from);
    const at = rest.findIndex((q) => keyOf(q) === to) + (after ? 1 : 0);
    void save([...rest.slice(0, at), item, ...rest.slice(at)]);
  }
  const add = () => {
    const q = normalPick({ profileId, model: model || null });
    if (list.some((x) => samePick(x, q))) return setError("已经在里面了");
    void save([...list, q]);
    setModel("");
  };

  const dropOn = (key: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setOver({ key, after: e.clientY > box.top + box.height / 2 });
    },
    onDragLeave: () => setOver((o) => (o?.key === key ? null : o)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      if (dragging) move(dragging, key, over?.key === key ? over.after : false);
      setDragging(null);
      setOver(null);
    },
  });

  const models = choices.get(profileId)?.models ?? [];
  return (
    <section className="settings-section" aria-label="快速选择">
      <div className="settings-row">
        <span className="settings-heading">快速选择</span>
        {auto && (
          <span className="settings-tag" data-testid="quick-auto">
            自动 · 最近用过的
          </span>
        )}
        <span className="spacer" />
        {!auto && (
          <button type="button" className="btn-ghost small" onClick={() => void save([])} data-testid="quick-reset">
            改回最近用过的
          </button>
        )}
      </div>
      <span className="settings-hint">
        新建任务、快速开始和新会话里那一排模型（Alt 1–{MAX_QUICK_MODELS}），最多 {MAX_QUICK_MODELS} 个。拖动调整顺序（也可以选中一行按 Alt ↑ / Alt ↓）。
        {auto ? "还没设置时自动显示最近用过的组合（同一个渠道的不同型号各占一个），再用渠道的默认型号补满；拖动、移除或添加之后就固定成你的这一排。" : ""}
      </span>
      {list.length > 0 && (
        <ol className="quick-list" data-testid="quick-list">
          {list.map((q, i) => {
            const key = keyOf(q);
            return (
              <li
                key={key}
                tabIndex={0}
                className="quick-row"
                draggable
                data-dragging={dragging === key || undefined}
                data-over={over?.key === key ? (over.after ? "after" : "before") : undefined}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", key);
                  setDragging(key);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  const to = list[i + (e.key === "ArrowUp" ? -1 : 1)];
                  if (to) move(key, keyOf(to), e.key === "ArrowDown");
                }}
                aria-label={`${nameOf(q)}（${profile(q.profileId)?.label ?? q.profileId}），第 ${i + 1} 个`}
                data-testid="quick-row"
                {...dropOn(key)}
              >
                <span className="model-grip" aria-hidden="true">
                  ⋮⋮
                </span>
                <span className="quick-key">Alt {i + 1}</span>
                <Mark profile={profile(q.profileId)} small />
                <span className="quick-name">
                  <b>{nameOf(q)}</b>
                  <span className="channel-sub">{profile(q.profileId)?.label ?? q.profileId}</span>
                </span>
                <button type="button" className="quick-btn" aria-label={`移除 ${nameOf(q)}`} title="移除" onClick={() => void save(list.filter((_, j) => j !== i))} data-testid="quick-remove">
                  ✕
                </button>
              </li>
            );
          })}
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
