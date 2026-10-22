import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { showToast } from "../lib/toast.js";
import { isCommon, lineLabel, lineSuffix, type Bookmark, type ChatMark, type FileMark, type Session, type StateSnapshot, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, copyText, HostApiError, type HostLink } from "../host/client.js";
import { useHostState } from "../host/useHostState.js";
import { openInApps, openInEditor, revealInExplorer } from "../lib/openin.js";
import { FileSelector } from "../attach/FileSelector.js";
import { dragHasFiles, pathOfFile } from "../attach/useAttachments.js";
import { baseName, dirName } from "../attach/refs.js";
import { IconFile } from "../attach/icons.js";
import { useBookmarks } from "./useFileMarks.js";
import { askBookmarkNote } from "./NotePrompt.js";
import { openMarks, openPassage } from "./open.js";
import { openViewer } from "../viewer/open.js";
import {
  chatDragText,
  filterGroups,
  findMark,
  markDragData,
  NO_TOPIC,
  parseMarksHash,
  parseRange,
  pastedPaths,
  rangeText,
  relativeTo,
  scopedGroups,
  scopeKey,
  scopesFor,
  type BookmarkGroup,
  type MarksScope,
  type MarksTarget,
} from "./logic.js";

// The bookmarks window (书签, 2026-10-19; it was 文件标记, S12-D; #marks?topic=…): bookmarks by topic, each a file (or
// folder) or a passage of a conversation, with a note. Files come in by dropping them from Explorer, "+ 文件" (a
// project's file selector) or pasting a path, and go under the topic in front; passages come from a reply's selection
// bar. A file row dragged into a composer becomes a file reference with the note, a passage row a quote.

export function MarksApp() {
  const host = useHostState();
  const [target, setTarget] = useState<MarksTarget>(() => parseMarksHash(location.hash) ?? {});
  // Opened again from another topic: the window stays, the hash changes.
  useEffect(() => {
    const on = () => setTarget(parseMarksHash(location.hash) ?? {});
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => {
    document.title = "书签";
  }, []);

  if (host.kind !== "ready") return <div className="placeholder">{host.kind === "connecting" ? "正在连接 Host…" : `未连接：${host.reason}`}</div>;
  return <MarksPage link={host.link} state={host.state} target={target} focus={target.markId ? target : null} />;
}

/** The bookmark the window was opened at: scrolled to and flashed, its note focused when `edit`. */
type Focus = Pick<MarksTarget, "markId" | "edit" | "nonce">;

type Toast = { text: string; error?: boolean } | null;

const message = (err: unknown) => (err instanceof HostApiError ? err.message : String(err));
const toast = (t: Toast) => void (t && showToast(t));

/** The projects of a topic: added by hand, and its tasks'. */
function topicProjects(state: StateSnapshot, topicId: string | null): Workspace[] {
  const projects = state.workspaces.filter((w) => !isCommon(w) && !w.archivedAt);
  if (!topicId) return projects;
  const topic = state.topics.find((t) => t.id === topicId);
  const ids = new Set([...(topic?.workspaceIds ?? []), ...state.tasks.filter((t) => t.topicId === topicId).map((t) => t.workspaceId)]);
  const mine = projects.filter((w) => ids.has(w.id));
  return mine.length ? mine : projects;
}

const SCOPE_KEY = "amo.marksScope";
const SCOPE_KEEP = 300;

/** 显示范围 as last chosen where the window was opened from (a task, else a topic or project; 2026-10-22). */
function readScopes(): Record<string, MarksScope> {
  try {
    const all = JSON.parse(localStorage.getItem(SCOPE_KEY) ?? "{}") as unknown;
    return all && typeof all === "object" ? (all as Record<string, MarksScope>) : {};
  } catch {
    return {};
  }
}

function useScope(target: MarksTarget): [MarksScope, (scope: MarksScope) => void] {
  const key = scopeKey(target);
  const [chosen, setChosen] = useState<MarksScope | undefined>(() => readScopes()[key]);
  useEffect(() => setChosen(readScopes()[key]), [key]);
  const choose = (scope: MarksScope) => {
    setChosen(scope);
    try {
      // The newest choices last; the oldest go once there are too many.
      const { [key]: _, ...rest } = readScopes();
      const entries = [...Object.entries(rest), [key, scope] as const].slice(-SCOPE_KEEP);
      localStorage.setItem(SCOPE_KEY, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // no storage: kept as long as the window
    }
  };
  // A remembered scope the window cannot offer now (no topic or project in front) shows everything.
  const scope = chosen && scopesFor(target)[chosen] ? chosen : "all";
  return [scope, choose];
}

/** Whether VS Code can open files here (the 「VS Code 打开」 link). */
function useVsCode(link: HostLink): boolean {
  const [vscode, setVscode] = useState(false);
  useEffect(() => {
    void openInApps(link)
      .then((a) => setVscode(a.vscode))
      .catch(() => setVscode(false));
  }, [link]);
  return vscode;
}

function MarksPage({ link, state, target, focus }: { link: HostLink; state: StateSnapshot; target: MarksTarget; focus: Focus | null }) {
  const marks = useBookmarks(link);
  const [query, setQuery] = useState("");
  // Opened at a bookmark: a search that hides it goes.
  useEffect(() => {
    if (focus?.markId) setQuery("");
  }, [focus?.markId, focus?.nonce]);
  const [pasted, setPasted] = useState("");
  const [picking, setPicking] = useState<{ workspace: Workspace; topicId: string | null } | null>(null);
  const [dropping, setDropping] = useState(false);
  const vscode = useVsCode(link);

  // The topic in front: where pasted and dropped files go.
  const current = target.topicId && target.topicId !== "none" && state.topics.some((t) => t.id === target.topicId) ? target.topicId : null;
  const [scope, setScope] = useScope(target);
  const groups = filterGroups(scopedGroups(marks ?? [], state.topics, target, current, scope), query);
  const total = marks?.length ?? 0;
  const currentName = current ? (state.topics.find((t) => t.id === current)?.title ?? NO_TOPIC) : NO_TOPIC;
  const projectName = target.workspaceId ? (state.workspaces.find((w) => w.id === target.workspaceId)?.name ?? "") : "";
  const offered = scopesFor(target);
  const scopes: Array<{ scope: MarksScope; label: string; name: string; off: string }> = [
    { scope: "topic", label: "当前专题", name: target.topicId ? currentName : "", off: "从任务或专题打开书签时可用" },
    { scope: "project", label: "当前项目", name: projectName, off: "从任务或项目打开书签时可用" },
    { scope: "all", label: "全部", name: "", off: "" },
  ];
  // "+ 文件" in the toolbar picks from the project asked for, else the topic's first.
  const pickFor = (topicId: string | null): Workspace | null => {
    const projects = topicProjects(state, topicId);
    return projects.find((w) => w.id === target.workspaceId) ?? projects[0] ?? null;
  };

  const add = useCallback(
    async (paths: readonly string[], topicId: string | null) => {
      const clean = paths.map((p) => p.trim()).filter(Boolean);
      if (!clean.length) return;
      let added = 0;
      let known = 0;
      const failed: string[] = [];
      // One new file: its note first (书签说明, 2026-10-20). Several at once are noted here in the list afterwards.
      let note = "";
      if (clean.length === 1) {
        const marks = await call(link, "GET /api/file-marks").catch(() => []);
        if (!findMark(marks, { path: clean[0]! }, null)) note = await askBookmarkNote(baseName(clean[0]!));
      }
      for (const path of clean) {
        try {
          const r = await call(link, "POST /api/file-marks", {}, { path, topicId, ...(note ? { note } : {}) });
          if (r.created) added++;
          else known++;
        } catch (err) {
          failed.push(message(err));
        }
      }
      if (failed.length) toast({ text: failed.length === 1 ? failed[0]! : `有 ${failed.length} 个没有加上：${failed[0]}`, error: true });
      else if (added) toast({ text: clean.length === 1 ? `书签添加成功：${baseName(clean[0]!)}` : `已加 ${added} 个书签${known ? `，${known} 个之前加过` : ""}` });
      else toast({ text: clean.length === 1 ? `${baseName(clean[0]!)} 已经在书签里` : "这些都已经在书签里" });
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
      void add(paths, current);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [add, current]);

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
      if (paths.length < files.length) toast({ text: `有 ${files.length - paths.length} 个文件拿不到路径，没有加上`, error: true });
      void add(paths, current);
    },
  };
  const pickFrom = pickFor(current);

  return (
    <div className="mk-app" data-dropping={dropping || undefined} {...dropTarget}>
      <header className="mk-head">
        <span className="mk-title">书签</span>
        <span className="mk-dim">{total ? `${total} 个` : ""}</span>
        <input className="mk-search" type="search" value={query} placeholder="搜索路径、原文或说明" aria-label="搜索书签" onChange={(e) => setQuery(e.target.value)} data-testid="marks-search" />
        <span className="spacer" />
        <input
          className="mk-paste"
          value={pasted}
          placeholder={`粘贴文件路径，回车加到「${currentName}」`}
          aria-label="粘贴文件路径"
          onChange={(e) => setPasted(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            const paths = pastedPaths(pasted);
            if (!paths.length) {
              toast({ text: "请填写完整路径，例如 D:\\game\\drop.lua", error: true });
              return;
            }
            setPasted("");
            void add(paths, current);
          }}
          data-testid="marks-paste"
        />
        <button
          type="button"
          className="btn-primary"
          disabled={!pickFrom}
          title={pickFrom ? `从 ${pickFrom.name} 里找文件，加到「${currentName}」` : "还没有项目：可以把文件拖进来，或粘贴路径"}
          onClick={() => pickFrom && setPicking({ workspace: pickFrom, topicId: current })}
          data-testid="marks-add"
        >
          + 文件
        </button>
      </header>
      <div className="mk-filter" role="radiogroup" aria-label="显示范围" data-testid="marks-scope">
        {scopes.map((s) => (
          <button
            key={s.scope}
            type="button"
            role="radio"
            aria-checked={scope === s.scope}
            className="mk-scope"
            disabled={!offered[s.scope]}
            title={offered[s.scope] ? (s.name ? `${s.label}：${s.name}` : "所有专题的书签") : s.off}
            onClick={() => setScope(s.scope)}
            data-testid={`marks-scope-${s.scope}`}
          >
            {s.label}
            {s.name && <span className="mk-scope-name">{s.name}</span>}
          </button>
        ))}
        {target.taskId && <span className="mk-dim">这个任务会记住你的选择</span>}
      </div>
      <div className="mk-body">
        {marks === null && <div className="mk-empty">正在读取…</div>}
        {marks !== null && !total && (
          <div className="mk-empty" data-testid="marks-empty">
            还没有书签。在对话里选中一段回复，点「书签」；文件可以拖进来、粘贴路径，或点「+ 文件」。
            <br />
            书签按专题放；拖一条到会话的输入框，就能交给 AI。
          </div>
        )}
        {marks !== null && total > 0 && !groups.length && (
          <div className="mk-empty">{query.trim() ? `没有匹配「${query.trim()}」的书签` : `当前项目「${projectName}」还没有书签`}</div>
        )}
        {groups.map((g) => (
          <Group
            key={g.topicId ?? "none"}
            group={g}
            current={!!target.topicId && g.topicId === current}
            link={link}
            state={state}
            vscode={vscode}
            projects={topicProjects(state, g.topicId)}
            onPick={(workspace) => setPicking({ workspace, topicId: g.topicId })}
            focus={focus}
          />
        ))}
      </div>
      <footer className="mk-foot">拖动一条书签到会话的输入框：文件成为引用，对话片段成为引文。也可以在输入框里输入 @ 找到书签里的文件。</footer>
      {picking && (
        <FileSelector
          link={link}
          workspaceId={picking.workspace.id}
          action="加书签"
          onPick={(path) => void add([path], picking.topicId)}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}

function Group({
  group,
  current,
  link,
  state,
  vscode,
  projects,
  onPick,
  focus,
}: {
  group: BookmarkGroup;
  current: boolean;
  link: HostLink;
  state: StateSnapshot;
  vscode: boolean;
  projects: readonly Workspace[];
  onPick(workspace: Workspace): void;
  focus: Focus | null;
}) {
  const [choosing, setChoosing] = useState(false);
  return (
    <section className="mk-group" data-testid="marks-group" data-current={current || undefined} data-topic={group.topicId ?? "none"}>
      <div className="mk-group-head">
        <span className="mk-group-name">{group.name}</span>
        {current && <span className="mk-tag">当前专题</span>}
        {group.archived && <span className="mk-dim">已归档</span>}
        <span className="spacer" />
        <span className="mk-dim">{group.marks.length}</span>
        {projects.length > 0 && (
          <span className="mk-pick">
            <button
              type="button"
              className="mk-link"
              onClick={() => (projects.length === 1 ? onPick(projects[0]!) : setChoosing((v) => !v))}
              title={projects.length === 1 ? `从 ${projects[0]!.name} 里找文件` : "选一个项目，从里面找文件"}
              data-testid="marks-group-add"
            >
              + 文件
            </button>
            {choosing && (
              <span className="mk-pick-menu" role="menu">
                {projects.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setChoosing(false);
                      onPick(w);
                    }}
                  >
                    {w.name}
                  </button>
                ))}
              </span>
            )}
          </span>
        )}
      </div>
      {!group.marks.length && <div className="mk-group-empty">这个专题还没有书签。</div>}
      <BookmarkRows marks={group.marks} link={link} state={state} vscode={vscode} focus={focus} />
    </section>
  );
}

/** What the rows read of Studio's state. */
export type BookmarkState = { tasks: readonly Task[]; sessions: readonly Session[]; topics: readonly Topic[]; workspaces: readonly Workspace[] };

/** Rows of bookmarks, files and passages (the window's groups, and the topic page's 书签 tab). */
export function BookmarkRows({ marks, link, state, vscode, focus = null }: { marks: readonly Bookmark[]; link: HostLink; state: BookmarkState; vscode: boolean; focus?: Focus | null }) {
  return (
    <>
      {marks.map((m) =>
        m.kind === "chat" ? (
          <ChatRow key={m.id} mark={m} link={link} state={state} focus={focus?.markId === m.id ? focus : null} />
        ) : (
          <FileRow
            key={m.id}
            mark={m}
            folder={state.workspaces.find((w) => w.id === m.workspaceId)?.path ?? ""}
            link={link}
            topics={state.topics}
            vscode={vscode}
            focus={focus?.markId === m.id ? focus : null}
          />
        ),
      )}
    </>
  );
}

/** The topic-page tab: one topic's bookmarks, as rows (2026-10-19). */
export function TopicBookmarks({ link, state, topicId }: { link: HostLink; state: BookmarkState; topicId: string }) {
  const marks = useBookmarks(link, topicId);
  const vscode = useVsCode(link);
  return (
    <div className="mk-side" data-testid="topic-bookmarks">
      <div className="mk-side-head">
        <span className="side-note">在对话里选中一段回复点「书签」，或在查看器里点「书签」，就会加到这里。</span>
        <button type="button" className="mk-link" onClick={() => openMarks({ topicId })} data-testid="topic-bookmarks-open">
          打开书签窗口
        </button>
      </div>
      {marks === null && <div className="mk-group-empty">正在读取…</div>}
      {marks !== null && !marks.length && <div className="mk-group-empty">这个专题还没有书签。</div>}
      {marks && <BookmarkRows marks={marks} link={link} state={state} vscode={vscode} />}
    </div>
  );
}

const SAVE_DELAY_MS = 600;

/** A bookmark's note, saved a moment after typing stops (and when leaving the field or closing the window). */
function useNote(link: HostLink, mark: Bookmark) {
  const [note, setNote] = useState(mark.note);
  const [saving, setSaving] = useState<"idle" | "dirty" | "saving" | "saved">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draft = useRef<string | null>(null);
  // Edits from elsewhere (another window, the API) show unless this row has unsaved typing.
  useEffect(() => {
    if (draft.current === null) setNote(mark.note);
  }, [mark.note]);
  const save = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const text = draft.current;
    if (text === null) return;
    setSaving("saving");
    call(link, "PATCH /api/bookmarks/:id", { id: mark.id }, { note: text })
      .then(() => {
        if (draft.current === text) draft.current = null;
        setSaving(draft.current === null ? "saved" : "dirty");
      })
      .catch((err: unknown) => {
        setSaving("dirty");
        toast({ text: `说明没有保存：${message(err)}`, error: true });
      });
  }, [link, mark.id]);
  // Closing the window right after typing must not drop the last edit.
  useEffect(() => {
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [save]);
  const change = (text: string) => {
    setNote(text);
    draft.current = text;
    setSaving("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(save, SAVE_DELAY_MS);
  };
  return { note, saving, change, save };
}

/** Opened at this bookmark: bring it into view, flash it, and for a new one, the note. */
function useFocusRow(focus: Focus | null) {
  const rowRef = useRef<HTMLElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!focus) return;
    rowRef.current?.scrollIntoView({ block: "center" });
    if (focus.edit) noteRef.current?.focus();
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1600);
    return () => clearTimeout(t);
  }, [focus, focus?.nonce]);
  return { rowRef, noteRef, flash };
}

/** 删除, asking once more first. */
function DeleteLink({ link, id }: { link: HostLink; id: string }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(t);
  }, [confirming]);
  return (
    <button
      type="button"
      className={confirming ? "mk-link danger" : "mk-link"}
      onClick={() => {
        if (!confirming) return setConfirming(true);
        call(link, "DELETE /api/bookmarks/:id", { id }).catch((err: unknown) => toast({ text: message(err), error: true }));
      }}
      data-testid="mark-delete"
    >
      {confirming ? "确认删除" : "删除"}
    </button>
  );
}

/** Which topic a bookmark is under; picking another moves it there. */
function TopicSelect({ link, mark, topics }: { link: HostLink; mark: Bookmark; topics: readonly Topic[] }) {
  const shown = topics.filter((t) => !t.archivedAt || t.id === mark.topicId);
  const value = mark.topicId && shown.some((t) => t.id === mark.topicId) ? mark.topicId : "";
  return (
    <select
      className="mk-topic"
      value={value}
      aria-label="专题"
      title="移到另一个专题"
      onChange={(e) => {
        const topicId = e.target.value || null;
        call(link, "PATCH /api/bookmarks/:id", { id: mark.id }, { topicId }).catch((err: unknown) => toast({ text: message(err), error: true }));
      }}
      data-testid="mark-topic"
    >
      <option value="">{NO_TOPIC}</option>
      {shown.map((t) => (
        <option key={t.id} value={t.id}>
          {t.title}
        </option>
      ))}
    </select>
  );
}

function SavedNote({ saving }: { saving: "idle" | "dirty" | "saving" | "saved" }) {
  return (
    <span className="mk-saved" aria-live="polite">
      {saving === "saving" ? "保存中…" : saving === "saved" ? "已保存" : ""}
    </span>
  );
}

function FileRow({ mark, folder, link, topics, vscode, focus }: { mark: FileMark; folder: string; link: HostLink; topics: readonly Topic[]; vscode: boolean; focus: Focus | null }) {
  const { rowRef, noteRef, flash } = useFocusRow(focus);
  const { note, saving, change, save } = useNote(link, mark);
  const [range, setRange] = useState(rangeText(mark));
  useEffect(() => setRange(rangeText(mark)), [mark.startLine, mark.endLine]);

  const saveRange = () => {
    const next = parseRange(range);
    if (!next) {
      toast({ text: "行号写成 12 或 12-30", error: true });
      setRange(rangeText(mark));
      return;
    }
    if (next.startLine === mark.startLine && next.endLine === mark.endLine) return;
    call(link, "PATCH /api/bookmarks/:id", { id: mark.id }, next).catch((err: unknown) => {
      toast({ text: message(err), error: true });
      setRange(rangeText(mark));
    });
  };

  const fail = (err: unknown) => toast({ text: message(err), error: true });
  const rel = relativeTo(mark.path, folder);
  const where = rel ? dirName(rel) : dirName(mark.path);
  // 查看 (stage 13): the viewer window, the bookmarked lines marked.
  const look = () =>
    openViewer({ path: mark.path, ...(mark.workspaceId ? { workspaceId: mark.workspaceId } : {}), ...(mark.startLine ? { line: mark.startLine, ...(mark.endLine ? { endLine: mark.endLine } : {}) } : {}) });

  return (
    <article
      ref={rowRef}
      className="mk-row"
      data-testid="mark-row"
      data-kind="file"
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
          onChange={(e) => change(e.target.value)}
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
              title="可选：书签的行，例如 12 或 12-30"
              onChange={(e) => setRange(e.target.value)}
              onBlur={saveRange}
              onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
            />
          )}
          <TopicSelect link={link} mark={mark} topics={topics} />
          <SavedNote saving={saving} />
          <span className="spacer" />
          {!mark.folder && (
            <button type="button" className="mk-link" disabled={!mark.exists} title="在查看器里打开，标出书签的行" onClick={look} data-testid="mark-view">
              查看
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
          <DeleteLink link={link} id={mark.id} />
        </div>
      </div>
    </article>
  );
}

/** A bookmarked passage: the text, where it is (task · session), the note; 打开对话 goes there in the workbench. */
function ChatRow({ mark, link, state, focus }: { mark: ChatMark; link: HostLink; state: BookmarkState; focus: Focus | null }) {
  const { rowRef, noteRef, flash } = useFocusRow(focus);
  const { note, saving, change, save } = useNote(link, mark);
  const [open, setOpen] = useState(false);
  const task = mark.taskId ? state.tasks.find((t) => t.id === mark.taskId) : undefined;
  const session = state.sessions.find((s) => s.id === mark.sessionId);
  const sessionTitle = session?.title || mark.sessionTitle || "会话";
  const from = task ? `${task.title} · ${sessionTitle}` : sessionTitle;
  const gone = !mark.exists;
  const long = mark.quote.length > 280 || mark.quote.split("\n").length > 6;

  return (
    <article ref={rowRef} className="mk-row" data-testid="mark-row" data-kind="chat" data-missing={gone || undefined} data-flash={flash || undefined} data-mark-id={mark.id}>
      <div
        className="mk-row-head"
        draggable
        title={`${from}\n拖到会话的输入框，作为引文交给 AI`}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", chatDragText(mark, from));
          e.dataTransfer.effectAllowed = "copy";
        }}
        data-testid="mark-drag"
      >
        <span className="mk-grip" aria-hidden="true">
          ⋮⋮
        </span>
        <IconChat />
        <span className="mk-from">{from}</span>
        {gone && <span className="mk-missing">{session ? "这段回复不在了" : "会话已删除"}</span>}
      </div>
      <div className="mk-row-body">
        <blockquote className={open || !long ? "mk-quote" : "mk-quote clamped"} data-testid="mark-quote">
          {mark.quote}
        </blockquote>
        {long && (
          <button type="button" className="mk-link mk-more" onClick={() => setOpen((v) => !v)}>
            {open ? "收起" : "展开全文"}
          </button>
        )}
        <textarea
          ref={noteRef}
          className="mk-note"
          value={note}
          rows={Math.min(6, Math.max(1, note.split("\n").length))}
          placeholder="写点说明：为什么记下这段"
          aria-label="说明 这段对话"
          onChange={(e) => change(e.target.value)}
          onBlur={save}
          data-testid="mark-note"
        />
        <div className="mk-actions">
          <TopicSelect link={link} mark={mark} topics={state.topics} />
          <SavedNote saving={saving} />
          <span className="spacer" />
          <button
            type="button"
            className="mk-link"
            disabled={gone || !task}
            title={gone ? "原来的回复已经不在了" : task ? "在主窗口打开这段对话，定位到这段话" : "这是专题会话，到专题页里打开"}
            onClick={() => openPassage(mark)}
            data-testid="mark-open-passage"
          >
            打开对话
          </button>
          <button type="button" className="mk-link" onClick={() => void copyText(mark.quote).then(() => toast({ text: "已复制原文" }))}>
            复制原文
          </button>
          <DeleteLink link={link} id={mark.id} />
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

function IconChat() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" strokeLinejoin="round" />
    </svg>
  );
}
