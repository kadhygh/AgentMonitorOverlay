import { useEffect, useRef, useState } from "react";
import { SUBSESSION_EXTRA_MAX, type ModelProfile, type SubsessionNote, type SubsessionPermission } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { activeModel, useProfileChoices } from "../lib/choices.js";
import { normalPick, type ModelPick } from "../lib/recents.js";
import { EffortBars, pickLabel } from "../chat/pickers.js";
import { ModelRow } from "../newtask/ModelRow.js";
import { subSessionTag, type SubSessionSpec } from "./mentions.js";
import { Modal } from "../lib/Modal.js";
import { readStoredJson, writeStoredJson } from "../lib/stored.js";
import { OPEN_SETTINGS_EVENT } from "../mcp/shared.js";

// 开子会话… (2026-10-26): from the composer's @ list, a sub-session for the model to start — confirmed, the composer
// gets its tag and the message says what it means.
// 2026-11-05 (the user, plans/done/subsession-mention-2026-11-05.md): the model's own options (effort; Fast where it has
// one), the person's usage note for it (设置 → 子会话, read-only here) and words for this round; the tag reads
// 「@子会话·模型·强度」; 「结果回到这个对话」 is gone (session_start's report is the model's to decide). Every choice
// starts from that model's defaults in 设置 → 子会话.

const LEVELS: Array<{ id: SubsessionPermission | null; label: string; hint: string }> = [
  { id: null, label: "默认", hint: "设置 → 子会话 里这个模型的权限；没设过就和开它的会话一样" },
  { id: "read-only", label: "只读", hint: "只看不改" },
  { id: "write", label: "可写", hint: "能改它的文件夹，越界要问" },
  { id: "full", label: "完全放开", hint: "不用沙箱、不用审批，适合连续跑很多命令" },
];

/** The last model, offered again next time (this window only); its options come from 设置 → 子会话 each time. */
const KEY = "amo.subsessionSetup";
function readRemembered(): ModelPick | null {
  const r = readStoredJson(KEY) as { pick?: ModelPick } | null | undefined;
  return r && typeof r.pick?.profileId === "string" ? r.pick : null;
}
const remember = (pick: ModelPick): void => writeStoredJson(KEY, { pick });

/** 设置 → 子会话 for a model: its own entry (the account's entry is its default model's own) and the account's. */
export function subsessionNoteFor(notes: readonly SubsessionNote[], pick: ModelPick): { own?: SubsessionNote; account?: SubsessionNote } {
  const picked = normalPick(pick);
  const own = notes.find((n) => n.profileId === picked.profileId && (n.model ?? null) === picked.model);
  const account = notes.find((n) => n.profileId === picked.profileId && n.model === null);
  return { ...(own ? { own } : {}), ...(account ? { account } : {}) };
}

export function SubSessionDialog({
  link,
  profiles,
  defaultPick,
  notes = [],
  onDone,
}: {
  link: HostLink;
  profiles: readonly ModelProfile[];
  /** 设置 → 子会话: the person's notes and defaults for models as sub-sessions. */
  notes?: readonly SubsessionNote[];
  /** The first choice when nothing usable is remembered: the composer's session's model, or the new task's. */
  defaultPick: ModelPick;
  /** The setup, or null when cancelled. */
  onDone(spec: SubSessionSpec | null): void;
}) {
  const last = readRemembered();
  const lastOk = !!last && profiles.some((p) => p.id === last.profileId && !p.hidden);
  const [pick, setPick] = useState<ModelPick>(() => normalPick(lastOk ? last! : defaultPick));
  // undefined: the model's default from 设置 → 子会话; null (effort, permission): the usual default, set by hand.
  const [effort, setEffort] = useState<string | null | undefined>(undefined);
  const [fast, setFast] = useState<boolean | undefined>(undefined);
  const [permission, setPermission] = useState<SubsessionPermission | null | undefined>(undefined);
  const [extra, setExtra] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => confirm.current?.focus(), []);

  const { choices } = useProfileChoices(link, pick.profileId);
  const model = choices ? activeModel(choices, pick.model ? { model: pick.model } : {}) : undefined;
  const profile = profiles.find((p) => p.id === pick.profileId);
  const { own, account } = subsessionNoteFor(notes, pick);
  const note = (own?.note || account?.note) ?? "";
  // What this model starts from (设置 → 子会话), then what was chosen here.
  const wantEffort = effort === undefined ? own?.effort : (effort ?? undefined);
  const chosenEffort = wantEffort && model?.efforts.includes(wantEffort) ? wantEffort : undefined;
  const chosenFast = model?.fast ? (fast ?? own?.fast ?? account?.fast) : undefined;
  const chosenPermission = permission === undefined ? (own?.permission ?? account?.permission) : (permission ?? undefined);
  const claudeFast = profile?.runtime === "claude";

  const pickModel = (next: ModelPick) => {
    setPick(normalPick(next));
    // Another model: its own defaults again.
    setEffort(undefined);
    setFast(undefined);
    setPermission(undefined);
  };

  const modelName = profile ? pickLabel(profile, pick.model, choices?.models).main : "";
  const spec: SubSessionSpec | null = profile
    ? {
        profileId: profile.id,
        modelId: pick.model,
        model: pick.model ? `${profile.label}/${pick.model}` : profile.label,
        modelName,
        ...(chosenEffort ? { effort: chosenEffort } : {}),
        ...(chosenFast !== undefined ? { fast: chosenFast } : {}),
        ...(chosenPermission ? { permission: chosenPermission } : {}),
        ...(note ? { note } : {}),
        ...(extra.trim() ? { extra: extra.trim() } : {}),
      }
    : null;

  const done = () => {
    if (!spec) return;
    remember(pick);
    onDone(spec);
  };
  const toSettings = () => {
    onDone(null);
    window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: "subsession" }));
  };

  return (
    <Modal portal className="subsession-modal" labelledBy="subsession-title" testId="subsession-dialog" onClose={() => onDone(null)}>
      <span className="modal-title" id="subsession-title">
        开子会话
      </span>
      <span className="settings-hint">输入框里会放一个子会话标签。发出去后，主模型要开子会话时照这套设定开，你补充的话原样交给子会话。什么时候开、开几个，主模型自己定。</span>
      <div className="subsession-field">
        <span className="settings-label">模型</span>
        <ModelRow link={link} profiles={profiles} pick={pick} onPick={pickModel} drawer={drawer} onToggleDrawer={() => setDrawer(!drawer)} small />
      </div>
      <div className="subsession-field">
        <span className="settings-label">思考强度</span>
        {model && model.efforts.length > 0 ? (
          <EffortBars efforts={model.efforts} value={chosenEffort ?? null} fallback={model.defaultEffort} onChange={setEffort} small />
        ) : (
          <span className="settings-hint">{choices ? "这个模型没有思考强度可选" : "正在读取…"}</span>
        )}
        {chosenEffort && (
          <button type="button" className="link-btn" onClick={() => setEffort(null)}>
            用默认
          </button>
        )}
      </div>
      {model?.fast && (
        <div className="subsession-field">
          <span className="settings-label">Fast</span>
          <label className="settings-row subsession-fast">
            <input type="checkbox" checked={chosenFast === true} onChange={(e) => setFast(e.currentTarget.checked)} data-testid="subsession-fast" />
            <span className={claudeFast ? "subsession-cost" : "settings-hint"}>{claudeFast ? "输出更快；按额外用量（usage credits）计费，不算订阅额度，账号没开额外用量时子会话会报错" : (model.fast.description ?? "更快的响应速度")}</span>
          </label>
        </div>
      )}
      <div className="subsession-field">
        <span className="settings-label">模型用法</span>
        <div className="subsession-usage-box">
          <div className={usageOpen ? "subsession-usage open" : "subsession-usage"} data-testid="subsession-note">
            {note || "还没写这个模型的用法。"}
          </div>
          <div className="settings-row">
            {note.length > 60 && (
              <button type="button" className="link-btn" onClick={() => setUsageOpen(!usageOpen)}>
                {usageOpen ? "收起" : "展开"}
              </button>
            )}
            <span className="settings-hint">设置 → 子会话 里写的，发出去时一起告诉主模型</span>
            <button type="button" className="link-btn" onClick={toSettings} data-testid="subsession-to-settings">
              {note ? "去设置里改" : "去设置里写"}
            </button>
          </div>
        </div>
      </div>
      <div className="subsession-field">
        <span className="settings-label">这一轮补充</span>
        <div className="subsession-usage-box">
          <textarea
            className="side-textarea"
            rows={3}
            maxLength={SUBSESSION_EXTRA_MAX}
            value={extra}
            onChange={(e) => setExtra(e.currentTarget.value)}
            placeholder="可以不写。例如：这轮只改 ui 包，不动 host；改完跑 newtask 的 e2e，截图给我看。"
            aria-label="这一轮补充给子会话的话"
            data-testid="subsession-extra"
          />
          <span className="settings-hint">原样交给子会话，接在主模型写的第一句话后面</span>
        </div>
      </div>
      <details className="subsession-more">
        <summary>更多：权限（现在：{LEVELS.find((l) => l.id === (chosenPermission ?? null))!.label}）</summary>
        <div className="settings-row" role="group" aria-label="权限">
          {LEVELS.map((l) => (
            <button key={l.label} type="button" className="chip small" title={l.hint} aria-pressed={(chosenPermission ?? null) === l.id} onClick={() => setPermission(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
      </details>
      {spec && (
        <span className="subsession-preview" data-testid="subsession-preview">
          输入框里会出现：<span className="mention-token">@{subSessionTag(spec)}</span>
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
    </Modal>
  );
}
