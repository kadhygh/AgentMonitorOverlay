import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelProfile, Session, SessionOptions, Task, TaskTemplateChoice } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { defaultProfile, rememberProfile, rememberWorkspace } from "../lib/profiles.js";
import { rememberPick, type ModelPick } from "../lib/recents.js";

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
}

const KEY = "amo.taskDraft";

export function emptyDraft(profiles: readonly ModelProfile[]): TaskDraft {
  return { title: "", text: "", projectId: null, topicId: null, pick: { profileId: defaultProfile(profiles)?.id ?? "", model: null }, options: {} };
}

function load(profiles: readonly ModelProfile[]): TaskDraft {
  const fresh = emptyDraft(profiles);
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<TaskDraft> | null;
    if (!d || typeof d !== "object") return fresh;
    const pick = d.pick && profiles.some((p) => p.id === d.pick!.profileId && !p.hidden) ? d.pick : fresh.pick;
    return {
      title: typeof d.title === "string" ? d.title : "",
      text: typeof d.text === "string" ? d.text : "",
      projectId: typeof d.projectId === "string" ? d.projectId : null,
      topicId: typeof d.topicId === "string" ? d.topicId : null,
      pick,
      options: d.options && typeof d.options === "object" ? d.options : {},
      ...(d.lead === true ? { lead: true } : {}),
    };
  } catch {
    return fresh;
  }
}

function save(d: TaskDraft): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    // per-viewer convenience only
  }
}

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
 * `onCanvas`: a task in a topic also goes on that topic's canvas ("显示在画布上").
 */
export async function submitDraft(link: HostLink, draft: TaskDraft, file: boolean, template?: TaskTemplateChoice, onCanvas = false): Promise<{ task: Task; session: Session | null }> {
  const text = draft.text.trim();
  const options: SessionOptions = { ...draft.options, ...(draft.pick.model ? { model: draft.pick.model } : {}) };
  const created = await call(link, "POST /api/tasks", {}, {
    ...(draft.title.trim() ? { title: draft.title.trim() } : file ? { title: text.split("\n")[0]!.slice(0, 60) } : {}),
    workspaceId: draft.projectId,
    topicId: draft.topicId,
    ...(draft.lead ? { lead: true } : {}),
    ...(file ? {} : { firstSession: { profileId: draft.pick.profileId, ...(text ? { text } : {}), ...(Object.keys(options).length ? { options } : {}) } }),
    ...(template ? { template } : {}),
  });
  if (!file) {
    rememberProfile(draft.pick.profileId);
    rememberPick(draft.pick);
  }
  if (draft.projectId) rememberWorkspace(draft.projectId);
  if (onCanvas && created.task.topicId) await call(link, "PUT /api/tasks/:id/canvas", { id: created.task.id }, { onCanvas: true });
  return created;
}

/** An `@project` or `#topic` being typed right before the caret. */
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
