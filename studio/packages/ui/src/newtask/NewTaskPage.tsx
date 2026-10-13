import { useEffect, useRef, useState } from "react";
import { projectWorkspaces, type ModelProfile, type Session, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import type { Scope } from "../board/Board.js";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { activeModel, sameOptions, useProfileChoices } from "../lib/choices.js";
import { samePick } from "../lib/recents.js";
import { usePacks } from "../packs/usePacks.js";
import { useSettings } from "../settings/SettingsDialog.js";
import { EffortBars, nextEffort, PermissionSegments } from "../chat/pickers.js";
import { submitDraft, useTaskDraft } from "./draft.js";
import { ModelRow, tilePicks } from "./ModelRow.js";
import { SuggestList, useMentions } from "./Suggest.js";

interface NewTaskPageProps {
  link: HostLink;
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  tasks: readonly Task[];
  profiles: readonly ModelProfile[];
  /** Where the page was opened from: preselects the project or the topic of a fresh draft. */
  scope: Scope;
  onBack(): void;
  /** `session` null: the task was only filed (放进待办). */
  onCreated(task: Task, session: Session | null): void;
}

/**
 * 草稿任务页 (design/ui-directions/new-task.html): no dialog, the main area becomes an empty task. Projects and topics are
 * rows of chips (both may stay unpicked: no project runs in the common folder), the model is a tile, the effort a set
 * of bars, the permissions a segmented control. Enter starts, Ctrl+Enter files the task in 待办. The draft is kept.
 */
export function NewTaskPage({ link, workspaces, topics, tasks, profiles, scope, onBack, onCreated }: NewTaskPageProps) {
  const { draft, update, reset } = useTaskDraft(profiles);
  const projects = projectWorkspaces(workspaces);
  const liveTopics = topics.filter((t) => !t.archivedAt);
  const [drawer, setDrawer] = useState(false);
  const [morePerms, setMorePerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [templateKey, setTemplateKey] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const presets = useSettings(link)?.presets ?? [];
  const { choices } = useProfileChoices(link, draft.pick.profileId);
  const model = choices ? activeModel(choices, draft.pick.model ? { model: draft.pick.model } : {}) : undefined;

  // A fresh draft starts where the page was opened from; a draft with text keeps its own choices.
  useEffect(() => {
    if (!draft.text.trim()) update({ projectId: scope.kind === "workspace" ? scope.id : null, topicId: scope.kind === "topic" ? scope.id : null });
    input.current?.focus();
    // Only when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // In a topic, its projects come first.
  const topic = liveTopics.find((t) => t.id === draft.topicId);
  const inTopic = new Set(topic ? [...topic.workspaceIds, ...tasks.filter((t) => t.topicId === topic.id).map((t) => t.workspaceId)] : []);
  const orderedProjects = [...projects].sort((a, b) => Number(inTopic.has(b.id)) - Number(inTopic.has(a.id)));

  // Task templates from the extension packs of the chosen project.
  const { packs } = usePacks(link, draft.projectId ? [draft.projectId] : []);
  const templates = packs.flatMap((p) => (p.manifest ? p.manifest.templates.map((t) => ({ key: `${p.dirName}/${t.id}`, pack: p.dirName, title: `${p.manifest!.title} · ${t.title}`, template: t })) : []));
  const chosenTemplate = templates.find((t) => t.key === templateKey) ?? null;

  const mentions = useMentions({
    text: draft.text,
    setText: (text) => update({ text }),
    projects,
    topics: liveTopics,
    onPick: (kind, id) => update(kind === "project" ? { projectId: id } : { topicId: id }),
  });

  const where = `${draft.projectId ? `在 ${projects.find((w) => w.id === draft.projectId)?.name ?? "?"} 里运行` : "不指定项目：在公共目录里运行"}${topic ? ` · 放进「${topic.title}」` : ""}`;

  async function submit(file: boolean) {
    if (busy) return;
    if (!draft.text.trim()) return setError(file ? "写一句话再放进待办。" : "写一句话再开始。");
    if (!file && !draft.pick.profileId) return setError("先选一个模型。");
    setBusy(true);
    setError("");
    try {
      const template = chosenTemplate && draft.projectId ? { workspaceId: draft.projectId, pack: chosenTemplate.pack, template: chosenTemplate.template.id } : undefined;
      const created = await submitDraft(link, draft, file, template);
      reset({ projectId: draft.projectId, topicId: draft.topicId });
      onCreated(created.task, created.session);
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  async function addProject() {
    const dir = await window.amo?.pickDirectory?.();
    if (!dir) return;
    try {
      const ws = await call(link, "POST /api/workspaces", {}, { path: dir });
      update({ projectId: ws.id });
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    }
  }

  // Alt 1–4: the 常用 tiles; Alt E: one effort up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey) return;
      if (/^[1-4]$/.test(e.key)) {
        const t = tilePicks(profiles, draft.pick)[Number(e.key) - 1];
        if (t) {
          e.preventDefault();
          update({ pick: t });
        }
      } else if (e.key.toLowerCase() === "e" && model) {
        e.preventDefault();
        const next = nextEffort(model.efforts, draft.options.effort ?? model.defaultEffort);
        if (next) update({ options: { ...draft.options, effort: next } });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [profiles, draft, model, update]);

  return (
    <section className="draft-page" aria-label="新任务">
      <div className="page-head">
        <button type="button" className="btn-ghost small" onClick={onBack}>
          ← 看板
        </button>
        <span className="page-crumb">/ 新任务</span>
        <span className="spacer" />
        <span className="page-crumb">草稿自动保存，离开也不会丢</span>
      </div>
      <div className="draft-wrap">
        <div className="draft">
          <h1 className="draft-ask">要推进什么？</h1>
          <p className="draft-lede">写下第一句话就能开始。项目、模型和思考强度都在下面，点一下就换。</p>

          <div className="draft-where">
            <label className="pick-row">
              <span className="pick-lab">名称</span>
              <input
                className="draft-title"
                value={draft.title}
                onChange={(e) => update({ title: e.target.value })}
                placeholder="可不填，用第一句话当名字；之后随时可以改"
                aria-label="任务名"
                maxLength={100}
              />
            </label>
            <div className="pick-row" role="group" aria-label="项目">
              <span className="pick-lab">项目</span>
              <button type="button" className="chip none" aria-pressed={draft.projectId === null} onClick={() => update({ projectId: null })}>
                不指定
              </button>
              {orderedProjects.map((w) => (
                <button key={w.id} type="button" className="chip" aria-pressed={draft.projectId === w.id} title={w.path} onClick={() => update({ projectId: w.id })}>
                  {w.name}
                </button>
              ))}
              {window.amo?.pickDirectory && (
                <button type="button" className="chip add" onClick={() => void addProject()}>
                  + 添加项目
                </button>
              )}
            </div>
            <div className="pick-row" role="group" aria-label="专题">
              <span className="pick-lab">专题</span>
              <button type="button" className="chip none" aria-pressed={draft.topicId === null} onClick={() => update({ topicId: null })}>
                不放进专题
              </button>
              {liveTopics.map((t) => (
                <button key={t.id} type="button" className="chip" aria-pressed={draft.topicId === t.id} onClick={() => update({ topicId: t.id })}>
                  {t.title}
                </button>
              ))}
            </div>
            {templates.length > 0 && (
              <div className="pick-row" role="group" aria-label="流程模板">
                <span className="pick-lab">模板</span>
                <button type="button" className="chip none" aria-pressed={!chosenTemplate} onClick={() => setTemplateKey("")}>
                  不用模板
                </button>
                {templates.map((t) => (
                  <button key={t.key} type="button" className="chip" aria-pressed={chosenTemplate?.key === t.key} title={t.template.description} onClick={() => setTemplateKey(t.key)}>
                    {t.title}
                  </button>
                ))}
              </div>
            )}
            {chosenTemplate && (
              <ol className="draft-steps" data-testid="template-steps">
                {chosenTemplate.template.steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            )}
          </div>

          <div className="draft-composer">
            <textarea
              ref={input}
              value={draft.text}
              rows={3}
              aria-label="第一句话"
              placeholder="比如：导入器遇到网络错误直接崩，给 fetch 加上失败重试，最多 3 次。打 @ 选项目，# 选专题。"
              onChange={(e) => {
                update({ text: e.target.value });
                mentions.track(e.target);
              }}
              onSelect={(e) => mentions.track(e.currentTarget)}
              onKeyDown={(e) => {
                if (mentions.onKeyDown(e)) return;
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit(e.ctrlKey || e.metaKey);
                }
              }}
            />
            <SuggestList mentions={mentions} />
            <div className="cbar">
              <ModelRow link={link} profiles={profiles} pick={draft.pick} onPick={(pick) => update({ pick })} drawer={drawer} onToggleDrawer={() => setDrawer((v) => !v)} />
            </div>
            <div className="cbar">
              {model && model.efforts.length > 0 && (
                <EffortBars efforts={model.efforts} value={draft.options.effort ?? null} fallback={model.defaultEffort} onChange={(effort) => update({ options: { ...draft.options, effort } })} />
              )}
              {choices ? (
                <PermissionSegments
                  choices={choices}
                  value={draft.options.permission ?? null}
                  onChange={(permission) => update({ options: { ...draft.options, permission } })}
                  expanded={morePerms}
                  onExpand={() => setMorePerms(true)}
                />
              ) : (
                <span className="drawer-note">正在读取这个模型的选项…</span>
              )}
              <span className="spacer" />
              <button type="button" className="btn-ghost" onClick={() => void submit(true)} disabled={busy} title="只建任务，放进待办，不开会话">
                放进待办 <kbd>Ctrl ↵</kbd>
              </button>
              <button type="button" className="btn-primary" onClick={() => void submit(false)} disabled={busy || !draft.pick.profileId}>
                {busy ? "正在开始…" : "开始"} <kbd>↵</kbd>
              </button>
            </div>
            {presets.length > 0 && (
              <div className="cbar presets" role="group" aria-label="常用预设">
                <span className="pick-lab">预设</span>
                {presets
                  .filter((p) => profiles.some((x) => x.id === p.profileId))
                  .map((p) => {
                    const pick = { profileId: p.profileId, model: p.options.model ?? null };
                    const { model: _model, ...rest } = p.options;
                    const active = samePick(pick, draft.pick) && sameOptions(rest, draft.options);
                    return (
                      <button key={p.id} type="button" className="chip small" aria-pressed={active} onClick={() => update({ pick, options: rest })} data-testid="preset-chip">
                        {p.name}
                      </button>
                    );
                  })}
              </div>
            )}
          </div>

          <div className="foot-hints">
            <span>
              <kbd>@</kbd>选项目
            </span>
            <span>
              <kbd>#</kbd>选专题
            </span>
            <span>
              <kbd>Alt 1–4</kbd>换常用模型
            </span>
            <span>
              <kbd>Alt E</kbd>思考强度加一档
            </span>
            <span className="foot-where" data-testid="scope-hint">
              {where}
            </span>
          </div>
          {error && (
            <span className="form-error" role="alert">
              {error}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
