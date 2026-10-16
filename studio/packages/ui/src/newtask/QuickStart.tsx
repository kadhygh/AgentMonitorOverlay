import { useEffect, useRef, useState } from "react";
import { projectWorkspaces, type ModelProfile, type Session, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { HostApiError, type HostLink } from "../host/client.js";
import { activeModel, useProfileChoices } from "../lib/choices.js";
import { samePick } from "../lib/recents.js";
import { EffortBars, FastToggle } from "../chat/pickers.js";
import { submitDraft, useTaskDraft } from "./draft.js";
import { ModelRow, tilePicks } from "./ModelRow.js";
import { SuggestList, useMentions } from "./Suggest.js";

/**
 * 快速启动条 (Ctrl N, design/ui-directions/new-task.html): one line from anywhere — @ project, # topic, the sentence —
 * with the model and effort below. It writes the same draft as the draft task page (Ctrl+Shift+N opens that page).
 */
export function QuickStart({
  link,
  workspaces,
  topics,
  profiles,
  onClose,
  onExpand,
  onCreated,
}: {
  link: HostLink;
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  profiles: readonly ModelProfile[];
  onClose(): void;
  /** Continue on the draft task page. */
  onExpand(): void;
  onCreated(task: Task, session: Session | null): void;
}) {
  const { draft, update, reset } = useTaskDraft(profiles);
  const projects = projectWorkspaces(workspaces);
  const liveTopics = topics.filter((t) => !t.archivedAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const { choices } = useProfileChoices(link, draft.pick.profileId);
  const model = choices ? activeModel(choices, draft.pick.model ? { model: draft.pick.model } : {}) : undefined;
  const mentions = useMentions({
    text: draft.text,
    setText: (text) => update({ text }),
    projects,
    topics: liveTopics,
    onPick: (kind, id) => update(kind === "project" ? { projectId: id } : { topicId: id }),
  });
  useEffect(() => input.current?.focus(), []);

  const project = projects.find((w) => w.id === draft.projectId);
  const topic = liveTopics.find((t) => t.id === draft.topicId);

  async function submit(file: boolean) {
    if (busy) return;
    if (!draft.text.trim()) return setError("写一句话再开始。");
    setBusy(true);
    setError("");
    try {
      const created = await submitDraft(link, draft, file);
      reset();
      onCreated(created.task, created.session);
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="quick-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="quick" role="dialog" aria-label="快速新任务">
        <div className="quick-in">
          <span className="quick-spark" aria-hidden="true">
            ✳
          </span>
          <input
            ref={input}
            value={draft.text}
            aria-label="快速新任务"
            placeholder="一句话开始新任务，@ 选项目，# 选专题"
            onChange={(e) => {
              update({ text: e.target.value });
              mentions.track(e.target);
            }}
            onSelect={(e) => mentions.track(e.currentTarget)}
            onKeyDown={(e) => {
              if (mentions.onKeyDown(e)) return;
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key.toLowerCase() === "n" && e.ctrlKey && e.shiftKey) {
                e.preventDefault();
                onExpand();
              } else if (e.key === "Tab") {
                // Tab walks the 常用 tiles.
                e.preventDefault();
                const tiles = tilePicks(profiles, draft.pick);
                const i = tiles.findIndex((t) => samePick(t, draft.pick));
                const next = tiles[(i + (e.shiftKey ? tiles.length - 1 : 1)) % tiles.length];
                if (next) update({ pick: next });
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit(e.ctrlKey || e.metaKey);
              }
            }}
          />
        </div>
        {(project || topic) && (
          <div className="quick-tokens">
            {project && (
              <span className="token">
                @{project.name}
                <button type="button" aria-label={`去掉项目 ${project.name}`} onClick={() => update({ projectId: null })}>
                  ×
                </button>
              </span>
            )}
            {topic && (
              <span className="token">
                #{topic.title}
                <button type="button" aria-label={`去掉专题 ${topic.title}`} onClick={() => update({ topicId: null })}>
                  ×
                </button>
              </span>
            )}
          </div>
        )}
        <SuggestList mentions={mentions} inline />
        {error && (
          <span className="form-error quick-error" role="alert">
            {error}
          </span>
        )}
        <div className="quick-foot">
          <ModelRow link={link} profiles={profiles} pick={draft.pick} onPick={(pick) => update({ pick })} drawer={false} small />
          {model && model.efforts.length > 0 && (
            <EffortBars efforts={model.efforts} value={draft.options.effort ?? null} fallback={model.defaultEffort} onChange={(effort) => update({ options: { ...draft.options, effort } })} small />
          )}
          <FastToggle fast={model?.fast} value={draft.options.fast} onChange={(fast) => update({ options: { ...draft.options, fast } })} small />
          <span className="quick-hints">
            <span>
              <kbd>↵</kbd>开始
            </span>
            <span>
              <kbd>Ctrl ↵</kbd>放进待办
            </span>
            <span>
              <kbd>Tab</kbd>换模型
            </span>
            <button type="button" className="link-btn" onClick={onExpand}>
              <kbd>Ctrl ⇧ N</kbd>展开
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
