import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { projectWorkspaces, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";

/**
 * 编辑专题 (2026-10-15), like 编辑项目: the topic's name and a note on what it is about, which agents read with the topic
 * (topic_list / topic_get). 2026-10-29: and its 常用项目 (`workspaceIds`), which the new-task page puts first once the
 * topic is picked; the projects of its tasks count anyway and cannot be taken off here.
 */
export function EditTopicDialog({ link, topic, workspaces = [], tasks = [], onClose }: { link: HostLink; topic: Topic; workspaces?: readonly Workspace[]; tasks?: readonly Task[]; onClose(): void }) {
  const [title, setTitle] = useState(topic.title);
  const [description, setDescription] = useState(topic.description ?? "");
  const projects = projectWorkspaces(workspaces);
  const [added, setAdded] = useState<readonly string[]>(topic.workspaceIds);
  const fromTasks = new Set(tasks.filter((t) => t.topicId === topic.id && !t.archivedAt).map((t) => t.workspaceId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.select(), []);

  async function save() {
    if (!title.trim()) return setError("名字不能为空");
    setBusy(true);
    setError("");
    try {
      await call(link, "PATCH /api/topics/:id", { id: topic.id }, { title: title.trim(), description: description.trim(), ...(projects.length ? { workspaceIds: [...added] } : {}) });
      onClose();
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="modal-backdrop confirm-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          if (!busy) onClose();
        }
      }}
    >
      <form
        className="modal confirm-modal edit-project"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-topic-title"
        data-testid="edit-topic"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <span className="modal-title" id="edit-topic-title">
          编辑专题
        </span>
        <label className="stack-field">
          名字
          <input ref={first} className="field" value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} data-testid="edit-topic-name" />
        </label>
        <label className="stack-field">
          说明（给自己和 agent 看，可以留空）
          <textarea
            className="field"
            rows={4}
            value={description}
            maxLength={2000}
            placeholder="例如：第三章的数值调整；目标是让中期掉落更平滑，改动先在测试服验证。"
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              }
            }}
            data-testid="edit-topic-description"
          />
        </label>
        {projects.length > 0 && (
          <div className="stack-field">
            常用项目（新建任务选了这个专题时排在最前；只有一个时自动选上）
            <div className="pick-row" role="group" aria-label="常用项目" data-testid="edit-topic-projects">
              {projects.map((w) => {
                const viaTask = fromTasks.has(w.id);
                const on = viaTask || added.includes(w.id);
                return (
                  <button
                    key={w.id}
                    type="button"
                    className="chip small"
                    aria-pressed={on}
                    disabled={viaTask}
                    title={viaTask ? "专题里有这个项目的任务，总算常用项目" : w.path}
                    onClick={() => setAdded((cur) => (cur.includes(w.id) ? cur.filter((x) => x !== w.id) : [...cur, w.id]))}
                  >
                    {w.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
        <div className="settings-row end">
          <button type="button" className="btn-ghost small" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button type="submit" className="btn-primary small" disabled={busy || !title.trim()} data-testid="edit-topic-save">
            保存
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
