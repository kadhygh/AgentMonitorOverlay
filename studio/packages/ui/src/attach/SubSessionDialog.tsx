import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ModelProfile, Session, SubsessionNote } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { activeModel, useProfileChoices } from "../lib/choices.js";
import { normalPick, type ModelPick } from "../lib/recents.js";
import { EffortBars, pickLabel } from "../chat/pickers.js";
import { ModelRow } from "../newtask/ModelRow.js";
import { subSessionArgs, type SubSessionSpec } from "./mentions.js";

// 开子会话… (2026-10-26): from the composer's @ list, how the model is to start sub-sessions — model, effort,
// permission, whether their results come back. Confirmed, the composer gets「@子会话N」 and the message says what it means.

type Level = NonNullable<SubSessionSpec["permission"]>;
const LEVELS: Array<{ id: Level | null; label: string; hint: string }> = [
  { id: null, label: "默认", hint: "那个模型的默认权限（常常是沙箱）" },
  { id: "read-only", label: "只读", hint: "只看不改" },
  { id: "write", label: "可写", hint: "能改它的文件夹，越界要问" },
  { id: "full", label: "完全放开", hint: "不用沙箱、不用审批，适合连续跑很多命令" },
];

/**
 * The last model, permission and report, offered again next time (this window only). Not the effort (2026-10-26): it
 * starts from the model's default in 设置 → 模型 each time, as everywhere else.
 */
const KEY = "amo.subsessionSetup";
interface Remembered {
  pick: ModelPick;
  permission?: Level;
  report: boolean;
}
function readRemembered(): Remembered | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? "null") as Remembered | null;
    return r && typeof r.pick?.profileId === "string" ? r : null;
  } catch {
    return null;
  }
}
function remember(r: Remembered): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    // only a convenience
  }
}

export function SubSessionDialog({
  link,
  profiles,
  session,
  notes = [],
  onDone,
}: {
  link: HostLink;
  profiles: readonly ModelProfile[];
  /** 设置 → 子会话: the person's notes on models as sub-sessions; the chosen model's goes with the setup. */
  notes?: readonly SubsessionNote[];
  /** The session the composer writes to: its model is the first choice. */
  session: Session;
  /** The setup, or null when cancelled. */
  onDone(spec: SubSessionSpec | null): void;
}) {
  const last = readRemembered();
  const lastOk = !!last && profiles.some((p) => p.id === last.pick.profileId && !p.hidden);
  const [pick, setPick] = useState<ModelPick>(() => (lastOk ? last!.pick : normalPick({ profileId: session.profileId, model: session.options.model ?? null })));
  const [effort, setEffort] = useState<string | undefined>(undefined);
  const [permission, setPermission] = useState<Level | undefined>(lastOk ? last!.permission : undefined);
  const [report, setReport] = useState(lastOk ? last!.report : true);
  const [drawer, setDrawer] = useState(false);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => confirm.current?.focus(), []);

  const { choices } = useProfileChoices(link, pick.profileId);
  const model = choices ? activeModel(choices, pick.model ? { model: pick.model } : {}) : undefined;
  // An effort the newly picked model does not take is dropped (its default applies).
  const chosenEffort = effort && model?.efforts.includes(effort) ? effort : undefined;
  const profile = profiles.find((p) => p.id === pick.profileId);
  const picked = normalPick(pick);
  // The model's own note, else the channel's (「整个渠道」).
  const own = notes.find((n) => n.profileId === picked.profileId && (n.model ?? null) === picked.model);
  const note = (own ?? notes.find((n) => n.profileId === picked.profileId && n.model === null))?.note;
  const spec: SubSessionSpec | null = profile
    ? {
        model: pick.model ? `${profile.label}/${pick.model}` : profile.label,
        modelName: pickLabel(profile, pick.model, choices?.models).main,
        ...(chosenEffort ? { effort: chosenEffort } : {}),
        ...(permission ? { permission } : {}),
        report,
        ...(note ? { note } : {}),
      }
    : null;

  const done = () => {
    if (!spec) return;
    remember({ pick, ...(permission ? { permission } : {}), report });
    onDone(spec);
  };

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onDone(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onDone(null);
        }
      }}
    >
      <div className="modal subsession-modal" role="dialog" aria-modal="true" aria-labelledby="subsession-title" data-testid="subsession-dialog">
        <span className="modal-title" id="subsession-title">
          开子会话
        </span>
        <span className="settings-hint">在输入框里放一个「@子会话N」，发出去时告诉模型：开子会话要用 AMO 的 session_start，带这些设置。什么时候开、做什么，你在消息里说。</span>
        <div className="subsession-field">
          <span className="settings-label">模型</span>
          <ModelRow link={link} profiles={profiles} pick={pick} onPick={setPick} drawer={drawer} onToggleDrawer={() => setDrawer(!drawer)} small />
        </div>
        <div className="subsession-field">
          <span className="settings-label">思考强度</span>
          {model && model.efforts.length > 0 ? (
            <EffortBars efforts={model.efforts} value={chosenEffort ?? null} fallback={model.defaultEffort} onChange={setEffort} small />
          ) : (
            <span className="settings-hint">{choices ? "这个模型没有思考强度可选" : "正在读取…"}</span>
          )}
          {chosenEffort && (
            <button type="button" className="link-btn" onClick={() => setEffort(undefined)}>
              用默认
            </button>
          )}
        </div>
        <div className="subsession-field">
          <span className="settings-label">权限</span>
          <div className="settings-row" role="group" aria-label="权限">
            {LEVELS.map((l) => (
              <button key={l.label} type="button" className="chip small" title={l.hint} aria-pressed={(permission ?? null) === l.id} onClick={() => setPermission(l.id ?? undefined)}>
                {l.label}
              </button>
            ))}
          </div>
        </div>
        <label className="settings-row feature-row">
          <input type="checkbox" checked={report} onChange={(e) => setReport(e.currentTarget.checked)} data-testid="subsession-report" />
          <span className="feature-text">
            <span>结果回到这个对话</span>
            <span className="settings-hint">子会话每一轮做完，它的回复会作为消息回来（被停下、出错也会说）</span>
          </span>
        </label>
        {note && (
          <span className="settings-hint" data-testid="subsession-note">
            你在 设置 → 子会话 写的说明会一起带上：{note}
          </span>
        )}
        {spec && (
          <span className="subsession-preview" data-testid="subsession-preview">
            {subSessionArgs(spec)}
          </span>
        )}
        <div className="settings-row end">
          <button type="button" className="btn-ghost small" onClick={() => onDone(null)}>
            取消
          </button>
          <button ref={confirm} type="button" className="btn-primary small" disabled={!spec} onClick={done} data-testid="subsession-ok">
            放进输入框
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
