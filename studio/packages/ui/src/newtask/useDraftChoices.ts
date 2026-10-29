import { useRef } from "react";
import { projectWorkspaces, topicWorkspaceIds, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { pinnedFirst, usePins } from "../lib/pins.js";
import { rankChoices, recentIds, topicProject, type Choice } from "./choices.js";
import type { TaskDraft } from "./draft.js";

/**
 * The topic and project of a draft (the new-task page and the quick bar, 2026-10-29): both rows ranked, and picking a
 * topic picks its one preferred project too — unless the person picked a project themselves since the page opened.
 */
export function useDraftChoices({
  draft,
  update,
  workspaces,
  topics,
  tasks,
}: {
  draft: TaskDraft;
  update(patch: Partial<TaskDraft>): void;
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  tasks: readonly Task[];
}) {
  const pins = usePins();
  const projects = projectWorkspaces(workspaces);
  const liveTopics = pinnedFirst(
    topics.filter((t) => !t.archivedAt),
    pins.topic,
    (t) => t.id,
  );
  // The person picked a project on this page; and the one the topic picked by itself, which another topic may replace.
  const pickedByHand = useRef(false);
  const autoPicked = useRef<string | null>(null);

  const projectIds = new Set(projects.map((w) => w.id));
  const preferredOf = (topicId: string | null): string[] => {
    const t = topicId ? liveTopics.find((x) => x.id === topicId) : undefined;
    return t ? topicWorkspaceIds(t, tasks, workspaces).filter((id) => projectIds.has(id)) : [];
  };
  const topic = liveTopics.find((t) => t.id === draft.topicId) ?? null;
  const preferred = preferredOf(draft.topicId);

  const projectChoices: Choice[] = rankChoices(projects, (w) => ({ id: w.id, name: w.name, hint: w.path }), {
    topic: preferred,
    pinned: pins.project,
    recent: recentIds(tasks, (t) => t.workspaceId).filter((id) => projectIds.has(id)),
  });
  const taskCount = (topicId: string) => tasks.filter((t) => t.topicId === topicId && !t.archivedAt).length;
  const topicChoices: Choice[] = rankChoices(liveTopics, (t) => ({ id: t.id, name: t.title, hint: `${taskCount(t.id)} 个任务` }), {
    pinned: pins.topic,
    recent: recentIds(tasks, (t) => t.topicId),
  });

  /** The patch for picking `topicId`, the project being `projectId` now (the draft may not have caught up yet). */
  const topicPatch = (topicId: string | null, projectId: string | null): Partial<TaskDraft> => {
    const patch: Partial<TaskDraft> = { topicId };
    if (pickedByHand.current || (projectId !== null && projectId !== autoPicked.current)) return patch;
    const only = topicProject(preferredOf(topicId));
    autoPicked.current = only;
    if (only !== projectId) patch.projectId = only;
    return patch;
  };

  return {
    projects,
    topics: liveTopics,
    topic,
    preferred,
    projectChoices,
    topicChoices,
    topicPatch,
    pickTopic: (topicId: string | null) => update(topicPatch(topicId, draft.projectId)),
    pickProject: (projectId: string | null) => {
      pickedByHand.current = true;
      update({ projectId });
    },
  };
}
