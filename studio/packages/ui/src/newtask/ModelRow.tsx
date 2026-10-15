import { useState } from "react";
import type { ModelProfile } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { useChoicesFor } from "../lib/choices.js";
import { commonPicks, samePick, tileCount, type ModelPick } from "../lib/recents.js";
import { pickable } from "../lib/profiles.js";
import { Mark, ModelMenu, ModelTile, pickLabel } from "../chat/pickers.js";

/** The 常用 tiles: recent picks first; the current pick always among them. */
export function tilePicks(profiles: readonly ModelProfile[], current: ModelPick, count = tileCount()): ModelPick[] {
  const picks = commonPicks(pickable(profiles, current.profileId), count);
  if (current.profileId && !picks.some((p) => samePick(p, current))) picks.splice(Math.max(picks.length - 1, 0), 1, current);
  return picks;
}

/** One row of model tiles (Alt 1–4) and, when asked, a drawer with every model of every account. */
export function ModelRow({
  link,
  profiles,
  pick,
  onPick,
  drawer,
  onToggleDrawer,
  small = false,
}: {
  link: HostLink;
  profiles: readonly ModelProfile[];
  pick: ModelPick;
  onPick(pick: ModelPick): void;
  drawer: boolean;
  onToggleDrawer?: () => void;
  small?: boolean;
}) {
  const tiles = tilePicks(profiles, pick);
  const [menu, setMenu] = useState<{ x: number; y: number; profileId: string } | null>(null);
  // Model names for tiles that name a model, every model when the drawer is open, and the right-clicked account's.
  const choices = useChoicesFor(link, [
    // Every tile's profile: a tile without a model shows the profile's default model by name.
    ...(drawer ? pickable(profiles, pick.profileId).map((p) => p.id) : tiles.map((t) => t.profileId)),
    ...(menu ? [menu.profileId] : []),
  ]);
  const profile = (id: string) => profiles.find((p) => p.id === id);
  return (
    <>
      <div className="model-row" role="group" aria-label="模型">
        {tiles.map((t, i) => (
          <ModelTile
            key={`${t.profileId}/${t.model ?? ""}`}
            profile={profile(t.profileId)}
            label={pickLabel(profile(t.profileId), t.model, choices.get(t.profileId)?.models)}
            pressed={samePick(t, pick)}
            small={small}
            shortcut={`Alt ${i + 1}`}
            onClick={() => onPick(t)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, profileId: t.profileId });
            }}
          />
        ))}
        {onToggleDrawer && (
          <button type="button" className="more-models" aria-expanded={drawer} onClick={onToggleDrawer} data-testid="all-models">
            {drawer ? "收起" : "全部型号"}
          </button>
        )}
      </div>
      {menu && (
        <ModelMenu
          x={menu.x}
          y={menu.y}
          profile={profile(menu.profileId)}
          models={choices.get(menu.profileId)?.models ?? (choices.has(menu.profileId) ? [] : null)}
          current={pick.profileId === menu.profileId ? pick.model : undefined}
          onPick={(m) => {
            onPick({ profileId: menu.profileId, model: m.isDefault ? null : m.id });
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {drawer && (
        <div className="model-drawer" data-testid="model-drawer">
          {pickable(profiles, pick.profileId).map((p) => {
            const c = choices.get(p.id);
            return (
              <div className="drawer-row" key={p.id} role="group" aria-label={p.label}>
                <span className="drawer-acct">
                  <Mark profile={p} small />
                  {p.label}
                </span>
                {c === undefined && <span className="drawer-note">正在读取…</span>}
                {c === null && (
                  <button type="button" className="chip small" aria-pressed={samePick(pick, { profileId: p.id, model: null })} onClick={() => onPick({ profileId: p.id, model: null })}>
                    默认
                  </button>
                )}
                {c?.models.map((m) => {
                  const pressed = pick.profileId === p.id && (pick.model === m.id || (pick.model === null && !!m.isDefault));
                  return (
                    <button key={m.id} type="button" className="chip small" aria-pressed={pressed} title={m.description} onClick={() => onPick({ profileId: p.id, model: m.isDefault ? null : m.id })}>
                      {m.label}
                    </button>
                  );
                })}
              </div>
            );
          })}
          <span className="drawer-note">常用的四个按最近用过的排在最前；在 设置 → 常用预设 里可以存下整套组合。</span>
        </div>
      )}
    </>
  );
}
