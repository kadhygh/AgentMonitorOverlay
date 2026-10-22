import type { ProjectGroup } from "@amo-studio/protocol";

// 项目分组 (2026-10-22): which group a project is in, and the changes the left column makes to the list. The Host keeps
// the list (with Studio's settings); the order of projects inside a group is the left column's own (navOrder).

/** The groups with their projects (in the order given), then the projects in no group. */
export function groupProjects<T extends { id: string }>(projects: readonly T[], groups: readonly ProjectGroup[]): { groups: Array<{ group: ProjectGroup; projects: T[] }>; loose: T[] } {
  const owner = groupOwners(groups);
  return {
    groups: groups.map((group) => ({ group, projects: projects.filter((p) => owner.get(p.id) === group.id) })),
    loose: projects.filter((p) => !owner.has(p.id)),
  };
}

/** Project id → its group's id. */
export function groupOwners(groups: readonly ProjectGroup[]): Map<string, string> {
  const owner = new Map<string, string>();
  for (const g of groups) for (const id of g.workspaceIds) if (!owner.has(id)) owner.set(id, g.id);
  return owner;
}

/** The project moved into a group (null: out of every group). */
export function joinGroup(groups: readonly ProjectGroup[], projectId: string, groupId: string | null): ProjectGroup[] {
  return groups.map((g) => {
    const rest = g.workspaceIds.filter((id) => id !== projectId);
    return { ...g, workspaceIds: g.id === groupId ? [...rest, projectId] : rest };
  });
}

/** One group moved before or after another. */
export function moveGroup(groups: readonly ProjectGroup[], from: string, to: string, after: boolean): ProjectGroup[] {
  const moving = groups.find((g) => g.id === from);
  if (!moving || from === to || !groups.some((g) => g.id === to)) return [...groups];
  const rest = groups.filter((g) => g.id !== from);
  const index = rest.findIndex((g) => g.id === to) + Number(after);
  return [...rest.slice(0, index), moving, ...rest.slice(index)];
}
