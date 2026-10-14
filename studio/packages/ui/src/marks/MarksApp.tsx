import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { showToast } from "../lib/toast.js";
import { isCommon, lineLabel, lineSuffix, type FileMark, type StateSnapshot, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useHostState } from "../host/useHostState.js";
import { openInApps, openInEditor, revealInExplorer } from "../lib/openin.js";
import { FileSelector } from "../attach/FileSelector.js";
import { dragHasFiles, pathOfFile } from "../attach/useAttachments.js";
import { baseName, dirName } from "../attach/refs.js";
import { IconFile } from "../attach/icons.js";
import { useFileMarks } from "./useFileMarks.js";
import { QuickLook } from "./QuickLook.js";
import { filterGroups, groupMarks, markDragData, parseMarksHash, parseRange, pastedPaths, rangeText, relativeTo, type MarkGroup, type MarksTarget } from "./logic.js";

// The marks window (文件标记, S12-D; #marks?workspace=…): marked files and folders by project, each with its note.
// Files come in by dropping them from Explorer, "+ 标记文件" (the project's file selector) or pasting a path; a row
// dragged into a session's composer becomes a file reference that carries the note.

export function MarksApp() {
  const host = useHostState();
  const [target, setTarget] = useState<MarksTarget>(() => parseMarksHash(location.hash) ?? {});
  // Opened again from another project: the window stays, the hash changes.
  useEffect(() => {
    const on = () => setTarget(parseMarksHash(location.hash) ?? {});
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    document.title = "文件标记";
  }, []);

  if (host.kind !== "ready") return <div className="placeholder">{host.kind === "connecting" ? "正在连接 Host…" : `未连接：${host.reason}`}</div>;
  return <MarksPage link={host.link} state={host.state} currentId={target.workspaceId ?? null} focus={target.markId ? target : null} />;
}

/** The mark the window was opened at: scrolled to and flashed, its note focused when `edit`. */
type Focus = Pick<MarksTarget, "markId" | "edit" | "nonce">;

type Toast = { text: string; error?: boolean } | null;

const message = (err: unknown) => (err instanceof HostApiError ? err.message : String(err));

function MarksPage({ link, state, currentId, focus }: { link: HostLink; state: StateSnapshot; currentId: string | null; focus: Focus | null }) {
  const { marks } = useFileMarks(link);
  const [query, setQuery] = useState("");
  // Opened at a mark: a search that hides it goes.
  useEffect(() => {
    if (focus?.markId) setQuery("");
  }, [focus?.markId, focus?.nonce]);
  const [pasted, setPasted] = useState("");
  const setToast = useCallback((t: Toast) => void (t && showToast(t)), []);
  const [picking, setPicking] = useState<Workspace | null>(null);
  const [looking, setLooking] = useState<FileMark | null>(null);
  const [dropping, setDropping] = useState(false);
  const [vscode, setVscode] = useState(false);

  useEffect(() => {
    void openInApps(link)
      .then((a) => setVscode(a.vscode))
      .catch(() => setVscode(false));
  }, [link]);

  const projects = state.workspaces.filter((w) => !isCommon(w));
  const current = projects.find((w) => w.id === currentId) ?? null;
  // "+ 标记文件" picks from the project in front, or the first one.
  const pickFrom = current ?? projects[0] ?? null;
  const groups = filterGroups(groupMarks(marks ?? [], state.workspaces, current?.id ?? null), query);
  const total = marks?.length ?? 0;

  const add = useCallback(
    async (paths: readonly string[]) => {
      const clean = paths.map((p) => p.trim()).filter(Boolean);
      if (!clean.length) return;
      let added = 0;
      let known = 0;
      const failed: string[] = [];
      for (const path of clean) {
        try {
          const r = await call(link, "POST /api/file-marks", {}, { path });
          if (r.created) added++;
          else known++;
        } catch (err) {
          failed.push(message(err));
        }
      }
      if (failed.length) setToast({ text: failed.length === 1 ? failed[0]! : `有 ${failed.length} 个没有标记：${failed[0]}`, error: true });
      else if (added) setToast({ text: clean.length === 1 ? `已标记 ${baseName(clean[0]!)}` : `已标记 ${added} 个${known ? `，${known} 个之前标记过` : ""}` });
      else setToast({ text: clean.length === 1 ? `${baseName(clean[0]!)} 已经标记过` : "这些都已经标记过" });
    },
    [link],
  );

  // Ctrl+V outside a text field: files copied in Explorer, or paths as text.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, [contenteditable]")) return;
      const files = [...(e.clipboardData?.files ?? [])].map(pathOfFile).filter(Boolean);
      const paths = files.length ? files : pastedPaths(e.clipboardData?.getData("text/plain") ?? "");
      if (!paths.length) return;
      e.preventDefault();
      void add(paths);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [add]);

  const dropTarget = {
    onDragOver: (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropping(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
    },
    onDrop: (e: DragEvent) => {
      setDropping(false);
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      const files = [...e.dataTransfer.files];
      const paths = files.map(pathOfFile).filter(Boolean);
      if (paths.length < files.length) setToast({ text: `有 ${files.length - paths.length} 个文件拿不到路径，没有标记`, error: true });
      void add(paths);
    },
  };

  return (
    <div className="mk-app" data-dropping={dropping || undefined} {...dropTarget}>
      <header className="mk-head">
        <span className="mk-title">文件标记</span>
        <span className="mk-dim">{total ? `${total} 个` : ""}</span>
        <input className="mk-search" type="search" value={query} placeholder="搜索路径或说明" aria-label="搜索标记" onChange={(e) => setQuery(e.target.value)} data-testid="marks-search" />
        <span className="spacer" />
        <input
          className="mk-paste"
          value={pasted}
          placeholder="粘贴文件路径，回车标记"
          aria-label="粘贴文件路径"
          onChange={(e) => setPasted(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            const paths = pastedPaths(pasted);
            if (!paths.length) {
              setToast({ text: "请填写完整路径，例如 D:\\game\\drop.lua", error: true });
              return;
            }
            setPasted("");
            void add(paths);
          }}
          data-testid="marks-paste"
        />
        <button
          type="button"
          className="btn-primary"
          disabled={!pickFrom}
          title={pickFrom ? `从 ${pickFrom.name} 里找文件来标记` : "还没有项目：可以把文件拖进来，或粘贴路径"}
          onClick={() => pickFrom && setPicking(pickFrom)}
          data-testid="marks-add"
        >
          + 标记文件
        </button>
      </header>
      <div className="mk-body">
        {marks === null && <div className="mk-empty">正在读取…</div>}
        {marks !== null && !total && (
          <div className="mk-empty" data-testid="marks-empty">
            还没有标记。把文件从资源管理器拖进来、粘贴路径，或点「+ 标记文件」。
            <br />
            标记的文件可以在对话里用 @ 找到，也可以直接拖进输入框。
          </div>
        )}
        {marks !== null && total > 0 && !groups.length && <div className="mk-empty">没有匹配「{query.trim()}」的标记</div>}
        {groups.map((g) => (
          <Group
            key={g.workspaceId ?? "other"}
            group={g}
            current={g.workspaceId !== null && g.workspaceId === current?.id}
            link={link}
            vscode={vscode}
            onPick={g.workspaceId ? () => setPicking(projects.find((w) => w.id === g.workspaceId) ?? null) : undefined}
            onLook={setLooking}
            onToast={setToast}
            focus={focus}
          />
        ))}
      </div>
      <footer className="mk-foot">拖动一条标记到会话的输入框，或在输入框里输入 @，就能把文件和说明交给 AI。</footer>
      {picking && (
        <FileSelector
          link={link}
          workspaceId={picking.id}
          action="标记"
          onPick={(path) => void add([path])}
          onClose={() => setPicking(null)}
        />
      )}
      {looking && (
        <QuickLook
          link={link}
          mark={looking}
          vscode={vscode}
          onOpenInEditor={() => void openInEditor(link, { path: looking.path }, looking.startLine ?? undefined).catch((err: unknown) => setToast({ text: message(err), error: true }))}
          onClose={() => setLooking(null)}
        />
      )}
    </div>
  );
}

function Group({
  group,
  current,
  link,
  vscode,
  onPick,
  onLook,
  onToast,
  focus,
}: {
  group: MarkGroup;
  current: boolean;
  link: HostLink;
  vscode: boolean;
  onPick?: () => void;
  onLook(mark: FileMark): void;
  onToast(t: Toast): void;
  focus: Focus | null;
}) {
  return (
    <section className="mk-group" data-testid="marks-group" data-current={current || undefined}>
      <div className="mk-group-head">
        <span className="mk-group-name">{group.name}</span>
        {current && <span className="mk-tag">当前项目</span>}
        <span className="mk-dim mk-group-path" title={group.path}>
          {group.path || "不在任何项目里的文件"}
        </span>
        <span className="spacer" />
        <span className="mk-dim">{group.marks.length}</span>
        {onPick && (
          <button type="button" className="mk-link" onClick={onPick} title={`从 ${group.name} 里找文件来标记`}>
            + 标记
          </button>
        )}
      </div>
      {!group.marks.length && <div className="mk-group-empty">这个项目还没有标记。</div>}
      {group.marks.map((m) => (
        <MarkRow
          key={m.id}
          mark={m}
          folder={group.path}
          link={link}
          vscode={vscode}
          onLook={() => onLook(m)}
          onToast={onToast}
          focus={focus?.markId === m.id ? focus : null}
        />
      ))}
    </section>
  );
}

const SAVE_DELAY_MS = 600;

function MarkRow({
  mark,
  folder,
  link,
  vscode,
  onLook,
  onToast,
  focus,
}: {
  mark: FileMark;
  folder: string;
  link: HostLink;
  vscode: boolean;
  onLook(): void;
  onToast(t: Toast): void;
  focus: Focus | null;
}) {
  const rowRef = useRef<HTMLElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [flash, setFlash] = useState(false);
  // Opened at this mark (the 标记 button elsewhere): bring it into view, flash it, and for a new one, the note.
  useEffect(() => {
    if (!focus) return;
    rowRef.current?.scrollIntoView({ block: "center" });
    if (focus.edit) noteRef.current?.focus();
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1600);
    return () => clearTimeout(t);
  }, [focus, focus?.nonce]);
  const [note, setNote] = useState(mark.note);
  const [saving, setSaving] = useState<"idle" | "dirty" | "saving" | "saved">("idle");
  const [range, setRange] = useState(rangeText(mark));
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draft = useRef<string | null>(null);

  // Edits from elsewhere (another window, the API) show unless this row has unsaved typing.
  useEffect(() => {
    if (draft.current === null) setNote(mark.note);
  }, [mark.note]);
  useEffect(() => setRange(rangeText(mark)), [mark.startLine, mark.endLine]);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);

  const save = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const text = draft.current;
    if (text === null) return;
    setSaving("saving");
    call(link, "PATCH /api/file-marks/:id", { id: mark.id }, { note: text })
      .then(() => {
        if (draft.current === text) draft.current = null;
        setSaving(draft.current === null ? "saved" : "dirty");
      })
      .catch((err: unknown) => {
        setSaving("dirty");
        onToast({ text: `说明没有保存：${message(err)}`, error: true });
      });
  }, [link, mark.id, onToast]);
  // Closing the window right after typing must not drop the last edit.
  useEffect(() => {
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [save]);

  const saveRange = () => {
    const next = parseRange(range);
    if (!next) {
      onToast({ text: "行号写成 12 或 12-30", error: true });
      setRange(rangeText(mark));
      return;
    }
    if (next.startLine === mark.startLine && next.endLine === mark.endLine) return;
    call(link, "PATCH /api/file-marks/:id", { id: mark.id }, next).catch((err: unknown) => {
      onToast({ text: message(err), error: true });
      setRange(rangeText(mark));
    });
  };

  const fail = (err: unknown) => onToast({ text: message(err), error: true });
  const rel = relativeTo(mark.path, folder);
  const where = rel ? dirName(rel) : dirName(mark.path);

  return (
    <article
      ref={rowRef}
      className="mk-row"
      data-testid="mark-row"
      data-missing={!mark.exists || undefined}
      data-flash={flash || undefined}
      data-mark-id={mark.id}
      data-path={mark.path}
    >
      <div
        className="mk-row-head"
        draggable
        title={`${mark.path}${lineSuffix(mark.startLine, mark.endLine)}\n拖到会话的输入框，交给 AI`}
        onDragStart={(e) => {
          for (const [type, value] of Object.entries(markDragData(mark))) e.dataTransfer.setData(type, value);
          e.dataTransfer.effectAllowed = "copy";
        }}
        data-testid="mark-drag"
      >
        <span className="mk-grip" aria-hidden="true">
          ⋮⋮
        </span>
        {mark.folder ? <IconFolder /> : <IconFile />}
        <span className="mk-name">{baseName(mark.path)}</span>
        {mark.startLine && <span className="mk-lines">{lineLabel(mark.startLine, mark.endLine)}</span>}
        <span className="mk-where">{where}</span>
        {!mark.exists && <span className="mk-missing">文件不存在</span>}
      </div>
      <div className="mk-row-body">
        <textarea
          ref={noteRef}
          className="mk-note"
          value={note}
          rows={Math.min(6, Math.max(1, note.split("\n").length))}
          placeholder="写点说明：这个文件是什么、要 AI 注意什么"
          aria-label={`说明 ${baseName(mark.path)}`}
          onChange={(e) => {
            setNote(e.target.value);
            draft.current = e.target.value;
            setSaving("dirty");
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(save, SAVE_DELAY_MS);
          }}
          onBlur={save}
          data-testid="mark-note"
        />
        <div className="mk-actions">
          {!mark.folder && mark.exists && (
            <input
              className="mk-range"
              value={range}
              placeholder="行号"
              aria-label={`行号 ${baseName(mark.path)}`}
              title="可选：标记的行，例如 12 或 12-30"
              onChange={(e) => setRange(e.target.value)}
              onBlur={saveRange}
              onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
            />
          )}
          <span className="mk-saved" aria-live="polite">
            {saving === "saving" ? "保存中…" : saving === "saved" ? "已保存" : ""}
          </span>
          <span className="spacer" />
          {!mark.folder && (
            <button type="button" className="mk-link" disabled={!mark.exists} onClick={onLook}>
              快速查看
            </button>
          )}
          {vscode && (
            <button type="button" className="mk-link" disabled={!mark.exists} onClick={() => void openInEditor(link, { path: mark.path }, mark.startLine ?? undefined).catch(fail)}>
              VS Code 打开
            </button>
          )}
          <button type="button" className="mk-link" disabled={!mark.exists} onClick={() => void revealInExplorer(link, { path: mark.path }).catch(fail)}>
            在资源管理器中显示
          </button>
          <button
            type="button"
            className={confirming ? "mk-link danger" : "mk-link"}
            onClick={() => {
              if (!confirming) return setConfirming(true);
              call(link, "DELETE /api/file-marks/:id", { id: mark.id }).catch(fail);
            }}
            data-testid="mark-delete"
          >
            {confirming ? "确认删除" : "删除"}
          </button>
        </div>
      </div>
    </article>
  );
}

function IconFolder() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M1.5 4.5v8h13v-7H7.5L6 4H1.5z" strokeLinejoin="round" />
    </svg>
  );
}
