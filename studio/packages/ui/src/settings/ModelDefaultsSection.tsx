import { useEffect, useRef, useState, type DragEvent } from "react";
import type { ModelPrefs, ModelProfile, StudioSettings } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { effortLabel, modelName, useProfileChoices } from "../lib/choices.js";
import { profileLabel } from "../lib/profiles.js";

// 设置 → 模型 → 型号顺序和默认: per profile, drag the models into the order every picker shows, mark the one new sessions
// start on, and the default reasoning effort and permissions. Saved at once; the pickers follow.

export function ModelDefaultsSection({ link, settings }: { link: HostLink; settings: StudioSettings | null }) {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const { choices, error: loadError } = useProfileChoices(link, profileId || null);
  const prefs: ModelPrefs = (profileId && settings?.modelPrefs?.[profileId]) || {};
  // What was last saved, ahead of the Host's settings event: saves in quick succession build on each other.
  const latest = useRef<{ profileId: string; prefs: ModelPrefs }>({ profileId, prefs });
  const prefsKey = JSON.stringify(prefs);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the prefs by content
  useEffect(() => void (latest.current = { profileId, prefs }), [profileId, prefsKey]);
  const [order, setOrder] = useState<string[]>([]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call(link, "GET /api/state")
      .then((s) => {
        setProfiles(s.profiles);
        setProfileId((cur) => cur || s.profiles[0]?.id || "");
      })
      .catch(() => undefined);
  }, [link]);
  const listed = choices?.models.map((m) => m.id).join("\n") ?? "";
  // eslint-disable-next-line react-hooks/exhaustive-deps -- follows the list by content
  useEffect(() => setOrder(listed ? listed.split("\n") : []), [listed]);

  async function save(patch: ModelPrefs) {
    if (!profileId) return;
    setError(null);
    const base = latest.current.profileId === profileId ? latest.current.prefs : prefs;
    const next: ModelPrefs = { ...base, ...patch };
    for (const k of Object.keys(next) as Array<keyof ModelPrefs>) if (next[k] === undefined || next[k] === "") delete next[k];
    latest.current = { profileId, prefs: next };
    try {
      await call(link, "PUT /api/settings", {}, { modelPrefs: { [profileId]: Object.keys(next).length ? next : null } });
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    }
  }

  function move(id: string, to: string, after: boolean) {
    if (id === to) return;
    const rest = order.filter((x) => x !== id);
    const at = rest.indexOf(to) + (after ? 1 : 0);
    const next = [...rest.slice(0, at), id, ...rest.slice(at)];
    setOrder(next);
    void save({ order: next });
  }

  const models = order.flatMap((id) => choices?.models.find((m) => m.id === id) ?? []);
  const defaultId = choices?.models.find((m) => m.isDefault)?.id ?? null;
  const efforts = [...new Set(choices?.models.flatMap((m) => m.efforts) ?? [])];

  const dropOn = (id: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!dragging) return;
      e.preventDefault();
      const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setOver({ id, after: e.clientY > box.top + box.height / 2 });
    },
    onDragLeave: () => setOver((o) => (o?.id === id ? null : o)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      if (dragging) move(dragging, id, over?.id === id ? over.after : false);
      setDragging(null);
      setOver(null);
    },
  });

  return (
    <section className="settings-section" aria-label="型号顺序和默认">
      <span className="settings-heading">型号顺序和默认</span>
      <span className="settings-hint">拖动调整各处列出的顺序（也可以选中一行按 Alt ↑ / Alt ↓）；点「默认」决定新会话没选型号时用哪个。思考强度和权限的默认同样只影响之后新开的会话。</span>
      <div className="settings-row">
        <span className="settings-label">模型</span>
        <select className="field" value={profileId} onChange={(e) => setProfileId(e.target.value)} aria-label="要设置的模型">
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {profileLabel(p)}
            </option>
          ))}
        </select>
      </div>
      {loadError && <span className="form-error">{loadError}</span>}
      {!choices && !loadError && <span className="settings-hint">正在读取可选型号…</span>}
      {choices && (
        <>
          <div className="model-order" role="list" aria-label="型号顺序" data-testid="model-order">
            {models.map((m, i) => (
              <div
                key={m.id}
                role="listitem"
                tabIndex={0}
                className="model-order-row"
                data-dragging={dragging === m.id || undefined}
                data-over={over?.id === m.id ? (over.after ? "after" : "before") : undefined}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", m.id);
                  setDragging(m.id);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  const to = models[i + (e.key === "ArrowUp" ? -1 : 1)];
                  if (to) move(m.id, to.id, e.key === "ArrowDown");
                }}
                aria-label={`${modelName(m)}，第 ${i + 1} 个${m.id === defaultId ? "，默认" : ""}`}
                data-testid="model-order-row"
                {...dropOn(m.id)}
              >
                <span className="model-grip" aria-hidden="true">
                  ⋮⋮
                </span>
                <span className="model-order-name">{modelName(m)}</span>
                {m.description && <span className="model-order-desc">{m.description}</span>}
                <button
                  type="button"
                  className="model-default"
                  aria-pressed={m.id === defaultId}
                  onClick={() => void save({ model: m.id })}
                  title={m.id === defaultId ? "新会话默认用这个" : "设为默认"}
                >
                  {m.id === defaultId ? "默认" : "设为默认"}
                </button>
              </div>
            ))}
          </div>
          {efforts.length > 0 && (
            <div className="settings-row">
              <span className="settings-label">默认思考强度</span>
              <select className="field" value={prefs.effort ?? ""} onChange={(e) => void save({ effort: e.target.value || undefined })} aria-label="默认思考强度">
                <option value="">跟随型号自己的默认</option>
                {efforts.map((x) => (
                  <option key={x} value={x}>
                    {effortLabel(x)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="settings-row">
            <span className="settings-label">默认权限</span>
            <select className="field" value={prefs.permission ?? ""} onChange={(e) => void save({ permission: e.target.value || undefined })} aria-label="默认权限">
              <option value="">跟随 CLI 的默认</option>
              {choices.permissions.map((p) => (
                <option key={p.id} value={p.id} disabled={!!p.unavailable}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          {(prefs.order || prefs.model || prefs.effort || prefs.permission) && (
            <div className="settings-row end">
              <button type="button" className="btn-ghost small" onClick={() => void call(link, "PUT /api/settings", {}, { modelPrefs: { [profileId]: null } }).catch((err: unknown) => setError(String(err)))}>
                恢复 CLI 的顺序和默认
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </section>
  );
}
