import { useEffect, useRef, useState } from "react";
import { BackButton } from "../shell/BackButton.js";
import type { ModelProfile, Session, Task, Topic, Workspace } from "@amo-studio/protocol";
import type { Scope } from "../board/Board.js";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { activeModel, sameOptions, useProfileChoices } from "../lib/choices.js";
import { samePick } from "../lib/recents.js";
import { pickFolder, shortModel } from "../lib/profiles.js";
import { StartingCover } from "../lib/StartingCover.js";
import { useSettings } from "../settings/useSettings.js";
import { EffortBars, FastToggle, nextEffort, PermissionSegments } from "../chat/pickers.js";
import { DSH_FULL_ACCESS, SandboxHint } from "../settings/SandboxHint.js";
import { draftText, submitDraft, useTaskDraft } from "./draft.js";
import { ModelRow, tilePicks } from "./ModelRow.js";
import { ChoiceRow } from "./ChoiceRow.js";
import { useDraftChoices } from "./useDraftChoices.js";
import { MentionList, useComposerMentions } from "../attach/useMentions.js";
import { FileSelector } from "../attach/FileSelector.js";
import { PromptTemplateDialog } from "../attach/PromptTemplateDialog.js";
import { SubSessionDialog } from "../attach/SubSessionDialog.js";
import { useAttachments } from "../attach/useAttachments.js";
import { AttachTray } from "../attach/AttachTray.js";
import { IconPaperclip } from "../attach/icons.js";
import { withFileRefs } from "../attach/refs.js";
import { useRemote } from "../remote/remote.js";
import { RemoteDraft } from "./RemoteDraft.js";
import { remoteModeShown } from "./remoteTargets.js";
import { ResumePicker, SOURCE_LABEL } from "./ResumePicker.js";
import { relativeTime } from "../lib/status.js";
import type { OutsideSession } from "@amo-studio/protocol";

/** 接续已有会话 runs on this profile only: the outside sessions are the local Claude Code login's. */
const CLAUDE_SUBSCRIPTION = "claude-subscription";

/** The same folder, case and slashes aside (Windows paths as the Host gives them). */
const sameDir = (a: string, b: string) => a.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() === b.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

interface NewTaskPageProps {
  link: HostLink;
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  tasks: readonly Task[];
  /** Sessions @ lists under their tasks. */
  sessions?: readonly Session[];
  profiles: readonly ModelProfile[];
  /** Where the page was opened from: preselects the project or the topic of a fresh draft. */
  scope: Scope;
  /** Opened from this topic's canvas: a task created in that topic always goes on it (S11-A). */
  canvasTopicId?: string;
  /** What "←" says: where it returns (看板 or 画布). */
  backLabel?: string;
  onBack(): void;
  /** `session` null: the task was only filed (放进待办). */
  onCreated(task: Task, session: Session | null): void;
  /** 远程创建 (2026-10-29): opened in 「在别的设备上」 with this device picked (the remote page's 「在它上面新建任务」). */
  remoteDevice?: { account: string; device: string };
  /** A task created on another device: its copy here, once it has come. */
  onOpenRemote?(taskId: string, sessionId: string | null): void;
}

/**
 * 草稿任务页 (design/ui-directions/new-task.html): no dialog, the main area becomes an empty task. Projects and topics are
 * rows of chips (both may stay unpicked: no project runs in the common folder), the model is a tile, the effort a set
 * of bars, the permissions a segmented control. Enter starts, Ctrl+Enter files the task in 待办. The draft is kept.
 */
export function NewTaskPage({ link, workspaces, topics, tasks, sessions = [], profiles, scope, canvasTopicId, backLabel = "看板", onBack, onCreated, remoteDevice, onOpenRemote }: NewTaskPageProps) {
  const { draft, update, reset } = useTaskDraft(profiles);
  // 「在这台电脑上 | 在别的设备上」 (4.1): shown with remote on, logged in, and a device that allowed this computer.
  const remote = useRemote(link);
  const [side, setSide] = useState<"here" | "remote">(remoteDevice ? "remote" : "here");
  const remoteShown = remoteModeShown(remote);
  const remoteMode = remoteShown && side === "remote" && !!remote;
  const rows = useDraftChoices({ draft, update, workspaces, topics, tasks });
  const projects = rows.projects;
  const [drawer, setDrawer] = useState(false);
  const [morePerms, setMorePerms] = useState(false);
  const [busy, setBusy] = useState(false);
  // 正在启动: the page is covered while the first session starts (filing in 待办 is quick).
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState("");
  // "显示在画布上" for a task in a topic: off unless the page was opened from that topic's canvas (then always on).
  const [showOnCanvas, setShowOnCanvas] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  // Images and files pasted, dropped or picked go with the first sentence (2026-10-19); they are not kept in the draft.
  const attach = useAttachments(link);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const settings = useSettings(link);
  const presets = settings?.presets ?? [];
  const { choices } = useProfileChoices(link, draft.pick.profileId);
  const model = choices ? activeModel(choices, draft.pick.model ? { model: draft.pick.model } : {}) : undefined;
  // 接续已有会话 (2026-11-05): the outside session picked; not kept in the draft (it may be taken on elsewhere meanwhile).
  const [resume, setResume] = useState<OutsideSession | null>(null);
  const [pickingResume, setPickingResume] = useState(false);
  const subscription = profiles.find((p) => p.id === CLAUDE_SUBSCRIPTION && !p.hidden && !p.unavailable);

  // A fresh draft starts where the page was opened from (in a topic, with its one preferred project); a draft with text
  // keeps its own choices.
  useEffect(() => {
    if (!draft.text.trim()) {
      const projectId = scope.kind === "workspace" ? scope.id : null;
      update({ projectId, ...rows.topicPatch(scope.kind === "topic" ? scope.id : null, projectId) });
    }
    input.current?.focus();
    // Only when the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const topic = rows.topic;
  const fromCanvas = !!topic && topic.id === canvasTopicId;
  const onCanvas = !!topic && (fromCanvas || showOnCanvas);
  // 找文件 from the @ list: the picked project's files.
  const [finding, setFinding] = useState<{ query: string } | null>(null);

  // @ refers to a project, a task or one of its sessions, or (once a project is picked) a file, as in a session's
  // composer (2026-10-29); it never sets the task's own project or topic.
  const mentions = useComposerMentions({
    link,
    text: draft.text,
    setText: (text) => update({ text }),
    tasks,
    sessions,
    current: null,
    projects,
    projectsAlways: true,
    workspaceId: draft.projectId,
    picks: { value: new Map(Object.entries(draft.refs ?? {})), set: (next) => update({ refs: Object.fromEntries(next) }) },
    onFile: (path) => attach.addFiles([path]),
    onFind: (query) => setFinding({ query }),
    onMark: (ref) => attach.addRefs([ref]),
    // 2026-11-05: the task's first session may start sub-sessions, so 开子会话… is offered here too.
    subsession: true,
  });

  const where = `${draft.projectId ? `在 ${projects.find((w) => w.id === draft.projectId)?.name ?? "?"} 里运行` : "不指定项目：在公共目录里运行"}${topic ? ` · 放进「${topic.title}」` : ""}`;

  async function submit(file: boolean) {
    if (busy) return;
    if (resume && file) return setError("接续的会话不能放进待办：直接点「接续」，第一句话可以不写。");
    if (resume && draft.pick.profileId !== CLAUDE_SUBSCRIPTION) return setError("接续已有会话只能用 Claude 订阅：先在下面选回它。");
    if (!resume && !draft.text.trim()) return setError(file ? "写一句话再放进待办。" : "写一句话再开始。");
    if (!file && !draft.pick.profileId) return setError("先选一个模型。");
    if (file && !attach.empty) return setError("放进待办不带图片和文件：先移除它们，或者直接开始。");
    if (attach.uploading) return setError("图片还在上传，稍等一下。");
    if (attach.failed) return setError("有图片上传失败，移除后再开始。");
    setBusy(true);
    if (!file) setStarting(resume ? "正在接续会话…" : `正在启动 ${shortModel(profiles.find((p) => p.id === draft.pick.profileId))}…`);
    setError("");
    try {
      const text = withFileRefs(draftText(draft), attach.files.map(attach.refOf));
      const images = attach.images.flatMap((i) => (i.id ? [i.id] : []));
      const { refs: _refs, ...rest } = draft;
      const created = await submitDraft(link, { ...rest, text, ...(resume && !rest.title.trim() ? { title: resume.title } : {}) }, file, onCanvas, images, resume?.id);
      setResume(null);
      attach.reset();
      reset({ projectId: draft.projectId, topicId: draft.topicId });
      onCreated(created.task, created.session);
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
      setStarting(null);
    }
  }

  /** A session picked in 接续已有会话: the task's name and project from it, the Claude subscription as the model. */
  function pickResume(s: OutsideSession) {
    setPickingResume(false);
    setResume(s);
    setError("");
    update({ title: s.title.slice(0, 100), ...(subscription ? { pick: { profileId: subscription.id, model: null } } : {}) });
    if (s.workspaceId) rows.pickProject(s.workspaceId);
    requestAnimationFrame(() => input.current?.focus());
  }

  async function addProject(path?: string) {
    const dir = path ?? (await pickFolder());
    if (!dir) return;
    try {
      const ws = await call(link, "POST /api/workspaces", {}, { path: dir });
      rows.pickProject(ws.id);
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    }
  }

  // Alt 1–6: the 常用 tiles; Alt E: one effort up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not in 「在别的设备上」: its models are the other computer's.
      if (!e.altKey || e.ctrlKey || remoteMode) return;
      if (/^[1-6]$/.test(e.key)) {
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
  }, [profiles, draft, model, update, remoteMode]);

  return (
    <section className="draft-page" aria-label="新任务">
      <div className="page-head">
        <BackButton label={backLabel} onClick={onBack} />
        <span className="page-crumb">/ 新任务</span>
        <span className="spacer" />
        <span className="page-crumb">草稿自动保存，离开也不会丢</span>
      </div>
      <div className="draft-wrap">
        <div className="draft">
          <div className="draft-ask-row">
            <h1 className="draft-ask">要推进什么？</h1>
            {!remoteMode && subscription && (
              <button type="button" className="btn-ghost small draft-resume-btn" onClick={() => setPickingResume(true)} title="把终端或 Claude 桌面版里开的 Claude 会话接过来，在这里接着做" data-testid="draft-resume-open">
                接续已有会话…
              </button>
            )}
            {remoteShown && (
              <span className="perm draft-side" role="group" aria-label="在哪台电脑上" data-testid="draft-side">
                <button type="button" aria-pressed={!remoteMode} onClick={() => setSide("here")}>
                  在这台电脑上
                </button>
                <button type="button" aria-pressed={remoteMode} onClick={() => setSide("remote")} data-testid="draft-side-remote">
                  在别的设备上
                </button>
              </span>
            )}
          </div>
          <p className="draft-lede">
            {remoteMode ? "任务建在你的另一台电脑上，会话在那边跑、用那边的模型账号；能选什么、要不要那边点同意，由它的「远程设置」定。" : "写下第一句话就能开始。项目、模型和思考强度都在下面，点一下就换。"}
          </p>

          {remoteMode ? (
            <RemoteDraft
              link={link}
              remote={remote}
              {...(remoteDevice ? { initialDevice: remoteDevice } : {})}
              tasks={tasks}
              draft={draft}
              update={update}
              onDone={() => reset({ projectId: draft.projectId, topicId: draft.topicId })}
              onOpenTask={(taskId, sessionId) => onOpenRemote?.(taskId, sessionId)}
            />
          ) : (
          <>
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
            {/* 2026-10-29: the topic first, then the project, its preferred ones first (plans/remote-page-and-new-task.md 4.2). */}
            <ChoiceRow label="专题" noun="专题" choices={rows.topicChoices} selected={draft.topicId} onPick={rows.pickTopic} />
            <ChoiceRow label="项目" noun="项目" choices={rows.projectChoices} selected={draft.projectId} onPick={rows.pickProject}>
              {window.amo?.pickDirectory && (
                <button type="button" className="chip add" onClick={() => void addProject()}>
                  + 添加项目
                </button>
              )}
            </ChoiceRow>
            {topic && (
              <label className="pick-row draft-oncanvas" title="在专题的画布上显示这个任务的卡片；之后在任务页随时可以改">
                <span className="pick-lab" />
                <input type="checkbox" checked={onCanvas} disabled={fromCanvas} onChange={(e) => setShowOnCanvas(e.target.checked)} data-testid="draft-on-canvas" />
                显示在画布上
                {fromCanvas && <span className="drawer-note">从画布新建，总在画布上</span>}
              </label>
            )}
            <label className="pick-row draft-oncanvas" title="主控负责协调它的专题（不在专题里时是它的项目）：拆任务、排画布、写专题文档；具体的活由各任务的会话做。之后在任务页随时可以改">
              <span className="pick-lab" />
              <input type="checkbox" checked={!!draft.lead} onChange={(e) => update({ lead: e.target.checked })} data-testid="draft-lead" />
              设为主控
              <span className="drawer-note">协调{topic ? "这个专题" : "这个项目"}的任务</span>
            </label>
          </div>

          {resume && (
            <div className="draft-resume" data-testid="draft-resume">
              <div className="draft-resume-head">
                <span className="pick-lab">接续</span>
                <span className="draft-resume-title">{resume.title}</span>
                <span className="draft-resume-sub">
                  {SOURCE_LABEL[resume.source]} · {relativeTime(resume.lastModified)}
                </span>
                <button type="button" className="link-btn" onClick={() => setPickingResume(true)}>
                  换一个
                </button>
                <button type="button" className="link-btn" onClick={() => setResume(null)} data-testid="draft-resume-clear">
                  不接续了
                </button>
              </div>
              {(() => {
                const project = projects.find((w) => w.id === draft.projectId);
                if (project && sameDir(project.path, resume.cwd)) return null;
                return (
                  <span className="draft-resume-note" data-testid="draft-resume-where">
                    原来在 <code>{resume.cwd}</code> 里工作，接过来后在{project ? <>项目目录 <code>{project.path}</code></> : "公共目录"}里继续。
                    {!resume.workspaceId && (
                      <>
                        {" "}
                        <button type="button" className="link-btn" onClick={() => void addProject(resume.cwd)} data-testid="draft-resume-add-project">
                          把原目录添加为项目
                        </button>
                      </>
                    )}
                  </span>
                );
              })()}
              <span className="draft-resume-note">接过来的是一份副本，原会话不动。第一句话可以不写：不写就只接过来，等你发消息。</span>
            </div>
          )}

          <div
            className={dragging ? "draft-composer dropping" : "draft-composer"}
            onDragOver={(e) => {
              if (attach.onDragOver(e)) setDragging(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={(e) => {
              setDragging(false);
              attach.onDrop(e);
            }}
          >
            <AttachTray attach={attach} />
            <textarea
              ref={input}
              value={draft.text}
              rows={3}
              aria-label="第一句话"
              placeholder={resume ? "接过来后先说的话，可以不写。打 @ 引用项目、任务或文件。" : "比如：导入器遇到网络错误直接崩，给 fetch 加上失败重试，最多 3 次。打 @ 引用项目、任务或文件。"}
              onChange={(e) => {
                update({ text: e.target.value });
                mentions.track(e.target);
              }}
              onSelect={(e) => mentions.track(e.currentTarget)}
              onPaste={attach.onPaste}
              onKeyDown={(e) => {
                if (mentions.onKeyDown(e)) return;
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit(e.ctrlKey || e.metaKey);
                }
              }}
            />
            <MentionList mentions={mentions} />
            <div className="cbar">
              <button type="button" className="round-btn attach" aria-label="添加图片或文件" title="添加图片或文件（也可以粘贴或拖进来）" onClick={() => picker.current?.click()}>
                <IconPaperclip />
              </button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                data-testid="draft-attach-input"
                onChange={(e) => {
                  attach.addDropped([...(e.currentTarget.files ?? [])]);
                  e.currentTarget.value = "";
                }}
              />
              <ModelRow link={link} profiles={profiles} pick={draft.pick} onPick={(pick) => update({ pick })} drawer={drawer} onToggleDrawer={() => setDrawer((v) => !v)} />
            </div>
            <div className="cbar">
              {model && model.efforts.length > 0 && (
                <EffortBars efforts={model.efforts} value={draft.options.effort ?? null} fallback={model.defaultEffort} onChange={(effort) => update({ options: { ...draft.options, effort } })} />
              )}
              <FastToggle fast={model?.fast} value={draft.options.fast} onChange={(fast) => update({ options: { ...draft.options, fast } })} />
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
              <button type="button" className="btn-ghost" onClick={() => void submit(true)} disabled={busy || !!resume} title={resume ? "接续的会话不能放进待办" : "只建任务，放进待办，不开会话"}>
                放进待办 <kbd>Ctrl ↵</kbd>
              </button>
              <button type="button" className="btn-primary" onClick={() => void submit(false)} disabled={busy || !draft.pick.profileId} data-testid="draft-start">
                {busy ? (resume ? "正在接续…" : "正在开始…") : resume ? "接续" : "开始"} <kbd>↵</kbd>
              </button>
            </div>
            {/* DeepSeek · DSH with 工作区可写 in a project not set up for its sandbox (2026-10-23). */}
            <SandboxHint
              link={link}
              workspaceId={draft.projectId ?? workspaces.find((w) => w.builtin === "common")?.id}
              active={profiles.find((p) => p.id === draft.pick.profileId)?.runtime === "dsh" && !!choices && (draft.options.permission ?? choices.defaultPermission) === "workspace-write"}
              onUseFull={() => update({ options: { ...draft.options, permission: DSH_FULL_ACCESS } })}
            />
            {presets.length > 0 && (
              <div className="cbar presets" role="group" aria-label="常用预设">
                <span className="pick-lab">预设</span>
                {presets
                  .filter((p) => profiles.some((x) => x.id === p.profileId && !x.hidden && !x.unavailable))
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
              <kbd>@</kbd>引用项目、任务、文件
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
          </>
          )}
        </div>
      </div>
      {finding && draft.projectId && (
        <FileSelector
          link={link}
          workspaceId={draft.projectId}
          initialQuery={finding.query}
          onPick={(path) => attach.addFiles([path])}
          onClose={() => {
            setFinding(null);
            requestAnimationFrame(() => input.current?.focus());
          }}
        />
      )}
      {mentions.askingTemplate && (
        <PromptTemplateDialog
          link={link}
          workspaceId={draft.projectId}
          projects={projects}
          onDone={(body) => {
            const caret = mentions.finishTemplate(body);
            requestAnimationFrame(() => {
              input.current?.focus();
              if (caret !== null) input.current?.setSelectionRange(caret, caret);
            });
          }}
        />
      )}
      {mentions.askingSubsession && (
        <SubSessionDialog
          link={link}
          profiles={profiles}
          defaultPick={draft.pick}
          notes={settings?.subsessionNotes ?? []}
          onDone={(spec) => {
            const caret = mentions.finishSubsession(spec);
            requestAnimationFrame(() => {
              input.current?.focus();
              if (caret !== null) input.current?.setSelectionRange(caret, caret);
            });
          }}
        />
      )}
      {pickingResume && <ResumePicker link={link} projects={projects} projectId={draft.projectId} onPick={pickResume} onClose={() => setPickingResume(false)} />}
      {starting && <StartingCover label={starting} />}
    </section>
  );
}
