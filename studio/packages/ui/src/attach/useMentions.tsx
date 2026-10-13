import { Fragment, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { absolutePath, type ProjectFile, type Session, type Task } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { mentionAt, withoutMention } from "../newtask/draft.js";
import { usePins } from "../lib/pins.js";
import { mentionGroups, withMentionRefs, type MentionGroup, type MentionOption, type MentionPick } from "./mentions.js";

/**
 * @ in a session's composer: tasks, sessions of the same project or topic, recently changed files (or, once something
 * is typed, the project's files that match), and "找文件…" for the selector. A task or session keeps "@名字" in the
 * text and the message says which one it is; a file becomes a reference chip.
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
    return mentionGroups({ query, tasks, pinnedTask, sessions, current, files: files?.files ?? [] });
  }, [query, tasks, pins, sessions, current, files]);
  const flat = groups.flatMap((g) => g.options);
  const hl = Math.min(highlight, Math.max(flat.length - 1, 0));

  const choose = (option: MentionOption) => {
    if (!active) return;
    setHighlight(0);
    if (option.kind === "file" || option.kind === "find") {
      setText(withoutMention(text, active));
      setCaret(null);
      if (option.kind === "find") input.onFind(active.query);
      else if (files) input.onFile(absolutePath(files.root, option.id));
      return;
    }
    const inserted = `@${option.name} `;
    setText(text.slice(0, active.start) + inserted + text.slice(active.end));
    setCaret(active.start + inserted.length);
    const session = option.kind === "session" ? sessions.find((s) => s.id === option.id) : undefined;
    const pick: MentionPick = option.kind === "task" ? { kind: "task", id: option.id } : { kind: "session", id: option.id, taskId: session?.taskId ?? null };
    setPicked((cur) => new Map(cur).set(option.name, pick));
  };

  return {
    open: flat.length > 0,
    groups,
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
