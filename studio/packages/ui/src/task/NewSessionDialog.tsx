import { useEffect, useState } from "react";
import { REMOTE_SESSION_TITLE_SINCE, type ModelProfile, type NewSessionInput, type SessionOptions, type Task } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { Modal } from "../lib/Modal.js";
import { activeModel, useProfileChoices } from "../lib/choices.js";
import { defaultProfile, rememberProfile, repick } from "../lib/profiles.js";
import { rememberPick, type ModelPick } from "../lib/recents.js";
import { EffortBars, FastToggle, PermissionSegments } from "../chat/pickers.js";
import { ModelRow } from "../newtask/ModelRow.js";
import { PresetChips } from "../newtask/PresetChips.js";
import { useSettings } from "../settings/useSettings.js";
import { McpPick, mcpToSend, useMcpOffer } from "../mcp/McpPick.js";

// 新会话 (2026-11-17, the user: 统一迭代一下 task 下 session 的新会话，也用弹窗的形式吧，不在左侧了，然后创建时允许编辑名称，像常规新任务
// 一样选择模型、各种内容以及 mcp 选项。控制端 task 内开 session 也做成这样): a dialog instead of the form in the session list.
// Its name, an optional first message, and the session's setup as the new-task page has it — the model (tiles and the
// drawer), effort, Fast, permissions, 预设, MCP. A remote task's copy uses the same dialog: the models and MCP are those the
// computer it runs on offers (its 远程设置), its effort and permissions are that computer's; only where the choices come
// from and where the session goes differ.

export interface NewSessionRemote {
  /** The computer the task runs on. */
  name: string;
  /** This computer's ids of the models it allows; the first is its default. */
  allowed: readonly string[];
  /** Why no session can start now (offline, revoked…). */
  blocked: string | null;
  /** It lists its MCP (an older Studio does not: greyed, saying what to update to). */
  mcp: boolean;
  /** It takes the session's name (an older Studio names it itself). */
  sessionTitle: boolean;
}

export function NewSessionDialog({ link, task, profiles, remote, busy, onClose, onStart }: { link: HostLink; task: Task; profiles: readonly ModelProfile[]; remote?: NewSessionRemote; busy: boolean; onClose(): void; onStart(input: NewSessionInput): void }) {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [pick, setPick] = useState<ModelPick>(() => ({ profileId: remote ? (remote.allowed[0] ?? "") : (defaultProfile(profiles)?.id ?? ""), model: null }));
  const [options, setOptions] = useState<Omit<SessionOptions, "model" | "mcp">>({});
  const [drawer, setDrawer] = useState(false);
  const [morePerms, setMorePerms] = useState(false);
  const [mcpWant, setMcpWant] = useState<Record<string, boolean>>({});
  const settings = useSettings(link);
  // A model hidden in 设置 → 模型 meanwhile gives way to the default (问题 #14); a remote one no longer allowed there, to its first.
  useEffect(() => {
    if (remote) {
      if (!remote.allowed.includes(pick.profileId)) setPick({ profileId: remote.allowed[0] ?? "", model: null });
      return;
    }
    const next = repick(profiles, pick.profileId);
    if (next !== null) choose({ profileId: next, model: null });
  }, [profiles, pick.profileId, remote?.allowed.join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps
  const { choices } = useProfileChoices(link, remote ? "" : pick.profileId);
  const model = !remote && choices ? activeModel(choices, pick.model ? { model: pick.model } : {}) : undefined;
  // The MCP a session of this model would have in the task (a copy's: read on its computer, through the same route).
  const mcpOk = !remote || remote.mcp;
  const mcp = useMcpOffer(mcpOk && pick.profileId && !remote?.blocked ? () => call(link, "GET /api/mcp/offer", {}, undefined, { task: task.id, profile: pick.profileId }) : null, `${task.id} ${pick.profileId}`);
  // Another model may have another list (Codex: none to pick): what was changed goes.
  useEffect(() => setMcpWant({}), [pick.profileId]);

  function choose(next: ModelPick, keep?: Omit<SessionOptions, "model">) {
    setPick(next);
    const { mcp: _mcp, ...rest } = keep ?? {};
    setOptions(rest);
  }

  const label = (id: string) => profiles.find((p) => p.id === id)?.label ?? id;
  const titleOff = !!remote && !remote.sessionTitle;
  const ready = !!pick.profileId && !busy && !remote?.blocked;

  function submit() {
    if (!ready) return;
    const send = mcpToSend(mcp, mcpWant);
    const opts: SessionOptions = remote
      ? { ...(send ? { mcp: send } : {}) }
      : { ...(pick.model ? { model: pick.model } : {}), ...(options.effort ? { effort: options.effort } : {}), ...(options.fast !== undefined && model?.fast ? { fast: options.fast } : {}), ...(options.permission ? { permission: options.permission } : {}), ...(send ? { mcp: send } : {}) };
    if (!remote) {
      rememberProfile(pick.profileId);
      rememberPick(pick);
    }
    onStart({ profileId: pick.profileId, ...(title.trim() && !titleOff ? { title: title.trim() } : {}), ...(text.trim() ? { text: text.trim() } : {}), ...(Object.keys(opts).length ? { options: opts } : {}) });
  }

  return (
    <Modal className="new-session-dialog" labelledBy="new-session-title" testId="new-session-dialog" busy={busy} onClose={onClose}>
      <div className="fork-head">
        <span className="modal-title" id="new-session-title">
          新会话
        </span>
        <span className="fork-from">{remote ? `在 ${remote.name} 上的「${task.title}」里` : `在「${task.title}」里`}</span>
      </div>
      <div className="fork-field">
        <span className="fork-label">名称</span>
        <div>
          <input
            className="fork-input"
            aria-label="会话名称"
            value={title}
            maxLength={100}
            disabled={titleOff}
            placeholder="可不填：按第一句话自动起名"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            data-testid="new-session-title"
            autoFocus
          />
          {titleOff && <span className="settings-hint">{remote!.name} 上的 Studio 要更新到 {REMOTE_SESSION_TITLE_SINCE} 或更新的版本，才能在这里给新会话起名；现在按那边的规则自动起名。</span>}
        </div>
      </div>
      <div className="fork-field">
        <span className="fork-label">第一句话</span>
        <div>
          <textarea
            className="fork-input new-session-text"
            aria-label="第一句话"
            rows={3}
            value={text}
            placeholder="可不写：不写就先开着，等你在对话里发消息。Ctrl+Enter 开始"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            data-testid="new-session-text"
          />
        </div>
      </div>
      <div className="fork-field">
        <span className="fork-label">模型</span>
        <div className="new-session-model">
          {remote ? (
            remote.allowed.length === 0 ? (
              <span className="settings-hint">{remote.name} 没有允许远程新开会话的模型：在那台电脑顶栏的「远程」→「远程设置」里勾选。</span>
            ) : (
              <>
                <div className="tray-row" role="group" aria-label="模型">
                  {remote.allowed.map((id) => (
                    <button key={id} type="button" className="chip" aria-pressed={pick.profileId === id} disabled={busy || !!remote.blocked} onClick={() => setPick({ profileId: id, model: null })} data-testid="new-session-remote-model">
                      {label(id)}
                    </button>
                  ))}
                </div>
                <span className="settings-hint">只列 {remote.name} 允许的模型；思考强度和审批按那台电脑的设置（它的远程设置里定的权限）。</span>
              </>
            )
          ) : (
            <>
              <ModelRow link={link} profiles={profiles} pick={pick} onPick={(next) => choose(next)} drawer={drawer} onToggleDrawer={() => setDrawer((v) => !v)} small />
              <div className="cbar">
                {model && model.efforts.length > 0 && <EffortBars efforts={model.efforts} value={options.effort ?? null} fallback={model.defaultEffort} onChange={(effort) => setOptions((o) => ({ ...o, effort }))} small />}
                <FastToggle fast={model?.fast} value={options.fast} onChange={(fast) => setOptions((o) => ({ ...o, fast }))} small />
              </div>
            </>
          )}
        </div>
      </div>
      {!remote && (
        <div className="fork-field">
          <span className="fork-label">审批</span>
          <div>
            {choices ? (
              <PermissionSegments choices={choices} value={options.permission ?? null} onChange={(permission) => setOptions((o) => ({ ...o, permission }))} expanded={morePerms} onExpand={() => setMorePerms(true)} />
            ) : (
              <span className="settings-hint">正在读取这个模型的选项…</span>
            )}
          </div>
        </div>
      )}
      <div className="fork-field" data-testid="new-session-mcp">
        <span className="fork-label">MCP</span>
        <McpPick {...(remote ? { where: remote.name } : {})} state={mcp} want={mcpWant} onWant={setMcpWant} old={!mcpOk} disabled={busy || !!remote?.blocked} />
      </div>
      {!remote && settings?.presets?.length ? (
        <PresetChips presets={settings.presets} profiles={profiles} pick={pick} options={options} onPick={(next, keep) => choose(next, keep)} />
      ) : null}
      {remote?.blocked && (
        <span className="settings-hint" role="note">
          {remote.blocked}
        </span>
      )}
      <div className="fork-actions">
        <span className="settings-hint">{remote ? `会话在 ${remote.name} 上跑，用那边的模型账号` : "同一任务里的会话共用任务的项目文件夹"}</span>
        <span className="spacer" />
        <button type="button" className="btn-ghost" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn-primary" disabled={!ready} onClick={submit} data-testid={remote ? "remote-start" : "new-session-start"}>
          {remote ? `在 ${remote.name} 上开始新会话` : "开始新会话"}
        </button>
      </div>
    </Modal>
  );
}
