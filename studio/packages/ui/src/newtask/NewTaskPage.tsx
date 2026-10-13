import { useMemo, useState } from "react";
import type { ModelProfile, Session, SessionOptions, Task, TaskScope, Workspace } from "@amo-studio/protocol";
import type { Scope } from "../board/Board.js";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { defaultProfile, lastWorkspace, profileLabel, rememberProfile, rememberWorkspace } from "../lib/profiles.js";
import { usePacks } from "../packs/usePacks.js";
import { optionsSummary, sameOptions, useProfileChoices } from "../lib/choices.js";
import { OptionsPicker } from "../chat/OptionsPicker.js";
import { useSettings } from "../settings/SettingsDialog.js";

interface NewTaskPageProps {
  link: HostLink;
  workspaces: readonly Workspace[];
  profiles: readonly ModelProfile[];
  /** Scope selected in the left column; preselects the task's scope. */
  scope: Scope;
  /** The common space (设置): the default workspace for a cross-workspace task's first session. */
  commonWorkspaceId?: string;
  onBack(): void;
  onCreated(task: Task, session: Session): void;
}

type Pick = { kind: "workspace"; id: string } | { kind: "area" };

/**
 * DSH-style blank task page (interaction-notes "新建任务"): "要推进什么？", the title field below it (may stay empty),
 * scope chips including cross-workspace, a one-line scope hint, and the composer with model picker at the bottom.
 */
export function NewTaskPage({ link, workspaces, profiles, scope, commonWorkspaceId, onBack, onCreated }: NewTaskPageProps) {
  const initial = useMemo<Pick | null>(() => {
    if (scope.kind === "workspace") return { kind: "workspace", id: scope.id };
    if (scope.kind === "area") return { kind: "area" };
    const last = lastWorkspace();
    const ws = workspaces.find((w) => w.id === last) ?? workspaces[0];
    return ws ? { kind: "workspace", id: ws.id } : null;
  }, [scope, workspaces]);

  const [title, setTitle] = useState("");
  const [pick, setPick] = useState<Pick | null>(initial);
  const [message, setMessage] = useState("");
  const [profileId, setProfileId] = useState(defaultProfile(profiles)?.id ?? "");
  const [options, setOptions] = useState<SessionOptions>({});
  const { choices } = useProfileChoices(link, profileId);
  const presets = useSettings(link)?.presets ?? [];
  const [sessionWs, setSessionWs] = useState(() => (pick?.kind === "workspace" ? pick.id : (commonWorkspaceId ?? workspaces[0]?.id ?? "")));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Task templates from the extension packs of the workspace the task (or its first session) is in.
  const templateWs = pick?.kind === "workspace" ? pick.id : sessionWs;
  const { packs } = usePacks(link, templateWs ? [templateWs] : []);
  const templates = packs.flatMap((p) => (p.manifest ? p.manifest.templates.map((t) => ({ key: `${p.dirName}/${t.id}`, pack: p.dirName, packTitle: p.manifest!.title, template: t })) : []));
  const [templateKey, setTemplateKey] = useState("");
  const chosen = templates.find((t) => t.key === templateKey) ?? null;

  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? "";
  const hint = !pick
    ? "先在左栏登记一个工作区。"
    : pick.kind === "area"
      ? "跨工作区任务：可以在不同工程里各开会话，统一放在这个任务下管理。以后也会是调度 agent 工作的地方。"
      : `任务会建在 ${wsName(pick.id)}。说出第一句话即可开始，标题可以之后再改。`;

  async function start() {
    if (!pick || busy || !profileId) return;
    const taskScope: TaskScope = pick.kind === "area" ? { kind: "area" } : { kind: "workspace", workspaceId: pick.id };
    const firstWs = pick.kind === "area" ? sessionWs : pick.id;
    if (!firstWs) return setError("请选择首个会话所在的工作区。");
    setBusy(true);
    setError("");
    try {
      const created = await call(link, "POST /api/tasks", {}, {
        ...(title.trim() ? { title: title.trim() } : {}),
        scope: taskScope,
        firstSession: { profileId, workspaceId: firstWs, ...(message.trim() ? { text: message.trim() } : {}), ...(Object.keys(options).length ? { options } : {}) },
        ...(chosen ? { template: { workspaceId: templateWs, pack: chosen.pack, template: chosen.template.id } } : {}),
      });
      rememberProfile(profileId);
      rememberWorkspace(firstWs);
      onCreated(created.task, created.session);
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <section className="newtask" aria-label="新任务">
      <div className="page-head">
        <button type="button" className="btn-ghost" onClick={onBack}>
          ← 看板
        </button>
        <span className="page-crumb">新任务</span>
      </div>
      <div className="newtask-center">
        <span className="newtask-ask">要推进什么？</span>
        <label className="newtask-title">
          任务标题
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="可留空，按第一句话自动命名" />
        </label>
        <div role="group" aria-label="任务范围" className="chips">
          {workspaces.map((w) => (
            <button key={w.id} type="button" className="chip" aria-pressed={pick?.kind === "workspace" && pick.id === w.id} onClick={() => setPick({ kind: "workspace", id: w.id })}>
              {w.name}
            </button>
          ))}
          <button type="button" className="chip" aria-pressed={pick?.kind === "area"} onClick={() => {
              setPick({ kind: "area" });
              // Cross-workspace work starts in the common space when there is one (设置 → 公共空间).
              if (commonWorkspaceId) setSessionWs(commonWorkspaceId);
            }} disabled={!workspaces.length}>
            跨工作区
          </button>
        </div>
        <span className="newtask-hint" data-testid="scope-hint">{hint}</span>
        {templates.length > 0 && (
          <div className="newtask-template">
            <label className="inline-field">
              流程模板
              <select value={chosen ? chosen.key : ""} onChange={(e) => setTemplateKey(e.target.value)} aria-label="流程模板">
                <option value="">不用模板</option>
                {templates.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.packTitle} · {t.template.title}
                  </option>
                ))}
              </select>
            </label>
            {chosen && (
              <>
                {chosen.template.description && <span>{chosen.template.description}</span>}
                <ol className="newtask-steps" data-testid="template-steps">
                  {chosen.template.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </>
            )}
          </div>
        )}
      </div>
      <div className="composer-wrap">
        <div className="composer">
          <label className="composer-input">
            <span className="sr-only">第一句话</span>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              placeholder="描述问题和约束，回车发送，Shift+回车换行"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void start();
                }
              }}
            />
          </label>
          <div className="composer-bar">
            <label className="inline-field">
              模型
              <select
                value={profileId}
                onChange={(e) => {
                  setProfileId(e.target.value);
                  setOptions({});
                }}
              >
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {profileLabel(p)}
                  </option>
                ))}
              </select>
            </label>
            {pick?.kind === "area" && (
              <label className="inline-field">
                首个会话在
                <select value={sessionWs} onChange={(e) => setSessionWs(e.target.value)}>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {error && (
              <span className="form-error" role="alert">
                {error}
              </span>
            )}
            <span className="spacer" />
            <button type="button" className="btn-primary" onClick={() => void start()} disabled={!pick || busy || !profileId}>
              {busy ? "正在开始…" : "开始"}
            </button>
          </div>
          <div className="newtask-options">
            <OptionsPicker choices={choices} value={options} onChange={setOptions} />
            {presets.length > 0 && (
              <div className="preset-row" aria-label="常用预设">
                {presets
                  .filter((p) => profiles.some((x) => x.id === p.profileId))
                  .map((p) => {
                    const active = p.profileId === profileId && sameOptions(p.options, options);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className={`preset-chip${active ? " active" : ""}`}
                        aria-pressed={active}
                        title={`${profileLabel(profiles.find((x) => x.id === p.profileId)!)} · ${optionsSummary(null, p.options)}`}
                        onClick={() => {
                          setProfileId(p.profileId);
                          setOptions(p.options);
                        }}
                        data-testid="preset-chip"
                      >
                        {p.name}
                      </button>
                    );
                  })}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
