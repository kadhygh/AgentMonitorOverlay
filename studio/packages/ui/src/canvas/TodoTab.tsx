import { useEffect, useState } from "react";
import type { TodoItem, Workspace } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";

function useTodos(link: HostLink) {
  const [todos, setTodos] = useState<readonly TodoItem[]>([]);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () => call(link, "GET /api/todos").then((t) => !cancelled && setTodos(t));
    const off = onHostEvent((e) => {
      if (e.type === "todo.upserted") {
        setTodos((cur) => (cur.some((t) => t.id === e.todo.id) ? cur.map((t) => (t.id === e.todo.id ? e.todo : t)) : [...cur, e.todo]));
      } else if (e.type === "todo.removed") {
        setTodos((cur) => cur.filter((t) => t.id !== e.todoId));
      }
    });
    const offReconnect = onHostReconnect(() => void load());
    void load();
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
export function TodoTab({ link, workspaces }: { link: HostLink; workspaces: readonly Workspace[] }) {
  const { todos, setDone } = useTodos(link);
  const [text, setText] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const wsName = (id: string | null) => (id ? (workspaces.find((w) => w.id === id)?.name ?? "") : "");
  const open = todos.filter((t) => !t.done);
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
      {t.workspaceId && wsName(t.workspaceId) && <span className="side-note">适合：{wsName(t.workspaceId)}</span>}
      <button type="button" className="link-btn" aria-label={`删除待办 ${t.text}`} onClick={() => void call(link, "DELETE /api/todos/:id", { id: t.id })}>
        删除
      </button>
    </div>
  );

  return (
    <div className="side-section" role="group" aria-label="整体待办">
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
          {workspaces.map((w) => (
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
      <span className="side-note">"转为任务"和"交给调度 agent"在阶段 7 加入。</span>
    </div>
  );
}
