export type TriageState = "pending" | "reviewing" | "later" | "future" | "handled";
export interface TaskGroup { groupId: string; name: string; dragOnly: boolean }
export interface FocusCardView {
  schemaVersion: 2; cardId: string; revision: number;
  title: string; createdAt: string; updatedAt: string;
  groupId: string | null; archivedAt: string | null;
  triage: { state: TriageState; note: string; handledGeneration: number };
  attention: { generation: number; kind: "reply" | "permission" | "input" | "failure" | null; updatedAt: string | null; hasUnseen: boolean };
  session: null | { componentId: string; sessionRef: { frameworkId: string; sessionId: string }; presence: "live" | "archived" | "detached"; execution: string; workspaceId: string | null; workspacePath: string };
  conversation: null | { componentId: string; sessionComponentId: string; surface: "cli" | "app" | "unbound"; bindingKind: string; availability: "online" | "offline" | "unknown"; capabilities: { activate: boolean; resume: boolean } };
}
export interface FocusOperation { operationId: string; expectedRevision: number; action: "set-triage" | "handle"; state?: Exclude<TriageState, "handled">; note?: string; throughGeneration?: number }
export interface NoteDraft { text: string; baseRevision: number; baseNote: string }
export const TRIAGE_LABELS: Record<TriageState, string> = { pending: "Pending", reviewing: "In progress", later: "Later", future: "Future", handled: "Handled" };
export function mergeCard(cards: FocusCardView[], next: FocusCardView) {
  const previous = cards.find(card => card.cardId === next.cardId);
  if (previous && previous.revision > next.revision) return cards;
  return previous ? cards.map(card => card.cardId === next.cardId ? next : card) : [...cards, next];
}
export function mergeSnapshot(previous: FocusCardView[], incoming: FocusCardView[]) {
  const incomingIds = new Set(incoming.map(card => card.cardId));
  return incoming.reduce(mergeCard, previous.filter(card => incomingIds.has(card.cardId)));
}
export function filterCards(cards: FocusCardView[], group: TriageState | "all", search: string) {
  const query = search.trim().toLocaleLowerCase();
  return cards.filter(card => (group === "all" || card.triage.state === group) && `${card.title} ${card.session?.workspacePath ?? ""} ${card.session?.workspaceId ?? ""} ${card.session?.sessionRef.frameworkId ?? ""} ${card.triage.note}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(b.attention.hasUnseen) - Number(a.attention.hasUnseen) || b.updatedAt.localeCompare(a.updatedAt) || a.cardId.localeCompare(b.cardId));
}
export function commandAvailable(card: FocusCardView, action: "activate" | "resume") {
  const { session, conversation } = card;
  return !card.archivedAt && !!session && !!conversation && session.presence === "live" && conversation.sessionComponentId === session.componentId && ["codex", "claude", "grok"].includes(session.sessionRef.frameworkId) && (action !== "resume" || conversation.surface !== "app") && conversation.capabilities[action];
}
export function createOperation(card: FocusCardView, action: FocusOperation["action"], operationId: string, options: { state?: FocusOperation["state"]; draft?: NoteDraft } = {}): FocusOperation {
  return { operationId, expectedRevision: options.draft?.baseRevision ?? card.revision, action, ...(action === "handle" ? { throughGeneration: card.attention.generation } : options.state ? { state: options.state } : {}), ...(options.draft ? { note: options.draft.text } : {}) };
}
