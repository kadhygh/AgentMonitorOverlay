import { useMemo, useState } from "react";
import { sortTodo, TODO_SHARED_LIST, todoDeviceList, type TodoEntry, type TodoLink, type TodoView } from "@amo-studio/protocol";
import { scratchpadBridge } from "../scratchpad/bridge.js";
import { showToast } from "../lib/toast.js";
import { Modal } from "../lib/Modal.js";

// 绑定到待办 (2026-11-02, 问题 #10, the user: bound from the task's or the session's ⋯ here, not in 便签). A dialog lists
// the open items of the 便签 program's 待办 (本机, 共通, the other devices); a click binds that item to this task (or
// session). In 便签 the item then has a tag that opens it here. The binding stays on this computer (the program's copy).

export interface TodoBindTarget {
  taskId: string;
  taskTitle: string;
  sessionId?: string;
  sessionTitle?: string;
}

/** Whether this Studio can bind (the 便签 program's bridge is there: not in a plain browser). */
export const canBindTodo = () => !!scratchpadBridge()?.todo;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** The program's 待办 for the dialog; null (and a notice saying why) when there is nothing to pick from. */
export async function loadTodoForBind(): Promise<TodoView | null> {
  const bridge = scratchpadBridge();
  if (!bridge?.todo) return null;
  try {
    const view = await bridge.todo();
    if (view.status === "off") return void showToast({ text: "便签的待办已关闭：在便签设置里打开「使用待办」", error: true }), null;
    if (view.status === "signed-out" && !view.account) return void showToast({ text: "待办要先登录：在 AMO 平台里登录", error: true }), null;
    if (!view.items.some((i) => !i.done)) return void showToast({ text: view.loaded ? "待办里还没有没做完的条目：先在便签的待办里写一条" : "待办还没读到，过一会儿再试", testId: "todo-bind-empty" }), null;
    return view;
  } catch (err) {
    showToast({ text: `读不到便签的待办：${message(err)}`, error: true });
    return null;
  }
}

const tagOf = (l: TodoLink) => (l.sessionId ? `${l.taskTitle || "未命名任务"} · ${l.sessionTitle || "会话"}` : l.taskTitle || "未命名任务");
const sameTarget = (l: TodoLink | undefined, t: TodoBindTarget) => !!l && l.taskId === t.taskId && (l.sessionId ?? "") === (t.sessionId ?? "");

export function TodoBindDialog({ view: first, target, onClose }: { view: TodoView; target: TodoBindTarget; onClose(): void }) {
  const [view, setView] = useState(first);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 本机 first, then 共通, then the other devices (as the 待办 window's tabs); only what is not done.
  const groups = useMemo(() => {
    const me = view.device.id;
    const q = query.trim().toLowerCase();
    const lists = [
      { list: todoDeviceList(me), name: `本机（${view.device.name}）` },
      { list: TODO_SHARED_LIST, name: "共通" },
      ...view.devices.filter((d) => d.device !== me).map((d) => ({ list: todoDeviceList(d.device), name: d.name })),
    ];
    return lists
      .map((l) => ({ ...l, items: sortTodo(view.items.filter((i) => i.list === l.list && (!q || i.text.toLowerCase().includes(q)))).open }))
      .filter((g) => g.items.length);
  }, [view, query]);

  const what = target.sessionId ? "这个会话" : "这个任务";
  const bind = async (item: TodoEntry, unbind: boolean) => {
    const bridge = scratchpadBridge();
    if (!bridge?.bindTodo) return;
    setBusy(true);
    setError(null);
    try {
      const link: TodoLink | null = unbind ? null : { taskId: target.taskId, taskTitle: target.taskTitle, ...(target.sessionId ? { sessionId: target.sessionId, sessionTitle: target.sessionTitle ?? "" } : {}), boundAt: Date.now() };
      const next = await bridge.bindTodo(item.id, link);
      setView(next);
      const clip = item.text.length > 16 ? `${item.text.slice(0, 16)}…` : item.text;
      showToast({ text: unbind ? `已解除「${clip}」的绑定` : `已把待办「${clip}」绑定到${what}` });
      if (!unbind) onClose();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal className="todo-bind-dialog" label="绑定到待办" testId="todo-bind-dialog" onClose={onClose}>
      <span className="modal-title">绑定到待办 · {target.sessionId ? target.sessionTitle || "会话" : target.taskTitle || "未命名任务"}</span>
      <span className="settings-hint">选一条便签里的待办，绑定到{what}。绑定后，在便签的待办里点这条后面的标签，Studio 就打开{what}。绑定只记在这台电脑上。</span>
      <input className="todo-bind-search" type="search" placeholder="搜索待办" aria-label="搜索待办" value={query} autoFocus onChange={(e) => setQuery(e.target.value)} />
      <div className="todo-bind-list" role="list">
        {groups.map((g) => (
          <div key={g.list} className="todo-bind-group" role="group" aria-label={g.name}>
            <div className="todo-bind-label">{g.name}</div>
            {g.items.map((item) => {
              const l = view.links[item.id];
              const here = sameTarget(l, target);
              return (
                <div key={item.id} className="todo-bind-row" role="listitem" data-bound={here ? "" : undefined} data-testid="todo-bind-item">
                  <button type="button" className="todo-bind-pick" disabled={busy || here} title={here ? `已经绑定到${what}` : l ? `改绑到${what}（现在绑定在「${tagOf(l)}」）` : `绑定到${what}`} onClick={() => void bind(item, false)}>
                    <span className="todo-bind-box" aria-hidden="true">{here ? "✓" : ""}</span>
                    <span className="todo-bind-text">{item.text}</span>
                    {l && <span className="todo-bind-tag">{here ? "已绑定在这里" : `已绑定：${tagOf(l)}`}</span>}
                  </button>
                  {here && (
                    <button type="button" className="btn-ghost small" disabled={busy} onClick={() => void bind(item, true)} data-testid="todo-bind-unbind">
                      解除绑定
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {!groups.length && <div className="settings-hint">没有找到「{query.trim()}」。</div>}
      </div>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
      <div className="description-dialog-actions">
        <span className="spacer" />
        <button type="button" className="btn-ghost" onClick={onClose}>
          关闭
        </button>
      </div>
    </Modal>
  );
}
