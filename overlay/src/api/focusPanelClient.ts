import type { FocusCardView, FocusOperation } from "../focus/model";
import { requestCardJson } from "./cardClient";
export { CardRequestError as FocusRequestError } from "./cardClient";
const FOCUS_URL = "http://127.0.0.1:17654/api/focus-panel";
export async function loadFocusCards(signal?: AbortSignal) {
  const result = await requestCardJson<{ schemaVersion: 2; cards: FocusCardView[] }>(FOCUS_URL, { signal });
  if (result.schemaVersion !== 2 || !Array.isArray(result.cards) || result.cards.some(card => card.schemaVersion !== 2 || !("session" in card) || !("conversation" in card))) throw new Error("The broker returned an unsupported Focus view. A Card component broker with Focus schema 2 is required.");
  return result;
}
export const updateFocusCard = (cardId: string, operation: FocusOperation) => requestCardJson<{ card: FocusCardView }>(`${FOCUS_URL}/cards/${encodeURIComponent(cardId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(operation) });
