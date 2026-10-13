import { useEffect, useState } from "react";
import { projectWorkspaces, type ModelProfile, type TodoItem, type Workspace, type WorkspaceActivity } from "@amo-studio/protocol";
import { defaultProfile, profileLabel, rememberProfile } from "../lib/profiles.js";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { mergeFirstLoad, onHostEvent, onHostReconnect } from "../host/events.js";

/** Whole-picture todos, kept live (also used for scheduler proposals on the board). */
export function useTodos(link: HostLink) {
  const [todos, setTodos] = useState<readonly TodoItem[]>([]);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = (first = false) => call(link, "GET /api/todos").then((t) => !cancelled && setTodos((cur) => (first ? mergeFirstLoad(t, cur) : t)));
    const off = onHostEvent((e) => {
      if (e.type === "todo.upserted") {
        setTodos((cur) => (cur.some((t) => t.id === e.todo.id) ? cur.map((t) => (t.id === e.todo.id ? e.todo : t)) : [...cur, e.todo]));
      } else if (e.type === "todo.removed") {
        setTodos((cur) => cur.filter((t) => t.id !== e.todoId));
      }
    });
    const offReconnect = onHostReconnect(() => void load());
    void load(true);
    return () => {
      cancelled = true;
      off();
      offReconnect();
    };
  }, [link, reload]);

  /** Optimistic change: shown at once, reloaded from the Host if saving fails. */
  const setDone = (id: string, done: boolean) => {
    setTodos((cur) => cur.map((t) => (t.id === id ? { ...t, done } : t)));
    void call(link, "PATCH /api/todos/:id", { id }, { done }).catch(() => setReload((n) => n + 1));
  };
  return { todos, setDone };
}

/** "整体待办": global todos with an optional workspace they suit. Converting to tasks and the scheduler come in stage 7. */
export function TodoTab({
  link,
  workspaces,
  profiles = [],
  onOpenTask,
  activity,
  topicId,
}: {
  link: HostLink;
  workspaces: readonly Workspace[];
  profiles?: readonly ModelProfile[];
  onOpenTask?(taskId: string, sessionId?: string): void;
  /** The topic whose canvas shows this tab: converted todos join it. */
  topicId?: string;
  /** Whether each workspace is free: open todos for free projects come first and say so. */
  activity?: ReadonlyMap<string, WorkspaceActivity>;
}) {
  const { todos, setDone } = useTodos(link);
  const projects = projectWorkspaces(workspaces);
  const [converting, setConverting] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const wsName = (id: string | null) => (id ? (workspaces.find((w) => w.id === id)?.name ?? "") : "");
  // Todos whose project is free now come first (stable otherwise: oldest first).
  const free = (t: TodoItem) => (t.workspaceId && activity?.get(t.workspaceId)?.idle ? 0 : 1);
  const open = todos.filter((t) => !t.done).sort((a, b) => free(a) - free(b));
  const done = todos.filter((t) => t.done);

  const add = () => {
    const value = text.trim();
    if (!value) return;
    // Clear right away so the next item can be typed while this one is saved; put it back if saving fails.
    setText("");
    void call(link, "POST /api/todos", {}, { text: value, workspaceId: workspaceId || null }).catch(() => setText(value));
  };

  const row = (t: TodoItem) => (
    <div key={t.id} className={t.done ? "todo-row done" : "todo-row"} data-testid="todo">
      <label className="todo-check">
        <input type="checkbox" checked={t.done} onChange={(e) => setDone(t.id, e.target.checked)} aria-label={`完成 ${t.text}`} />
        <span className="todo-text">{t.text}</span>
      </label>
      {t.workspaceId && wsName(t.workspaceId) && (
        <span className="side-note">
          适合：{wsName(t.workspaceId)}
          {!t.done && activity?.get(t.workspaceId) && (
            <span className={activity.get(t.workspaceId)!.idle ? "todo-activity idle" : "todo-activity"}>{activity.get(t.workspaceId)!.idle ? " · 现在空闲" : " · 忙碌"}</span>
          )}
        </span>
      )}
      <div className="todo-actions">
      {t.taskId ? (
        <button type="button" className="link-btn primary" onClick={() => onOpenTask?.(t.taskId!)} aria-label={`打开任务 ${t.text}`}>
          已转为任务 →
        </button>
      ) : (
        !t.done && (
          <button type="button" className="link-btn primary" aria-label={`转为任务 ${t.text}`} aria-expanded={converting === t.id} onClick={() => setConverting(converting === t.id ? null : t.id)}>
            转为任务
          </button>
        )
      )}
      <button type="button" className="link-btn" aria-label={`删除待办 ${t.text}`} onClick={() => void call(link, "DELETE /api/todos/:id", { id: t.id })}>
        删除
      </button>
      </div>
      {converting === t.id && (
        <ConvertForm
          link={link}
          todo={t}
          workspaces={projects}
          profiles={profiles}
          {...(topicId ? { topicId } : {})}
          onDone={(taskId) => {
            setConverting(null);
            onOpenTask?.(taskId);
          }}
          onCancel={() => setConverting(null)}
        />
      )}
    </div>
  );

  return (
    <div className="side-section" role="group" aria-label="整体待办">
      <SchedulerRun link={link} profiles={profiles} onStarted={(taskId, sessionId) => onOpenTask?.(taskId, sessionId)} disabled={!open.length} />
      <form
        className="todo-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="记一件还没成任务的事，回车添加" aria-label="新待办" />
        <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} aria-label="适合的工作区">
          <option value="">不限工作区</option>
          {projects.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </form>
      {!todos.length && <span className="side-note">还没有待办。</span>}
      {open.map(row)}
      {done.length > 0 && <span className="side-subheading">已完成 {done.length}</span>}
      {done.map(row)}
    </div>
  );
}

/** "转为任务": where the task goes and which model its (empty) first session uses. Nothing is sent to a model. */
function ConvertForm({
  link,
  todo,
  workspaces,
  profiles,
  topicId,
  onDone,
  onCancel,
}: {
  link: HostLink;
  todo: TodoItem;
  workspaces: readonly Workspace[];
  topicId?: string;
  profiles: readonly ModelProfile[];
  onDone(taskId: string): void;
  onCancel(): void;
}) {
  const [workspaceId, setWorkspaceId] = useState(todo.workspaceId ?? workspaces[0]?.id ?? "");
  const [profileId, setProfileId] = useState(defaultProfile(profiles)?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function convert() {
    setBusy(true);
    setError("");
    try {
      const r = await call(link, "POST /api/todos/:id/convert", { id: todo.id }, { workspaceId, profileId, ...(topicId ? { topicId } : {}) });
      rememberProfile(profileId);
      onDone(r.task.id);
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
      setBusy(false);
    }
  }
  return (
    <div className="todo-convert" data-testid="todo-convert">
      <label className="inline-field">
        工作区
        <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} aria-label="任务的工作区">
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </label>
      <label className="inline-field">
        模型
        <select value={profileId} onChange={(e) => setProfileId(e.target.value)} aria-label="任务的模型">
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {profileLabel(p)}
            </option>
          ))}
        </select>
      </label>
      {error && <span className="form-error">{error}</span>}
      <div className="todo-convert-bar">
        <button type="button" className="btn-ghost small" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="button" className="btn-primary small" onClick={() => void convert()} disabled={busy || !workspaceId || !profileId}>
          建任务
        </button>
      </div>
    </div>
  );
}

/**
 * "让调度看一次": one scheduler round, by hand (no timer until the person decides, design/scheduler.md). It opens the
 * round's session so the person can watch it; proposals then wait on the board.
 */
function SchedulerRun({ link, profiles, onStarted, disabled }: { link: HostLink; profiles: readonly ModelProfile[]; onStarted(taskId: string, sessionId: string): void; disabled: boolean }) {
  const [profileId, setProfileId] = useState(() => (profiles.find((p) => /glm/i.test(p.id)) ?? defaultProfile(profiles))?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run() {
    setBusy(true);
    setError("");
    try {
      const r = await call(link, "POST /api/scheduler/run", {}, { profileId });
      onStarted(r.task.id, r.session.id);
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="scheduler-run">
      <select value={profileId} onChange={(e) => setProfileId(e.target.value)} aria-label="调度用的模型">
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {profileLabel(p)}
          </option>
        ))}
      </select>
      <button type="button" className="btn-ghost small" onClick={() => void run()} disabled={busy || disabled || !profileId} title="调度 agent 看一遍待办和空闲的工程，提出开工提案；你批准后才开工">
        让调度看一次
      </button>
      {error && <span className="form-error">{error}</span>}
    </div>
  );
}
