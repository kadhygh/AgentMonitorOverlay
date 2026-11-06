import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FolderListing, FolderResult } from "../host/client.js";
import { readStored, writeStored } from "../lib/stored.js";

// 选择文件夹 (2026-10-25): Studio's own folder picker, in place of the system dialog, which loads every Explorer
// extension and once hung for good on a disconnected NAS drive — with Studio's window, which it was modal to. Only
// this machine's own disks; a folder can be made or renamed here. No way back to the system dialog: it hung again
// after the overlay was excluded (2026-10-25), so its button was taken out.

const LAST_KEY = "amo.folderPicker.last";
const readLast = () => readStored(LAST_KEY);
const writeLast = (path: string) => writeStored(LAST_KEY, path);

const inside = (dir: string, name: string) => (dir.endsWith("\\") ? dir + name : `${dir}\\${name}`);
const parentOf = (path: string) => {
  const i = path.lastIndexOf("\\");
  return i <= 2 ? path.slice(0, 3) : path.slice(0, i);
};

/**
 * A folder chosen by the person, or null. Starts at `start` (设置 → 默认路径) when given, else beside the folder
 * chosen last. Outside Electron's main window (no `folders` calls) it is the system dialog as before.
 */
export function pickDirectory(start?: string | null): Promise<string | null> {
  const amo = window.amo;
  if (!amo?.folders) return amo?.pickDirectory?.(start ?? null) ?? Promise.resolve(null);
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (path: string | null) => {
      root.unmount();
      host.remove();
      if (path) writeLast(parentOf(path));
      resolve(path);
    };
    root.render(<FolderPicker start={start?.trim() || readLast()} onDone={done} />);
  });
}

type Edit = { kind: "new"; text: string } | { kind: "rename"; name: string; text: string };

/** A folder's name with the part 在这一层里找 matched marked. */
function Marked({ name, query }: { name: string; query: string }) {
  const q = query.trim().toLowerCase();
  const at = q ? name.toLowerCase().indexOf(q) : -1;
  if (at < 0) return <>{name}</>;
  return (
    <>
      {name.slice(0, at)}
      <mark className="folder-match">{name.slice(at, at + q.length)}</mark>
      {name.slice(at + q.length)}
    </>
  );
}

function unwrap<T>(r: FolderResult<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

export function FolderPicker({ start, onDone }: { start: string | null; onDone(path: string | null): void }) {
  const api = window.amo!.folders!;
  const [drives, setDrives] = useState<string[]>([]);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [pathText, setPathText] = useState(start ?? "");
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Edit | null>(null);
  // 在这一层里找 (2026-11-06; the user: 输入文件夹关键词快速找到文件夹，只做当前选中位置的同层级检索): narrows the folders of the
  // folder shown, by a part of their name, any case; nothing below it is searched. Going to another folder clears it.
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const editBox = useRef<HTMLInputElement>(null);
  const searchBox = useRef<HTMLInputElement>(null);

  /** Shows `path`; the folder named `select` in it highlighted. Keeps what was shown when it cannot be read. */
  async function go(path: string, select: string | null = null): Promise<boolean> {
    setBusy(true);
    try {
      const next = unwrap(await api.list(path));
      setListing(next);
      setPathText(next.path);
      setSelected(select);
      setEdit(null);
      setError("");
      setQuery("");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void (async () => {
      let known: string[] = [];
      try {
        known = unwrap(await api.drives());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      setDrives(known);
      if (start && (await go(start))) return;
      if (known[0] && (await go(known[0])) && start) setError(`打不开 ${start}，先从 ${known[0]} 开始`);
    })();
    list.current?.focus();
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (edit) editBox.current?.select();
    // Only when an edit starts, not on every key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit?.kind, edit?.kind === "rename" ? edit.name : null]);

  useEffect(() => {
    if (selected) list.current?.querySelector<HTMLElement>(`[data-name="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const folders = listing?.folders ?? [];
  const matching = (text: string) => {
    const q = text.trim().toLowerCase();
    return q ? folders.filter((f) => f.toLowerCase().includes(q)) : folders;
  };
  /** The folders shown: those whose name holds what is typed in 在这一层里找. */
  const shown = matching(query);
  /** Highlights a folder; a failed 前往 is forgotten then. */
  const select = (name: string) => {
    setSelected(name);
    setError("");
    if (listing) setPathText(listing.path);
  };
  /** Narrows the list; the highlight goes to the first match when the highlighted folder is no longer shown. */
  const search = (text: string) => {
    setQuery(text);
    const m = matching(text);
    if (selected && m.includes(selected)) return;
    if (m[0]) select(m[0]);
    else setSelected(null);
  };
  const chosen = listing ? (selected ? inside(listing.path, selected) : listing.path) : null;

  function startNew() {
    if (!listing) return;
    setQuery("");
    let text = "新建文件夹";
    for (let n = 2; folders.some((f) => f.toLowerCase() === text.toLowerCase()); n++) text = `新建文件夹 (${n})`;
    setEdit({ kind: "new", text });
    setError("");
  }

  async function commit() {
    if (!edit || !listing) return;
    setBusy(true);
    try {
      const path = unwrap(edit.kind === "new" ? await api.create(listing.path, edit.text) : await api.rename(inside(listing.path, edit.name), edit.text));
      await go(listing.path, path.slice(path.lastIndexOf("\\") + 1));
      list.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  function cancelEdit() {
    setEdit(null);
    setError("");
    list.current?.focus();
  }

  /** ↑ ↓ and Enter, from the list or from 在这一层里找. True when it was one of them. */
  function moveKey(e: React.KeyboardEvent): boolean {
    if (!listing) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return true;
      const i = selected ? shown.indexOf(selected) : -1;
      const next = e.key === "ArrowDown" ? Math.min(i + 1, shown.length - 1) : Math.max(i - 1, 0);
      select(shown[next]!);
      return true;
    }
    if (e.key === "Enter" && selected && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void go(inside(listing.path, selected));
      return true;
    }
    return false;
  }

  function onListKey(e: React.KeyboardEvent) {
    if (edit || !listing) return;
    if (moveKey(e)) return;
    if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Typing on the list starts 在这一层里找 with that letter.
      e.preventDefault();
      search(query + e.key);
      searchBox.current?.focus();
    } else if (e.key === "Backspace" && listing.parent) {
      e.preventDefault();
      const from = listing.path.slice(listing.path.lastIndexOf("\\") + 1);
      void go(listing.parent, from);
    } else if (e.key === "F2" && selected) {
      e.preventDefault();
      setEdit({ kind: "rename", name: selected, text: selected });
    }
  }

  const drive = listing?.path.slice(0, 3);
  const editRow = (
    <div className="folder-row editing">
      <span className="folder-icon" aria-hidden>
        ▸
      </span>
      <input
        ref={editBox}
        className="field folder-edit"
        value={edit?.text ?? ""}
        aria-label={edit?.kind === "new" ? "新文件夹的名字" : "新名字"}
        disabled={busy}
        onChange={(e) => edit && setEdit({ ...edit, text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cancelEdit();
          }
        }}
      />
      <button type="button" className="btn-primary small" disabled={busy || !edit?.text.trim()} onClick={() => void commit()}>
        {edit?.kind === "new" ? "建立" : "改名"}
      </button>
      <button type="button" className="btn-ghost small" disabled={busy} onClick={cancelEdit}>
        取消
      </button>
    </div>
  );

  return (
    <div
      className="folder-picker-scrim"
      onMouseDown={(e) => e.target === e.currentTarget && onDone(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !edit) {
          e.stopPropagation();
          onDone(null);
        } else if (e.key.toLowerCase() === "f" && e.ctrlKey && !edit) {
          e.preventDefault();
          searchBox.current?.select();
        }
      }}
    >
      <div className="folder-picker" role="dialog" aria-modal="true" aria-label="选择文件夹" data-testid="folder-picker">
        <div className="folder-picker-head">
          <span className="modal-title">选择文件夹</span>
          <div className="folder-drives" role="group" aria-label="磁盘">
            {drives.map((d) => (
              <button key={d} type="button" className="chip" aria-pressed={d === drive} disabled={busy} onClick={() => void go(d)}>
                {d.slice(0, 2)}
              </button>
            ))}
          </div>
        </div>
        <form
          className="folder-path"
          onSubmit={(e) => {
            e.preventDefault();
            void go(pathText);
          }}
        >
          <button
            type="button"
            className="btn-ghost small"
            title="上一级（Backspace）"
            aria-label="上一级"
            disabled={busy || !listing?.parent}
            onClick={() => listing?.parent && void go(listing.parent, listing.path.slice(listing.path.lastIndexOf("\\") + 1))}
          >
            ↑
          </button>
          <input className="field" value={pathText} onChange={(e) => setPathText(e.target.value)} aria-label="路径" placeholder="输入或粘贴路径，回车前往" spellCheck={false} />
          <button type="submit" className="btn-ghost small" disabled={busy || !pathText.trim()}>
            前往
          </button>
        </form>
        <div className="folder-search">
          <input
            ref={searchBox}
            className="field"
            type="search"
            value={query}
            aria-label="在这一层里找"
            placeholder="在这一层里找：输入文件夹名字的一部分（在列表上直接打字也行，Ctrl+F）"
            spellCheck={false}
            disabled={!listing || !!edit}
            data-testid="folder-search"
            onChange={(e) => search(e.target.value)}
            onKeyDown={(e) => {
              if (moveKey(e)) return;
              if (e.key === "Escape" && query) {
                // The first Esc clears what was typed; the next one closes the picker.
                e.preventDefault();
                e.stopPropagation();
                search("");
              }
            }}
          />
          {query.trim() && (
            <span className="folder-search-count" data-testid="folder-search-count">
              {shown.length} / {folders.length}
            </span>
          )}
        </div>
        <div className="folder-list" role="listbox" aria-label="文件夹" tabIndex={0} ref={list} onKeyDown={onListKey}>
          {edit?.kind === "new" && editRow}
          {shown.map((name) =>
            edit?.kind === "rename" && edit.name === name ? (
              <div key={name}>{editRow}</div>
            ) : (
              <div
                key={name}
                role="option"
                aria-selected={name === selected}
                data-name={name}
                data-testid="folder-row"
                className={`folder-row${name === selected ? " hl" : ""}`}
                onClick={() => select(name)}
                onDoubleClick={() => listing && void go(inside(listing.path, name))}
              >
                <span className="folder-icon" aria-hidden>
                  ▸
                </span>
                <span className="folder-name">
                  <Marked name={name} query={query} />
                </span>
                <button
                  type="button"
                  className="folder-action"
                  onClick={(e) => {
                    e.stopPropagation();
                    select(name);
                    setEdit({ kind: "rename", name, text: name });
                  }}
                >
                  改名
                </button>
                <button
                  type="button"
                  className="folder-action"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (listing) void go(inside(listing.path, name));
                  }}
                >
                  打开
                </button>
              </div>
            ),
          )}
          {listing && !folders.length && edit?.kind !== "new" && <div className="folder-empty">这里没有文件夹</div>}
          {listing && folders.length > 0 && !shown.length && edit?.kind !== "new" && (
            <div className="folder-empty">这一层没有名字含「{query.trim()}」的文件夹（不找更深的层）</div>
          )}
          {!listing && !error && <div className="folder-empty">正在读取…</div>}
        </div>
        {error && (
          <span className="form-error folder-error" role="alert">
            {error}
          </span>
        )}
        <div className="folder-picker-foot">
          <button type="button" className="btn-ghost small" disabled={busy || !listing || !!edit} onClick={startNew}>
            + 新建文件夹
          </button>
          <span className="folder-hint">双击打开 · F2 改名 · Backspace 上一级</span>
          <span className="spacer" />
          <button type="button" className="btn-ghost small" onClick={() => onDone(null)}>
            取消
          </button>
          <button type="button" className="btn-primary small" disabled={busy || !chosen || !!edit} title={chosen ?? undefined} onClick={() => chosen && onDone(chosen)} data-testid="folder-choose">
            {selected ? `选择「${selected}」` : "选择这个文件夹"}
          </button>
        </div>
      </div>
    </div>
  );
}
