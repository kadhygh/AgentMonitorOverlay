import { useMemo, useState } from "react";
import { projectWorkspaces, type ModelProfile, type Session, type SessionOptions, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import type { Scope } from "../board/Board.js";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { defaultProfile, profileLabel, rememberProfile, rememberWorkspace } from "../lib/profiles.js";
import { usePacks } from "../packs/usePacks.js";
import { optionsSummary, sameOptions, useProfileChoices } from "../lib/choices.js";
import { OptionsPicker } from "../chat/OptionsPicker.js";
import { useSettings } from "../settings/SettingsDialog.js";

interface NewTaskPageProps {
  link: HostLink;
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  tasks: readonly Task[];
  profiles: readonly ModelProfile[];
  /** Scope selected in the left column: preselects the project or the topic. */
  scope: Scope;
  onBack(): void;
  /** `session` null: the task was only filed (放进待办). */
  onCreated(task: Task, session: Session | null): void;
}

/**
 * Blank task page (design/ui-directions/new-task.html, restyled in stage 10): "要推进什么？", the title (may stay
 * empty), a row of projects and a row of topics (both may stay unpicked: no project runs in the common space), and the
 * composer. Starting runs the first session; "放进待办" only files the task.
 */
export function NewTaskPage({ link, workspaces, topics, tasks, profiles, scope, onBack, onCreated }: NewTaskPageProps) {
  const projects = projectWorkspaces(workspaces);
  const liveTopics = topics.filter((t) => !t.archivedAt);
  const [topicId, setTopicId] = useState<string | null>(scope.kind === "topic" ? scope.id : null);
  // In a topic, its projects come first (the ones of its tasks and the hand-added ones).
  const initialProject = useMemo<string | null>(() => (scope.kind === "workspace" ? scope.id : null), [scope]);
  const [projectId, setProjectId] = useState<string | null>(initialProject);
  const topicProjects = useMemo(() => {
    const topic = liveTopics.find((t) => t.id === topicId);
    if (!topic) return new Set<string>();
    return new Set([...topic.workspaceIds, ...tasks.filter((t) => t.topicId === topic.id).map((t) => t.workspaceId)]);
  }, [liveTopics, tasks, topicId]);
  const orderedProjects = [...projects].sort((a, b) => Number(topicProjects.has(b.id)) - Number(topicProjects.has(a.id)));

  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [profileId, setProfileId] = useState(defaultProfile(profiles)?.id ?? "");
  const [options, setOptions] = useState<SessionOptions>({});
  const { choices } = useProfileChoices(link, profileId);
  const presets = useSettings(link)?.presets ?? [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Task templates from the extension packs of the task's project.
  const templateWs = projectId ?? "";
  const { packs } = usePacks(link, templateWs ? [templateWs] : []);
  const templates = packs.flatMap((p) => (p.manifest ? p.manifest.templates.map((t) => ({ key: `${p.dirName}/${t.id}`, pack: p.dirName, packTitle: p.manifest!.title, template: t })) : []));
  const [templateKey, setTemplateKey] = useState("");
  const chosen = templates.find((t) => t.key === templateKey) ?? null;

  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? "";
  const topicName = liveTopics.find((t) => t.id === topicId)?.title;
  const hint = `${projectId ? `在 ${wsName(projectId)} 里运行` : "不指定项目：在公共目录里运行"}${topicName ? `，放进专题「${topicName}」` : ""}。说出第一句话即可开始，标题可以之后再改。`;

  /** `file`: only file the task (放进待办), no session. */
  async function start(file = false) {
    if (busy || (!file && !profileId)) return;
    if (file && !title.trim() && !message.trim()) return setError("写一句话或一个标题再放进待办。");
    setBusy(true);
    setError("");
    try {
      const created = await call(link, "POST /api/tasks", {}, {
        ...(title.trim() ? { title: title.trim() } : file && message.trim() ? { title: message.trim().slice(0, 60) } : {}),
        workspaceId: projectId,
        topicId,
        ...(file ? {} : { firstSession: { profileId, ...(message.trim() ? { text: message.trim() } : {}), ...(Object.keys(options).length ? { options } : {}) } }),
        ...(chosen && projectId ? { template: { workspaceId: projectId, pack: chosen.pack, template: chosen.template.id } } : {}),
      });
      if (!file) rememberProfile(profileId);
      if (projectId) rememberWorkspace(projectId);
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
        <div role="group" aria-label="项目" className="chips">
          <span className="chips-label">项目</span>
          <button type="button" className="chip" aria-pressed={projectId === null} onClick={() => setProjectId(null)}>
            不指定
          </button>
          {orderedProjects.map((w) => (
            <button key={w.id} type="button" className="chip" aria-pressed={projectId === w.id} onClick={() => setProjectId(w.id)}>
              {w.name}
            </button>
          ))}
        </div>
        <div role="group" aria-label="专题" className="chips">
          <span className="chips-label">专题</span>
          <button type="button" className="chip" aria-pressed={topicId === null} onClick={() => setTopicId(null)}>
            不放进专题
          </button>
          {liveTopics.map((t) => (
            <button key={t.id} type="button" className="chip" aria-pressed={topicId === t.id} onClick={() => setTopicId(t.id)}>
              {t.title}
            </button>
          ))}
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
            {error && (
              <span className="form-error" role="alert">
                {error}
              </span>
            )}
            <span className="spacer" />
            <button type="button" className="btn-ghost" onClick={() => void start(true)} disabled={busy} title="只建任务，放进待办，不开会话">
              放进待办
            </button>
            <button type="button" className="btn-primary" onClick={() => void start()} disabled={busy || !profileId}>
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
