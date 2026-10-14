import { useEffect, useRef, type MouseEvent } from "react";
import type { ModelOption, ModelProfile, PermissionOption, ProfileChoices } from "@amo-studio/protocol";
import { effortLabel, modelName } from "../lib/choices.js";

// One-click choosers for 型号 / 思考强度 / 权限 (design/ui-directions/new-task.html), shared by the new-task page, the
// quick bar and the session composer. No dropdowns: everything that can be picked is on screen.

/** The account behind a profile, as a two-letter mark with its own tone. */
export function profileMark(p: ModelProfile | undefined): { text: string; tone: string } {
  const key = `${p?.id ?? ""} ${p?.provider ?? ""} ${p?.label ?? ""}`.toLowerCase();
  if (key.includes("mock")) return { text: "M", tone: "mock" };
  if (key.includes("deepseek")) return { text: "DS", tone: "ds" };
  if (key.includes("glm")) return { text: "Z", tone: "glm" };
  if (p?.runtime === "claude") return { text: "C", tone: "cl" };
  return { text: "G", tone: "gpt" };
}

export function Mark({ profile, small = false }: { profile: ModelProfile | undefined; small?: boolean }) {
  const m = profileMark(profile);
  return (
    <span className={`mark mark-${m.tone}${small ? " small" : ""}`} aria-hidden="true">
      {m.text}
    </span>
  );
}

/** What a tile says: the model's name when one is picked (its account below), else the profile's own name. */
export function pickLabel(profile: ModelProfile | undefined, model: string | null, models?: readonly ModelOption[]): { main: string; sub: string | null } {
  if (!profile) return { main: "未知模型", sub: null };
  if (!model) return { main: profile.label, sub: null };
  return { main: modelName(models?.find((m) => m.id === model)) ?? model, sub: profile.label };
}

export function ModelTile({
  profile,
  label,
  pressed,
  disabled,
  small = false,
  shortcut,
  onClick,
  onContextMenu,
}: {
  profile: ModelProfile | undefined;
  label: { main: string; sub: string | null };
  pressed: boolean;
  disabled?: boolean;
  small?: boolean;
  /** Shown as a hint, e.g. "Alt 1". */
  shortcut?: string;
  onClick(): void;
  /** Right click: the account's models in a small menu. */
  onContextMenu?(e: MouseEvent<HTMLButtonElement>): void;
}) {
  return (
    <button
      type="button"
      className={small ? "mtile small" : "mtile"}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      {...(onContextMenu ? { onContextMenu } : {})}
      title={[label.sub ? `${label.sub} · ${label.main}` : label.main, shortcut, onContextMenu ? "右键选具体型号" : ""].filter(Boolean).join(" · ")}
      data-testid="model-tile"
    >
      <Mark profile={profile} small={small} />
      <span className="mtile-main">{label.main}</span>
      {label.sub && !small && <span className="mtile-sub">{label.sub}</span>}
    </button>
  );
}

/**
 * Reasoning effort as bars, one per level the model takes; click a bar to set it. `value` null: the model's default
 * (shown, but not chosen).
 */
export function EffortBars({
  efforts,
  value,
  fallback,
  onChange,
  disabled,
  small = false,
  showCaption = true,
}: {
  efforts: readonly string[];
  value: string | null;
  fallback?: string | undefined;
  onChange(effort: string): void;
  disabled?: boolean;
  small?: boolean;
  showCaption?: boolean;
}) {
  const current = value ?? fallback ?? null;
  const index = current ? efforts.indexOf(current) : -1;
  const n = efforts.length;
  // The wheel over the bars steps the effort (up: more). A native listener, so the page does not scroll meanwhile.
  const box = useRef<HTMLSpanElement>(null);
  const latest = useRef({ efforts, index, onChange, disabled });
  latest.current = { efforts, index, onChange, disabled };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const { efforts: list, index: i, onChange: change, disabled: off } = latest.current;
      if (off || !list.length || e.deltaY === 0) return;
      e.preventDefault();
      const next = Math.min(list.length - 1, Math.max(0, (i < 0 ? 0 : i) + (e.deltaY < 0 ? 1 : -1)));
      if (next !== i) change(list[next]!);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [n > 0]);
  if (!efforts.length) return null;
  return (
    <span ref={box} className={small ? "effort small" : "effort"} role="group" aria-label="思考强度" title="点竖条或滚动鼠标滚轮调整" data-testid="effort">
      {showCaption && !small && <span className="effort-cap">思考</span>}
      <span className="effort-bars">
        {efforts.map((e, i) => (
          <button
            key={e}
            type="button"
            className={i <= index ? "on" : undefined}
            style={{ height: `${30 + Math.round((70 * (i + 1)) / n)}%` }}
            aria-label={effortLabel(e)}
            aria-pressed={i === index}
            disabled={disabled}
            title={effortLabel(e)}
            onClick={() => onChange(e)}
          />
        ))}
      </span>
      <span className="effort-label" data-testid="effort-label">
        {current ? effortLabel(current) : "默认"}
      </span>
    </span>
  );
}

/**
 * 「Fast」 (stage 13): the model's fast speed tier, on or off. Only for models that have one (GPT through the Codex
 * login); Codex's own note on it ("2x speed, increased usage") is the tooltip. Off when never chosen.
 */
export function FastToggle({
  fast,
  value,
  onChange,
  disabled,
  small = false,
  when,
}: {
  fast: ModelOption["fast"];
  value: boolean | undefined;
  onChange(on: boolean): void;
  disabled?: boolean;
  small?: boolean;
  /** "下一轮生效" and the like, added to the tooltip. */
  when?: string;
}) {
  if (!fast) return null;
  const on = value === true;
  const note = fast.description ? `Codex：${fast.description}` : "更快的响应速度";
  return (
    <button
      type="button"
      className={small ? "fast-toggle small" : "fast-toggle"}
      aria-pressed={on}
      disabled={disabled}
      title={`Fast ${on ? "已开" : "已关"}：${note}${when ? `。${when}` : ""}`}
      onClick={() => onChange(!on)}
      data-testid="fast-toggle"
    >
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
        <path d="M7 1 2.5 7H6l-1 4 4.5-6H6z" fill="currentColor" />
      </svg>
      Fast
    </button>
  );
}

/** The next effort up (wrapping), for Alt+E. */
export function nextEffort(efforts: readonly string[], current: string | null | undefined): string | undefined {
  if (!efforts.length) return undefined;
  const i = current ? efforts.indexOf(current) : -1;
  return efforts[(i + 1) % efforts.length];
}

/** Settings that let commands run without asking: marked, so they are never picked by accident. */
export const RISKY_PERMISSIONS = new Set(["full-auto", "bypassPermissions"]);

/** The four most used first, the rest behind "更多" (Codex has six). */
const PERMISSION_ORDER = ["ask", "default", "auto-review", "acceptEdits", "workspace-write", "plan", "full-auto", "bypassPermissions"];

function orderedPermissions(permissions: readonly PermissionOption[]): PermissionOption[] {
  const rank = (p: PermissionOption) => {
    const i = PERMISSION_ORDER.indexOf(p.id);
    return i === -1 ? PERMISSION_ORDER.length : i;
  };
  return [...permissions].sort((a, b) => rank(a) - rank(b));
}

export function PermissionSegments({
  choices,
  value,
  onChange,
  disabled,
  expanded,
  onExpand,
}: {
  choices: ProfileChoices;
  value: string | null;
  onChange(permission: string): void;
  disabled?: boolean;
  /** Show every setting instead of the first four. */
  expanded?: boolean;
  onExpand?(): void;
}) {
  const all = orderedPermissions(choices.permissions);
  const current = value ?? choices.defaultPermission;
  // The current one always shows, even when it sits behind "更多".
  const shown = expanded ? all : all.filter((p, i) => i < 4 || p.id === current);
  return (
    <span className="perm" role="group" aria-label="权限" data-testid="permissions">
      {shown.map((p) => (
        <button
          key={p.id}
          type="button"
          className={RISKY_PERMISSIONS.has(p.id) ? "risky" : undefined}
          aria-pressed={p.id === current}
          disabled={disabled || !!p.unavailable}
          title={p.unavailable ?? p.description}
          onClick={() => onChange(p.id)}
        >
          {p.label}
        </button>
      ))}
      {!expanded && shown.length < all.length && onExpand && (
        <button type="button" className="more" onClick={onExpand} title="更多权限设置">
          更多
        </button>
      )}
    </span>
  );
}

/** One line each for the tiles (the full description stays in the tooltip). */
const SHORT: Record<string, string> = {
  ask: "每条命令都先问你",
  "auto-review": "交给审查 agent，拿不准再问你",
  "on-request": "agent 觉得有风险时才问",
  "full-auto": "不再询问，命令直接执行",
  "workspace-write": "沙箱里只能改这个项目",
  "read-only": "沙箱里只读，要改时询问",
  default: "改文件、运行命令前都先问",
  acceptEdits: "改文件不问，运行命令仍问",
  plan: "只读代码、给出计划",
  bypassPermissions: "所有操作都不再询问",
};

/** Larger permission tiles with a one-line description, for the session tray. */
export function PermissionTiles({ choices, value, onChange, disabled }: { choices: ProfileChoices; value: string | null; onChange(id: string): void; disabled?: boolean }) {
  const current = value ?? choices.defaultPermission;
  return (
    <div className="tray-row" role="group" aria-label="权限">
      {orderedPermissions(choices.permissions).map((p) => (
        <button
          key={p.id}
          type="button"
          className={RISKY_PERMISSIONS.has(p.id) ? "ptile risky" : "ptile"}
          aria-pressed={p.id === current}
          disabled={disabled || !!p.unavailable}
          title={p.unavailable ?? p.description}
          onClick={() => onChange(p.id)}
        >
          <b>{p.label}</b>
          <span>{p.unavailable ?? SHORT[p.id] ?? p.description}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Right-click menu on a model tile: the account's own models, one click each (the tile's account stays). Closes on
 * a pick, Escape or a click elsewhere.
 */
export function ModelMenu({
  x,
  y,
  profile,
  models,
  current,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  profile: ModelProfile | undefined;
  /** null while the list is loading. */
  models: readonly ModelOption[] | null;
  /** The model picked now (null: the account's default; undefined: this account is not the one picked). */
  current: string | null | undefined;
  onPick(model: ModelOption): void;
  onClose(): void;
}) {
  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element | null)?.closest?.(".model-menu")) onClose();
    };
    window.addEventListener("keydown", close);
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  // Keep the menu on screen.
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.min(y, window.innerHeight - 40 - (models?.length ?? 1) * 32);
  return (
    <div className="model-menu ctx-menu" role="menu" aria-label={`${profile?.label ?? "模型"} 的型号`} style={{ left, top }} data-testid="model-menu">
      <span className="model-menu-h">
        <Mark profile={profile} small />
        {profile?.label ?? "模型"}
      </span>
      {models === null && <span className="model-menu-note">正在读取…</span>}
      {models?.map((m) => {
        const on = current !== undefined && (current === m.id || (current === null && !!m.isDefault));
        return (
          <button key={m.id} type="button" role="menuitemradio" aria-checked={on} title={m.description} onClick={() => onPick(m)}>
            <span className="model-menu-check">{on ? "✓" : ""}</span>
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
