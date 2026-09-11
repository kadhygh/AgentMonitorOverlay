import type { Card } from "../api/cardClient";
import type { FocusCardView, TaskGroup } from "./model";

export const componentOf = (card: Card, type: string) => card.components.find(c => c.type === type && c.schemaVersion === 1);
export const groupOf = (card: Card) => componentOf(card, "amo.task-group")?.data.groupId as string | null | undefined ?? null;
export const noteOf = (card: Card) => componentOf(card, "amo.notes")?.data.text as string | undefined ?? "";
export function groupCommand(card: Card, groupId: string | null) {
  return { type: "set-component", component: { componentId: componentOf(card, "amo.task-group")?.componentId ?? crypto.randomUUID(), type: "amo.task-group", schemaVersion: 1, data: { groupId } } };
}
export function manualLanes(groups: TaskGroup[]) {
  // The panel is an explicitly chosen attention surface, not an automatic inbox.
  return groups;
}
export function cardsInGroup(cards: FocusCardView[], groupId: string | null, groups: TaskGroup[], includeArchived = false) {
  const known = new Set(groups.map(g => g.groupId));
  return cards.filter(c => groupId !== null && known.has(groupId) && (includeArchived || !c.archivedAt) && c.groupId === groupId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.cardId.localeCompare(b.cardId));
}
