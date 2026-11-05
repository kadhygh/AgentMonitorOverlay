import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelProfile, Session, SessionOptions, Task } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { defaultProfile, rememberProfile, rememberWorkspace, repick } from "../lib/profiles.js";
import { rememberPick, type ModelPick } from "../lib/recents.js";
import { withMentionRefs, type MentionPick } from "../attach/mentions.js";
import { readStoredJson, writeStoredJson } from "../lib/stored.js";

// The task being written: one draft, shared by the draft task page and the quick bar (Ctrl N), kept across restarts
// so leaving the page never loses it.

export interface TaskDraft {
  /** The task's own name; empty: taken from the first sentence. */
  title: string;
  text: string;
  /** null: no project (the common folder). */
  projectId: string | null;
  topicId: string | null;
  pick: ModelPick;
  /** Effort and permissions; the model comes from `pick`. */
  options: Omit<SessionOptions, "model">;
  /** 主控 (stage 16): the task coordinates its topic (or project). */
  lead?: boolean;
  /**
   * What the「@名字」in the text point at (2026-10-29: projects, tasks, sessions, as in a session's composer); the first
   * message says so (withMentionRefs). Never the task's own project or topic.
   */
  refs?: Record<string, MentionPick>;
}

const KEY = "amo.taskDraft";

export function emptyDraft(profiles: readonly ModelProfile[]): TaskDraft {
  return { title: "", text: "", projectId: null, topicId: null, pick: { profileId: defaultProfile(profiles)?.id ?? "", model: null }, options: {} };
}

function load(profiles: readonly ModelProfile[]): TaskDraft {
  const fresh = emptyDraft(profiles);
  try {
    const d = readStoredJson(KEY) as Partial<TaskDraft> | null | undefined;
    if (!d || typeof d !== "object") return fresh;
    const pick = d.pick && profiles.some((p) => p.id === d.pick!.profileId && !p.hidden && !p.unavailable) ? d.pick : fresh.pick;
    return {
      title: typeof d.title === "string" ? d.title : "",
      text: typeof d.text === "string" ? d.text : "",
      projectId: typeof d.projectId === "string" ? d.projectId : null,
      topicId: typeof d.topicId === "string" ? d.topicId : null,
      pick,
      options: d.options && typeof d.options === "object" ? d.options : {},
      ...(d.lead === true ? { lead: true } : {}),
      ...(d.refs && typeof d.refs === "object" ? { refs: cleanRefs(d.refs) } : {}),
    };
  } catch {
    return fresh;
  }
}

/** Stored picks that still make sense (a project, task or session with its id). */
function cleanRefs(refs: object): Record<string, MentionPick> {
  const out: Record<string, MentionPick> = {};
  for (const [name, p] of Object.entries(refs) as Array<[string, Partial<MentionPick> | null]>) {
    if (!p || typeof p !== "object" || !("id" in p) || typeof p.id !== "string") continue;
    if (p.kind === "task") out[name] = { kind: "task", id: p.id };
    else if (p.kind === "session") out[name] = { kind: "session", id: p.id, taskId: typeof p.taskId === "string" ? p.taskId : null };
    else if (p.kind === "project" && typeof p.path === "string") out[name] = { kind: "project", id: p.id, path: p.path };
  }
  return out;
}

/** The first message as sent: the text, then what its「@名字」point at. */
export function draftText(draft: Pick<TaskDraft, "text" | "refs">): string {
  const text = draft.text.trim();
  return draft.refs ? withMentionRefs(text, new Map(Object.entries(draft.refs))) : text;
}

const save = (d: TaskDraft): void => writeStoredJson(KEY, d);

/** The shared draft. `update` merges; switching the model drops an effort or permission the new one may not take. */
export function useTaskDraft(profiles: readonly ModelProfile[]) {
  const [draft, setDraft] = useState<TaskDraft>(() => load(profiles));
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setDraft(load(profiles));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [profiles]);
  // A model hidden in 设置 → 模型 after the draft took it gives way to the default (问题 #14); so does an empty pick
  // once the profiles have loaded.
  useEffect(() => {
    const next = repick(profiles, draft.pick.profileId);
    if (next === null) return;
    setDraft((cur) => {
      const fixed = { ...cur, pick: { profileId: next, model: null }, options: {} };
      save(fixed);
      return fixed;
    });
  }, [profiles, draft.pick.profileId]);
  const update = useCallback((patch: Partial<TaskDraft>) => {
    setDraft((cur) => {
      const next = { ...cur, ...patch };
      if (patch.pick && patch.pick.profileId !== cur.pick.profileId) next.options = {};
      save(next);
      return next;
    });
  }, []);
  const reset = useCallback(
    (keep: Partial<TaskDraft> = {}) => {
      const next = { ...emptyDraft(profiles), pick: latest.current.pick, ...keep };
      save(next);
      setDraft(next);
    },
    [profiles],
  );
  return { draft, update, reset };
}

/**
 * Creates the task: `file` only files it in 待办 (no session, no model call); otherwise its first session starts.
 * `onCanvas`: a task in a topic also goes on that topic's canvas ("显示在画布上"). `attachments`: uploaded images that go
 * with the first message (not when only filing).
 */
/** `resumeFrom` (接续已有会话, 2026-11-05): the outside Claude session the first session goes on from; the text may be empty then. */
export async function submitDraft(link: HostLink, draft: TaskDraft, file: boolean, onCanvas = false, attachments: readonly string[] = [], resumeFrom?: string): Promise<{ task: Task; session: Session | null }> {
  const text = draftText(draft);
  const options: SessionOptions = { ...draft.options, ...(draft.pick.model ? { model: draft.pick.model } : {}) };
  const created = await call(link, "POST /api/tasks", {}, {
    ...(draft.title.trim() ? { title: draft.title.trim() } : file ? { title: text.split("\n")[0]!.slice(0, 60) } : {}),
    workspaceId: draft.projectId,
    topicId: draft.topicId,
    ...(draft.lead ? { lead: true } : {}),
    // 放进待办 (2026-11-05): the sentence is kept on the task for its first session; it used to be cut to the title.
    ...(file
      ? { firstMessage: text }
      : { firstSession: { profileId: draft.pick.profileId, ...(text ? { text } : {}), ...(Object.keys(options).length ? { options } : {}), ...(attachments.length ? { attachments: [...attachments] } : {}), ...(resumeFrom ? { resumeFrom } : {}) } }),
  });
  if (!file) {
    rememberProfile(draft.pick.profileId);
    rememberPick(draft.pick);
  }
  if (draft.projectId) rememberWorkspace(draft.projectId);
  if (onCanvas && created.task.topicId) await call(link, "PUT /api/tasks/:id/canvas", { id: created.task.id }, { onCanvas: true });
  return created;
}

/** An `@名字` (or, in older uses, `#名字`) being typed right before the caret. */
export interface Mention {
  sign: "@" | "#";
  query: string;
  start: number;
  end: number;
}

export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)([@#])([^\s@#]*)$/.exec(before);
  if (!m) return null;
  const start = before.length - m[3]!.length - 1;
  return { sign: m[2] as "@" | "#", query: m[3]!, start, end: caret };
}

/** The text with the mention taken out (and the doubled space it leaves). */
export function withoutMention(text: string, mention: Mention): string {
  return (text.slice(0, mention.start) + text.slice(mention.end)).replace(/ {2,}/g, " ");
}
