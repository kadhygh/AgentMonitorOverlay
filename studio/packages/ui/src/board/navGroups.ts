import type { ProjectGroup, TopicGroup } from "@amo-studio/protocol";

// 项目分组 (2026-10-22) and 专题分组 (2026-10-27): which group a project or topic is in, and the changes the left column
// makes to a list. The Host keeps both lists (with Studio's settings); the order of entries inside a group is the left
// column's own (navOrder). Both kinds are handled as one shape here, `members` being the project or topic ids.

export interface NavGroup {
  id: string;
  name: string;
  description: string;
  members: string[];
}

export const fromProjectGroups = (groups: readonly ProjectGroup[]): NavGroup[] => groups.map((g) => ({ id: g.id, name: g.name, description: g.description, members: g.workspaceIds }));
export const toProjectGroups = (groups: readonly NavGroup[]): ProjectGroup[] => groups.map((g) => ({ id: g.id, name: g.name, description: g.description, workspaceIds: g.members }));
export const fromTopicGroups = (groups: readonly TopicGroup[]): NavGroup[] => groups.map((g) => ({ id: g.id, name: g.name, description: g.description, members: g.topicIds }));
export const toTopicGroups = (groups: readonly NavGroup[]): TopicGroup[] => groups.map((g) => ({ id: g.id, name: g.name, description: g.description, topicIds: g.members }));

/** The groups with their entries (in the order given), then the entries in no group. */
export function groupEntries<T extends { id: string }>(entries: readonly T[], groups: readonly NavGroup[]): { groups: Array<{ group: NavGroup; entries: T[] }>; loose: T[] } {
  const owner = groupOwners(groups);
  return {
    groups: groups.map((group) => ({ group, entries: entries.filter((p) => owner.get(p.id) === group.id) })),
    loose: entries.filter((p) => !owner.has(p.id)),
  };
}

/** Entry id → its group's id. */
export function groupOwners(groups: readonly NavGroup[]): Map<string, string> {
  const owner = new Map<string, string>();
  for (const g of groups) for (const id of g.members) if (!owner.has(id)) owner.set(id, g.id);
  return owner;
}

/** The entry moved into a group (null: out of every group). */
export function joinGroup(groups: readonly NavGroup[], entryId: string, groupId: string | null): NavGroup[] {
  return groups.map((g) => {
    const rest = g.members.filter((id) => id !== entryId);
    return { ...g, members: g.id === groupId ? [...rest, entryId] : rest };
  });
}

/** One group moved before or after another. */
export function moveGroup(groups: readonly NavGroup[], from: string, to: string, after: boolean): NavGroup[] {
  const moving = groups.find((g) => g.id === from);
  if (!moving || from === to || !groups.some((g) => g.id === to)) return [...groups];
  const rest = groups.filter((g) => g.id !== from);
  const index = rest.findIndex((g) => g.id === to) + Number(after);
  return [...rest.slice(0, index), moving, ...rest.slice(index)];
}
