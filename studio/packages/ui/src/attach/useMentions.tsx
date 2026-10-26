import { Fragment, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { absolutePath, type ProjectFile, type Session, type Task } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { mentionAt, withoutMention } from "../newtask/draft.js";
import { usePins } from "../lib/pins.js";
import { useFileMarks } from "../marks/useFileMarks.js";
import type { FileRefItem } from "./refs.js";
import { mentionGroups, mentionSpans, nextSubSessionName, quickCommitName, withMentionRefs, type MentionGroup, type MentionOption, type MentionPick, type SubSessionSpec } from "./mentions.js";

/**
 * @ in a session's composer: tasks, sessions of the same project or topic, recently changed files (or, once something
 * is typed, the project's files that match), the project's marked files (S12-D), and "找文件…" for the selector. A task
 * or session keeps "@名字" in the text and the message says which one it is; a file becomes a reference chip, a marked
 * one carrying its range and note. Under「AMO 扩展功能」: 开子会话… (2026-10-26) asks for a model and effort and puts
 *「@子会话N」in the text, the message then saying how to start sub-sessions with AMO's session_start; 快速提交… (also
 * Ctrl+Shift+P) asks whether to push too and puts「@快速提交」there, the message then saying how to commit, pull, merge.
 */
export function useComposerMentions(input: {
  link: HostLink;
  text: string;
  setText(next: string): void;
  tasks: readonly Task[];
  sessions: readonly Session[];
  current: Session | null;
  /** A file was picked: its absolute path. */
  onFile(path: string): void;
  /** "找文件…": open the selector with what was typed after @. */
  onFind(query: string): void;
  /** A marked file was picked (a plain file reference without this). */
  onMark?(ref: FileRefItem): void;
}) {
  const { link, text, setText, tasks, sessions, current } = input;
  const [caret, setCaret] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [picked, setPicked] = useState<ReadonlyMap<string, MentionPick>>(new Map());
  const [files, setFiles] = useState<{ root: string; files: ProjectFile[] } | null>(null);
  const pins = usePins();
  const mention = caret === null ? null : mentionAt(text, caret);
  const active = mention?.sign === "@" ? mention : null;
  const query = active?.query ?? null;
  const workspaceId = current?.workspaceId ?? null;
  // The project's marks, asked for once @ is first typed and kept current after that.
  const [wantMarks, setWantMarks] = useState(false);
  useEffect(() => {
    if (query !== null) setWantMarks(true);
  }, [query]);
  const { marks } = useFileMarks(link, workspaceId, wantMarks);
  // 开子会话…: where in the text its「@子会话N」goes once the dialog is confirmed.
  const [subAt, setSubAt] = useState<number | null>(null);
  // 快速提交…: likewise for its「@快速提交」.
  const [commitAt, setCommitAt] = useState<number | null>(null);
  const subsession = !!current && current.kind !== "sub" && !!current.taskId && !current.archivedAt;
  const commit = !!current && !current.archivedAt;

  // Files come from the Host: the recent ones for a bare "@", matches once something is typed (debounced).
  useEffect(() => {
    if (query === null || !workspaceId) return;
    let stale = false;
    const timer = setTimeout(
      () => {
        const request = query
          ? call(link, "GET /api/workspaces/:id/files", { id: workspaceId }, undefined, { q: query, limit: "5" })
          : call(link, "GET /api/workspaces/:id/files/recent", { id: workspaceId }, undefined, { limit: "5" });
        request.then((r) => !stale && setFiles({ root: r.root, files: r.files })).catch(() => !stale && setFiles(null));
      },
      query ? 150 : 0,
    );
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, workspaceId, link]);

  const groups = useMemo<MentionGroup[]>(() => {
    if (query === null) return [];
    const pinnedTask = (t: Task) => (!!t.topicId && pins.has("topic", t.topicId)) || pins.has("project", t.workspaceId);
    return mentionGroups({ query, tasks, pinnedTask, sessions, current, files: files?.files ?? [], marks: marks ?? [], subsession, commit });
  }, [query, tasks, pins, sessions, current, files, marks, subsession, commit]);
  const flat = groups.flatMap((g) => g.options);
  const hl = Math.min(highlight, Math.max(flat.length - 1, 0));

  const choose = (option: MentionOption) => {
    if (!active) return;
    setHighlight(0);
    if (option.kind === "file" || option.kind === "find" || option.kind === "mark" || option.kind === "subsession" || option.kind === "commit") {
      setText(withoutMention(text, active));
      setCaret(null);
      if (option.kind === "subsession") setSubAt(active.start);
      else if (option.kind === "commit") setCommitAt(active.start);
      else if (option.kind === "find") input.onFind(active.query);
      else if (option.kind === "mark") {
        const m = marks?.find((x) => x.id === option.id);
        if (m && input.onMark) input.onMark({ path: m.path, startLine: m.startLine, endLine: m.endLine, note: m.note });
        else if (m) input.onFile(m.path);
      } else if (files) input.onFile(absolutePath(files.root, option.id));
      return;
    }
    const inserted = `@${option.name} `;
    setText(text.slice(0, active.start) + inserted + text.slice(active.end));
    setCaret(active.start + inserted.length);
    const session = option.kind === "session" ? sessions.find((s) => s.id === option.id) : undefined;
    const pick: MentionPick = option.kind === "task" ? { kind: "task", id: option.id } : { kind: "session", id: option.id, taskId: session?.taskId ?? null };
    setPicked((cur) => new Map(cur).set(option.name, pick));
  };

  /** `name` put in the text at `at` (a space before it where needed); the caret after it. */
  const insertPick = (at: number, name: string, pick: MentionPick): number => {
    const before = text.slice(0, at);
    const inserted = `${before && !/\s$/.test(before) ? " " : ""}@${name} `;
    setText(before + inserted + text.slice(at));
    setPicked((cur) => new Map(cur).set(name, pick));
    return at + inserted.length;
  };

  return {
    open: flat.length > 0,
    /** 快速提交 is offered here (for Ctrl+Shift+P too). */
    canCommit: commit,
    /** 快速提交…'s dialog is up. */
    askingCommit: commitAt !== null,
    /** Ctrl+Shift+P: 快速提交's dialog, its「@快速提交」 to go at `at`. */
    askCommit(at: number) {
      if (commit) setCommitAt(at);
    },
    /** The dialog's answer (push too, or null when cancelled): the caret after the inserted name. */
    finishCommit(push: boolean | null): number | null {
      const at = Math.min(commitAt ?? text.length, text.length);
      setCommitAt(null);
      return push === null ? null : insertPick(at, quickCommitName(push), { kind: "commit", push });
    },
    /** 开子会话…'s dialog is up. */
    askingSubsession: subAt !== null,
    /** The dialog's answer: 「@子会话N」 where @ was typed; the caret after it (null when cancelled). */
    finishSubsession(spec: SubSessionSpec | null): number | null {
      const at = Math.min(subAt ?? text.length, text.length);
      setSubAt(null);
      if (!spec) return null;
      return insertPick(at, nextSubSessionName(text, picked.keys()), { kind: "subsession", spec });
    },
    groups,
    /** The picked tasks' and sessions' names still in the text (coloured in the composer). */
    names: [...picked.keys()].filter((name) => text.includes(`@${name}`)),
    highlight: hl,
    choose,
    /** Keep the caret known (typing, clicking, arrow keys). */
    track: (el: HTMLTextAreaElement) => setCaret(el.selectionStart),
    /** Handles the list's keys; true when the key was used. */
    onKeyDown(e: KeyboardEvent): boolean {
      if (!flat.length) return false;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => (Math.min(h, flat.length - 1) + (e.key === "ArrowDown" ? 1 : flat.length - 1)) % flat.length);
        return true;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        choose(flat[hl]!);
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setCaret(null);
        return true;
      }
      return false;
    },
    /** The message as sent (see withMentionRefs). Forgets the picks. */
    expand(message: string): string {
      const out = withMentionRefs(message, picked);
      setPicked(new Map());
      return out;
    },
  };
}

export type ComposerMentions = ReturnType<typeof useComposerMentions>;

/**
 * Behind the composer's textarea (10-22): the same text, laid out the same way, with the picked「@名字」coloured. The
 * textarea's own text turns transparent while there is one (its caret and selection stay), so only this layer shows.
 */
export function MentionBackdrop({ text, names, scrollTop }: { text: string; names: readonly string[]; scrollTop: number }) {
  if (!names.length) return null;
  return (
    <div className="mention-backdrop" aria-hidden="true" data-testid="mention-backdrop">
      <div style={{ transform: `translateY(${-scrollTop}px)` }}>
        {mentionSpans(text, names).map((part, i) => (part.mention ? <span key={i} className="mention-token">{part.text}</span> : <Fragment key={i}>{part.text}</Fragment>))}
        {/* A trailing newline needs a character after it to take its line. */}
        {text.endsWith("\n") ? " " : null}
      </div>
    </div>
  );
}

/** The grouped list above the composer. */
export function MentionList({ mentions }: { mentions: ComposerMentions }) {
  if (!mentions.open) return null;
  let index = 0;
  return (
    <div className="suggest mention-list" role="listbox" aria-label="提及" data-testid="suggest">
      {mentions.groups.map((g) => (
        <Fragment key={g.kind}>
          {g.heading && <div className="suggest-h">{g.heading}</div>}
          {g.options.map((o) => {
            const i = index++;
            return (
              <button
                key={`${o.kind}-${o.id}`}
                type="button"
                role="option"
                data-kind={o.kind}
                aria-selected={i === mentions.highlight}
                className={i === mentions.highlight ? "hl" : undefined}
                // mousedown keeps the focus (and caret) in the text field.
                onMouseDown={(e) => {
                  e.preventDefault();
                  mentions.choose(o);
                }}
              >
                <span className="suggest-name">{o.name}</span>
                <span className="suggest-hint">{o.hint}</span>
              </button>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}
