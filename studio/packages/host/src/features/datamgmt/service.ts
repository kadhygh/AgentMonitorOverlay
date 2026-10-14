import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { collectSubtreeIds, isCommon, type ArchivedEntry, type DataKind, type Id, type PurgeSummary, type Session } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

const KINDS: readonly DataKind[] = ["workspace", "topic", "task", "session"];

/** What one deletion takes: the ids by kind, plus its title. */
interface PurgeSet {
  title: string;
  workspaceIds: Id[];
  topicIds: Id[];
  taskIds: Id[];
  sessionIds: Id[];
}

/**
 * 设置 → 数据管理 (2026-10-14): lists what is archived and deletes it for good. Only archived things can go, with
 * everything that belongs only to them (Store.purge); nothing live may hang on them (a restored fork of a deleted
 * session, a restored task of a deleted project). Files in projects and the CLIs' own records are never touched.
 */
export class DataFeature extends Feature {
  archived(): ArchivedEntry[] {
    const workspaces = this.store.listWorkspaces();
    const topics = this.store.listTopics();
    const tasks = this.store.listTasks();
    const sessions = this.store.listSessions();
    const wsName = (id: Id) => {
      const w = workspaces.find((x) => x.id === id);
      return w && !isCommon(w) ? `项目 ${w.name}` : "";
    };
    const topicName = (id: Id | null) => (id ? `专题 ${topics.find((x) => x.id === id)?.title ?? ""}` : "");
    const out: ArchivedEntry[] = [];
    for (const w of workspaces) if (w.archivedAt && !isCommon(w)) out.push({ kind: "workspace", id: w.id, title: w.name, context: w.path, archivedAt: w.archivedAt });
    for (const t of topics) if (t.archivedAt) out.push({ kind: "topic", id: t.id, title: t.title, context: "", archivedAt: t.archivedAt });
    for (const t of tasks) {
      if (!t.archivedAt) continue;
      // Shown under its project or topic while that one is archived too: deleting that takes it.
      if (workspaces.find((w) => w.id === t.workspaceId)?.archivedAt || (t.topicId && topics.find((x) => x.id === t.topicId)?.archivedAt)) continue;
      out.push({ kind: "task", id: t.id, title: t.title, context: [wsName(t.workspaceId), topicName(t.topicId)].filter(Boolean).join(" · "), archivedAt: t.archivedAt });
    }
    for (const s of sessions) {
      if (!s.archivedAt) continue;
      const parent = s.parentId ? sessions.find((x) => x.id === s.parentId) : null;
      if (parent?.archivedAt) continue;
      const task = s.taskId ? tasks.find((x) => x.id === s.taskId) : null;
      const topic = s.topicId ? topics.find((x) => x.id === s.topicId) : null;
      if (task?.archivedAt || topic?.archivedAt || workspaces.find((w) => w.id === s.workspaceId)?.archivedAt) continue;
      out.push({ kind: "session", id: s.id, title: s.title || "会话", context: task ? `任务 ${task.title}` : topic ? `专题 ${topic.title}` : "", archivedAt: s.archivedAt });
    }
    return out.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  }

  preview(kind: unknown, id: unknown): PurgeSummary {
    const { k, set } = this.resolve(kind, id);
    return this.summary(k, String(id), set);
  }

  purge(kind: unknown, id: unknown): PurgeSummary {
    const { k, set } = this.resolve(kind, id);
    const summary = this.summary(k, String(id), set);
    const { attachmentIds } = this.store.countItems(set.sessionIds);
    this.store.purge(set);
    for (const ws of set.workspaceIds) this.f.projects.dropHints(ws);
    this.publish({ type: "data.purged", workspaceIds: set.workspaceIds, topicIds: set.topicIds, taskIds: set.taskIds, sessionIds: set.sessionIds });
    // Pasted images nothing mentions any more.
    let removed = 0;
    for (const att of attachmentIds) if (!this.store.attachmentInUse(att) && this.removeAttachment(att)) removed++;
    return { ...summary, attachments: removed };
  }

  private summary(kind: DataKind, id: Id, set: PurgeSet): PurgeSummary {
    const { items, attachmentIds } = this.store.countItems(set.sessionIds);
    return {
      kind,
      id,
      title: set.title,
      workspaces: set.workspaceIds.length,
      topics: set.topicIds.length,
      tasks: set.taskIds.length,
      sessions: set.sessionIds.length,
      items,
      attachments: attachmentIds.length,
    };
  }

  /** The ids a deletion takes, after checking it is archived and nothing live depends on it. */
  private resolve(kind: unknown, id: unknown): { k: DataKind; set: PurgeSet } {
    if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) throw new HostError("bad_request", "kind must be workspace, topic, task or session");
    if (typeof id !== "string" || !id) throw new HostError("bad_request", "id is required");
    const k = kind as DataKind;
    const sessions = this.store.listSessions();
    const tasks = this.store.listTasks();
    let set: PurgeSet;
    if (k === "session") {
      const s = this.requireSession(id);
      if (!s.archivedAt) throw new HostError("conflict", "只能彻底删除已归档的会话");
      const owner = sessions.filter((x) => (s.taskId ? x.taskId === s.taskId : x.topicId === s.topicId));
      set = { title: s.title || "会话", workspaceIds: [], topicIds: [], taskIds: [], sessionIds: collectSubtreeIds(owner, s.id) };
    } else if (k === "task") {
      const t = this.requireTask(id);
      if (!t.archivedAt) throw new HostError("conflict", "只能彻底删除已归档的任务");
      set = { title: t.title, workspaceIds: [], topicIds: [], taskIds: [t.id], sessionIds: sessions.filter((x) => x.taskId === t.id).map((x) => x.id) };
    } else if (k === "topic") {
      const tp = this.requireTopic(id);
      if (!tp.archivedAt) throw new HostError("conflict", "只能彻底删除已归档的专题");
      const taskIds = tasks.filter((t) => t.topicId === tp.id).map((t) => t.id);
      set = { title: tp.title, workspaceIds: [], topicIds: [tp.id], taskIds, sessionIds: sessions.filter((x) => x.topicId === tp.id || (x.taskId && taskIds.includes(x.taskId))).map((x) => x.id) };
    } else {
      const ws = this.requireWorkspace(id);
      if (isCommon(ws)) throw new HostError("conflict", "公共目录不能删除");
      if (!ws.archivedAt) throw new HostError("conflict", "只能彻底删除已归档的项目");
      const taskIds = tasks.filter((t) => t.workspaceId === ws.id).map((t) => t.id);
      set = { title: ws.name, workspaceIds: [ws.id], topicIds: [], taskIds, sessionIds: sessions.filter((x) => x.workspaceId === ws.id || (x.taskId && taskIds.includes(x.taskId))).map((x) => x.id) };
    }
    this.checkNothingLive(set, sessions, tasks);
    return { k, set };
  }

  private checkNothingLive(set: PurgeSet, sessions: readonly Session[], tasks: readonly { id: Id; title: string; archivedAt: string | null }[]): void {
    const ids = new Set(set.sessionIds);
    const live = sessions.find((s) => ids.has(s.id) && !s.archivedAt);
    if (live) throw new HostError("conflict", `会话「${live.title || "会话"}」还没归档，先归档它`);
    const liveTask = tasks.find((t) => set.taskIds.includes(t.id) && !t.archivedAt);
    if (liveTask) throw new HostError("conflict", `任务「${liveTask.title}」还没归档，先归档它`);
    const child = sessions.find((s) => !ids.has(s.id) && s.parentId && ids.has(s.parentId));
    if (child) throw new HostError("conflict", `会话「${child.title || "会话"}」是从要删除的会话分出来的，先删除或移走它`);
  }

  /** Removes `<id>.<ext>` and `<id>.json` from the attachments folder. */
  private removeAttachment(id: string): boolean {
    const dir = this.f.attachments.dir();
    if (!existsSync(dir)) return false;
    let any = false;
    for (const name of readdirSync(dir)) {
      if (name === `${id}.json` || (name.startsWith(`${id}.`) && name.length - id.length <= 6)) {
        rmSync(join(dir, name), { force: true });
        any = true;
      }
    }
    return any;
  }
}
