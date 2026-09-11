import type { FocusCardView, FocusOperation, TaskGroup } from "../focus/model";
import { requestCardJson } from "./cardClient";
export { CardRequestError as FocusRequestError } from "./cardClient";
const FOCUS_URL = "http://127.0.0.1:17654/api/focus-panel";
export async function loadFocusCards(signal?: AbortSignal) {
  const result = await requestCardJson<{ schemaVersion: 2; cards: FocusCardView[]; groups: TaskGroup[]; groupRevision: number }>(`${FOCUS_URL}?includeArchived=1`, { signal });
  if (result.schemaVersion !== 2 || !Array.isArray(result.cards) || result.cards.some(card => card.schemaVersion !== 2 || !("session" in card) || !("conversation" in card))) throw new Error("The broker returned an unsupported Focus view. A Card component broker with Focus schema 2 is required.");
  if (!Array.isArray(result.groups) || !Number.isSafeInteger(result.groupRevision) || result.cards.some(card => !("groupId" in card) || !("archivedAt" in card))) throw new Error("This broker does not support manual Task groups. Start the matching AMO broker before using Focus Panel.");
  return result;
}
export const updateFocusCard = (cardId: string, operation: FocusOperation) => requestCardJson<{ card: FocusCardView }>(`${FOCUS_URL}/cards/${encodeURIComponent(cardId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(operation) });
