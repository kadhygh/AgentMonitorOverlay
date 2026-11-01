import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { newTodoId, sortTodo, TODO_SHARED_LIST, TODO_TEXT_LIMIT, todoDeviceList, todoOrderBetween, todoOrderOnTop, type TodoEntry, type TodoOp, type TodoView } from "@amo-studio/protocol";
import { HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";
import { useHostState } from "../host/useHostState.js";
import { pageFromKey } from "../scratchpad/logic.js";
import { openPlatform, todoChange, todoSyncNow, todoView } from "./api.js";

// The 待办 window (#todo, 2026-11-01, plans/todo.md): a window of the 便签 program beside the 便签 one, in its look. The
// lists are on the team server; the program keeps the copy and sends the changes (packages/notes/src/todo.ts), this
// shows them: 本机 / 共通 / 其他 ▾ in the title bar (Alt+1…), a line to type a new one, the open ones, 已完成 folded.
// Deleting waits a few seconds before it is sent, so 撤销 can take it back (the server keeps deleted ones deleted).

const message = (err: unknown) => (err instanceof HostApiError ? err.message : String(err));
/** How long a ticked item stays where it was before it goes to 已完成. */
const LINGER_MS = 1000;
/** How long 撤销 is offered. */
const UNDO_MS = 5000;

export function TodoIcon({ size = 16 }: { size?: number }) {
  return (
    <svg className="pad-mark" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <path d="M5.2 8.2l2 2 3.8-4.2" />
    </svg>
  );
}

function TodoName() {
  return (
    <span className="pad-name">
      <TodoIcon />
      待办
    </span>
  );
}

const hide = () => window.amo?.notes?.hideTodo?.();

export function TodoApp() {
  const host = useHostState();
  if (host.kind !== "ready") {
    return (
      <div className="pad-root">
        <header className="pad-head">
          <TodoName />
        </header>
        <div className="pad-empty">{host.kind === "connecting" ? "正在连接…" : host.reason}</div>
      </div>
    );
  }
  return <TodoWindow link={host.link} />;
}

/** The view as the program has it, live; changes go through it. */
function useTodoView(link: HostLink) {
  const [view, setView] = useState<TodoView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      todoView(link)
        .then((v) => !cancelled && setView(v))
        .catch((err: unknown) => !cancelled && setError(message(err)));
    const off = onHostEvent((e) => {
      const ev = e as unknown as { type: string; todo?: TodoView };
      if (ev.type === "todo.updated" && ev.todo) setView(ev.todo);
    });
    const offReconnect = onHostReconnect(() => void load());
    void load();
    // Shown again: fetch what the other devices did meanwhile.
    const onFocus = () => void todoSyncNow(link).catch(() => undefined);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      off();
      offReconnect();
      window.removeEventListener("focus", onFocus);
    };
  }, [link]);
  const change = useCallback(
    (ops: TodoOp[]) => {
      if (!ops.length) return;
      todoChange(link, ops)
        .then((v) => {
          setView(v);
          setError(null);
        })
        .catch((err: unknown) => setError(message(err)));
    },
    [link],
  );
  return { view, error, change };
}

interface Toast {
  text: string;
  undo?: () => void;
}

function TodoWindow({ link }: { link: HostLink }) {
  const { view, error, change } = useTodoView(link);
  /** "here", "shared", or another device's id. */
  const [which, setWhich] = useState("here");
  const [openDone, setOpenDone] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [menu, setMenu] = useState<{ id: string; top: number } | null>(null);
  const [picker, setPicker] = useState<{ left: number } | null>(null);
  const [lingering, setLingering] = useState<ReadonlySet<string>>(new Set());
  /** Deleted here, not sent yet (撤销 still possible). */
  const [deleting, setDeleting] = useState<{ ids: string[]; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [platformMissing, setPlatformMissing] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragId = useRef<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);

  const me = view?.device.id ?? "";
  const others = useMemo(() => (view?.devices ?? []).filter((d) => d.device !== me), [view, me]);
  // A device that is not in the list any more (another account now): back to 本机.
  const current = which === "here" || which === "shared" || others.some((d) => d.device === which) ? which : "here";
  const listId = current === "here" ? todoDeviceList(me) : current === "shared" ? TODO_SHARED_LIST : todoDeviceList(current);
  const otherName = others.find((d) => d.device === current)?.name ?? null;
  const tabs = useMemo(() => ["here", "shared", ...others.map((d) => d.device)], [others]);

  const hidden = new Set(deleting?.ids ?? []);
  const inList = (view?.items ?? []).filter((i) => i.list === listId && !hidden.has(i.id));
  const sorted = sortTodo(inList);
  // Just ticked: stays in place a moment (a slip can be taken back where it was).
  const open = inList.filter((i) => !i.done || lingering.has(i.id)).sort((a, b) => a.order - b.order || b.createdAt - a.createdAt);
  const done = sorted.done.filter((i) => !lingering.has(i.id));
  const countOpen = (list: string) => (view?.items ?? []).filter((i) => i.list === list && !i.done && !hidden.has(i.id)).length;

  const say = useCallback((t: Toast | null, ms = UNDO_MS) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(t);
    if (t) toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  // A delete waiting for its 撤销 goes now (another delete, the window hidden or closed).
  const deletingRef = useRef(deleting);
  deletingRef.current = deleting;
  const flushDelete = useCallback(() => {
    const d = deletingRef.current;
    if (!d) return;
    clearTimeout(d.timer);
    deletingRef.current = null;
    setDeleting(null);
    change(d.ids.map((id): TodoOp => ({ op: "delete", id })));
  }, [change]);
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && flushDelete();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", flushDelete);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", flushDelete);
    };
  }, [flushDelete]);

  function remove(items: TodoEntry[], label: string) {
    if (!items.length) return;
    flushDelete();
    const ids = items.map((i) => i.id);
    const timer = setTimeout(flushDelete, UNDO_MS);
    const next = { ids, timer };
    deletingRef.current = next;
    setDeleting(next);
    setMenu(null);
    say({
      text: label,
      undo: () => {
        clearTimeout(timer);
        deletingRef.current = null;
        setDeleting(null);
        say(null);
      },
    });
  }

  function add() {
    const text = draft.trim();
    if (!text) return;
    change([{ op: "put", id: newTodoId(), list: listId, text: text.slice(0, TODO_TEXT_LIMIT), order: todoOrderOnTop(sorted.open) }]);
    setDraft("");
  }

  function toggle(item: TodoEntry) {
    const next = !item.done;
    change([{ op: "put", id: item.id, done: next }]);
    if (next) {
      setLingering((s) => new Set(s).add(item.id));
      setTimeout(
        () =>
          setLingering((s) => {
            const n = new Set(s);
            n.delete(item.id);
            return n;
          }),
        LINGER_MS,
      );
    }
  }

  function saveEdit() {
    if (!editing) return;
    const text = editing.text.trim();
    const item = view?.items.find((i) => i.id === editing.id);
    setEditing(null);
    if (item && text && text !== item.text) change([{ op: "put", id: item.id, text: text.slice(0, TODO_TEXT_LIMIT) }]);
  }

  function moveTo(item: TodoEntry, target: string, name: string) {
    const top = todoOrderOnTop(sortTodo((view?.items ?? []).filter((i) => i.list === target)).open);
    const back = { list: item.list, order: item.order };
    change([{ op: "put", id: item.id, list: target, order: top }]);
    setMenu(null);
    say({ text: `已移到「${name}」`, undo: () => (change([{ op: "put", id: item.id, ...back }]), say(null)) });
  }

  /** Alt+↑ / Alt+↓, or a drop: between its new neighbours. */
  function reorder(item: TodoEntry, toIndex: number) {
    const rest = open.filter((i) => i.id !== item.id);
    const at = Math.max(0, Math.min(rest.length, toIndex));
    change([{ op: "put", id: item.id, order: todoOrderBetween(rest[at - 1], rest[at]) }]);
  }

  // Esc closes what is open first, then hides the window; Alt+1… picks a list.
  const state = useRef({ menu, picker, editing, tabs });
  state.current = { menu, picker, editing, tabs };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        const s = state.current;
        if (s.menu || s.picker) {
          setMenu(null);
          setPicker(null);
          return;
        }
        if (s.editing) return setEditing(null);
        hide();
        return;
      }
      const index = pageFromKey(e, state.current.tabs.length);
      if (index !== null) {
        e.preventDefault();
        setWhich(state.current.tabs[index]!);
        setMenu(null);
        setPicker(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Moves the keyboard focus between the line to type and the rows. */
  function focusRow(index: number) {
    const rows = rootRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? [];
    if (index < 0) return addRef.current?.focus();
    rows[Math.min(index, rows.length - 1)]?.focus();
  }

  function rowKey(e: ReactKeyboardEvent<HTMLDivElement>, item: TodoEntry, index: number) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      if (e.altKey && !item.done) {
        const at = open.findIndex((i) => i.id === item.id);
        reorder(item, at + step);
        return;
      }
      focusRow(index + step);
    } else if (e.key === " ") {
      e.preventDefault();
      toggle(item);
    } else if (e.key === "F2" || e.key === "Enter") {
      e.preventDefault();
      setEditing({ id: item.id, text: item.text });
    } else if (e.key === "Delete") {
      e.preventDefault();
      remove([item], `已删除「${clip(item.text)}」`);
      focusRow(index);
    }
  }

  function onDragOver(e: DragEvent<HTMLDivElement>, item: TodoEntry) {
    if (!dragId.current || item.done) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setDropAt({ id: item.id, after: e.clientY > r.top + r.height / 2 });
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const id = dragId.current;
    dragId.current = null;
    const at = dropAt;
    setDropAt(null);
    const item = open.find((i) => i.id === id);
    if (!item || !at || at.id === id) return;
    const rest = open.filter((i) => i.id !== id);
    const target = rest.findIndex((i) => i.id === at.id);
    reorder(item, target + (at.after ? 1 : 0));
  }

  if (!view) {
    return (
      <div className="pad-root todo-root">
        <header className="pad-head">
          <TodoName />
        </header>
        <div className="pad-rule" aria-hidden="true" />
        <div className="pad-empty">{error ?? "正在读取…"}</div>
      </div>
    );
  }

  const signedOut = view.status === "signed-out" && !view.account;
  const off = view.status === "off";
  const menuItem = menu ? view.items.find((i) => i.id === menu.id) : undefined;
  const targets = [
    { list: todoDeviceList(me), name: "本机" },
    { list: TODO_SHARED_LIST, name: "共通" },
    ...others.map((d) => ({ list: todoDeviceList(d.device), name: d.name })),
  ].filter((t) => t.list !== menuItem?.list);

  const row = (item: TodoEntry, index: number) => (
    <div
      key={item.id}
      className="todo-item"
      data-row=""
      data-done={item.done ? "" : undefined}
      data-menu={menu?.id === item.id ? "" : undefined}
      data-drop={dropAt?.id === item.id ? (dropAt.after ? "after" : "before") : undefined}
      tabIndex={0}
      role="listitem"
      aria-label={item.text}
      data-testid="todo-item"
      draggable={!item.done && !editing}
      onDragStart={(e) => {
        dragId.current = item.id;
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => {
        dragId.current = null;
        setDropAt(null);
      }}
      onDragOver={(e) => onDragOver(e, item)}
      onDrop={onDrop}
      onKeyDown={(e) => rowKey(e, item, index)}
      onDoubleClick={() => setEditing({ id: item.id, text: item.text })}
    >
      {!item.done && (
        <span className="todo-grip" aria-hidden="true">
          ⋮⋮
        </span>
      )}
      <button type="button" className="todo-box" role="checkbox" aria-checked={item.done} aria-label={item.done ? "标成没做完" : "标成做完了"} tabIndex={-1} onClick={() => toggle(item)}>
        {item.done ? "✓" : ""}
      </button>
      {editing?.id === item.id ? (
        <input
          className="todo-edit"
          autoFocus
          aria-label="改这条待办"
          maxLength={TODO_TEXT_LIMIT}
          value={editing.text}
          onChange={(e) => setEditing({ id: item.id, text: e.target.value })}
          onBlur={saveEdit}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              saveEdit();
            }
            e.stopPropagation();
            if (e.key === "Escape") setEditing(null);
          }}
        />
      ) : (
        <span className="todo-text">{item.text}</span>
      )}
      {current === "shared" && item.byName && <span className="todo-from">{item.byDevice === me ? "本机" : item.byName}</span>}
      <button
        type="button"
        className="todo-more"
        aria-label="更多"
        title="移到、复制、删除"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          setPicker(null);
          const root = rootRef.current!.getBoundingClientRect();
          const r = e.currentTarget.getBoundingClientRect();
          setMenu(menu?.id === item.id ? null : { id: item.id, top: Math.min(r.bottom - root.top + 2, root.height - 230) });
        }}
      >
        ⋯
      </button>
    </div>
  );

  const status = statusLine(view);
  const openTotal = countOpen(listId);

  return (
    <div
      className="pad-root todo-root"
      ref={rootRef}
      onMouseDown={(e) => {
        if (!(e.target as HTMLElement).closest(".todo-menu, .todo-more, .todo-pick")) {
          setMenu(null);
          setPicker(null);
        }
      }}
    >
      <header className="pad-head">
        <TodoName />
        {!signedOut && !off && (
          <>
            <nav className="todo-tabs" aria-label="表">
              <button type="button" className="todo-tab" aria-pressed={current === "here"} title={`${view.device.name} 的待办（Alt+1）`} onClick={() => setWhich("here")}>
                本机
              </button>
              <button type="button" className="todo-tab" aria-pressed={current === "shared"} title="同账号的设备共用（Alt+2）" onClick={() => setWhich("shared")}>
                共通
                {countOpen(TODO_SHARED_LIST) > 0 && <span className="todo-n">{countOpen(TODO_SHARED_LIST)}</span>}
              </button>
              <button
                type="button"
                className="todo-tab todo-pick"
                aria-pressed={!!otherName}
                aria-haspopup="menu"
                aria-expanded={!!picker}
                title="同账号的其他设备"
                onClick={(e) => {
                  setMenu(null);
                  const root = rootRef.current!.getBoundingClientRect();
                  setPicker(picker ? null : { left: e.currentTarget.getBoundingClientRect().left - root.left });
                }}
              >
                {otherName ?? "其他"} ▾
              </button>
            </nav>
            <span className="pad-hint">Alt 1–{tabs.length}</span>
          </>
        )}
        <span className="spacer" />
        <button type="button" className="pad-icon pad-hide" aria-label="隐藏待办" title="隐藏（Esc）" onClick={hide}>
          <kbd className="pad-key">Esc</kbd>×
        </button>
      </header>
      <div className="pad-rule" aria-hidden="true" />

      {signedOut || off ? (
        <div className="todo-body">
          <div className="todo-empty" data-testid="todo-signed-out">
            {off ? (
              <>
                <p>待办已关闭。</p>
                <button type="button" className="btn-ghost small pad-copy" onClick={() => void window.amo?.notes?.openSettings()}>
                  打开便签设置
                </button>
              </>
            ) : (
              <>
                <p>
                  待办用团队账号，数据存在服务器上，
                  <br />
                  本机、共通和其他设备的表都能看到。
                </p>
                <button type="button" className="btn-ghost small pad-copy" onClick={() => void openPlatform(link).then((ok) => setPlatformMissing(!ok))}>
                  在 AMO 平台里登录
                </button>
                <small>{platformMissing ? "这台电脑上没找到 AMO 平台：先从团队服务器下载安装平台。" : (view.message ?? "便签不受影响，照常能用。")}</small>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="todo-body" role="list" aria-label="待办">
          {otherName && (
            <div className="pad-notice todo-notice" role="status">
              <span>这是「{otherName}」的待办，加的会出现在那台设备上。</span>
              <button type="button" className="btn-ghost small" onClick={() => setWhich("here")}>
                回到本机
              </button>
            </div>
          )}
          <div className="todo-add">
            <span aria-hidden="true">＋</span>
            <input
              ref={addRef}
              aria-label="添加待办"
              placeholder="添加待办，回车"
              maxLength={TODO_TEXT_LIMIT}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  focusRow(0);
                }
              }}
            />
          </div>
          {open.map((item, i) => row(item, i))}
          {!open.length && !done.length && <div className="todo-none">{view.loaded ? "这张表还是空的。在上面写一条，回车。" : "正在读取…"}</div>}
          {done.length > 0 && (
            <button type="button" className="todo-sec" aria-expanded={openDone} onClick={() => setOpenDone(!openDone)} data-testid="todo-done-toggle">
              <span className="todo-chev">▸</span>已完成 {done.length}
            </button>
          )}
          {openDone && done.map((item, i) => row(item, open.length + i))}
        </div>
      )}

      {picker && (
        <div className="todo-menu" role="menu" style={{ left: picker.left, top: 34 }} data-testid="todo-devices">
          <div className="todo-menu-label">同账号的其他设备</div>
          {others.length ? (
            others.map((d) => (
              <button key={d.device} type="button" role="menuitem" onClick={() => (setWhich(d.device), setPicker(null))}>
                <span>{d.name}</span>
                <span className="pad-hint">{countOpen(todoDeviceList(d.device))} 项</span>
              </button>
            ))
          ) : (
            <div className="todo-menu-note">还没有别的设备用过待办。在另一台电脑上用同一个账号打开待办，它就会出现在这里。</div>
          )}
        </div>
      )}
      {menu && menuItem && (
        <div className="todo-menu" role="menu" style={{ right: 12, top: Math.max(40, menu.top) }} data-testid="todo-menu">
          <div className="todo-menu-label">移到</div>
          {targets.map((t) => (
            <button key={t.list} type="button" role="menuitem" onClick={() => moveTo(menuItem, t.list, t.name)}>
              {t.name}
            </button>
          ))}
          <div className="todo-menu-rule" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void window.amo?.copyText?.(menuItem.text);
              setMenu(null);
              say({ text: "已复制这条" }, 2000);
            }}
          >
            复制这条
          </button>
          <button type="button" role="menuitem" onClick={() => (setEditing({ id: menuItem.id, text: menuItem.text }), setMenu(null))}>
            <span>改字</span>
            <span className="pad-hint">F2</span>
          </button>
          <div className="todo-menu-rule" />
          <button type="button" role="menuitem" className="danger" onClick={() => remove([menuItem], `已删除「${clip(menuItem.text)}」`)}>
            <span>删除</span>
            <span className="pad-hint">Del</span>
          </button>
        </div>
      )}
      {toast && (
        <div className="todo-toast" role="status" data-testid="todo-toast">
          {toast.text}
          {toast.undo && (
            <button type="button" onClick={toast.undo}>
              撤销
            </button>
          )}
        </div>
      )}

      <div className="pad-rule" aria-hidden="true" />
      <footer className="pad-foot">
        <span className={`pad-status todo-status${status.bad ? " bad" : ""}`} data-testid="todo-status" title={status.text}>
          {signedOut || off ? status.text : `${openTotal} 项未完成 · ${status.text}`}
        </span>
        <span className="spacer" />
        {!signedOut && !off && (
          <button type="button" className="btn-ghost small" disabled={!done.length} onClick={() => remove(done, `已清除 ${done.length} 条已完成`)}>
            清除已完成
          </button>
        )}
      </footer>
      {error && <div className="todo-error" role="alert">{error}</div>}
    </div>
  );
}

const clip = (s: string) => (s.length > 12 ? `${s.slice(0, 12)}…` : s);

/** The foot's status: ✓ / ◐ / ! with words (never colour alone). */
function statusLine(v: TodoView): { text: string; bad: boolean } {
  switch (v.status) {
    case "off":
      return { text: "待办已关闭", bad: false };
    case "signed-out":
      return { text: v.account ? `! ${v.message ?? "登录已失效"}` : "未登录", bad: !!v.account };
    case "syncing":
      return { text: "◐ 同步中", bad: false };
    case "offline":
      return { text: `! 连不上服务器${v.pending ? ` · ${v.pending} 条改动待提交` : ""}`, bad: true };
    case "error":
      return { text: `! ${v.message ?? "服务器出错"}${v.pending ? ` · ${v.pending} 条改动待提交` : ""}`, bad: true };
    case "synced":
      return v.message ? { text: `! ${v.message}`, bad: true } : { text: "✓ 已同步", bad: false };
  }
}
