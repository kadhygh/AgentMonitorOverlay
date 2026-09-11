export class CardRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export interface CardComponent { componentId: string; type: string; schemaVersion: number; data: Record<string, unknown> }
export interface Card { schemaVersion: 1; cardId: string; title: string; revision: number; createdAt: string; updatedAt: string; archivedAt: string | null; components: CardComponent[] }
export interface CreateCardOperation { operationId: string; title: string; components: CardComponent[] }
export function plannedCardOperation(operationId: string, title: string, note: string, processingId: string, notesId: string): CreateCardOperation {
  return { operationId, title: title.trim(), components: [
    { componentId: processingId, type: "amo.processing", schemaVersion: 1, data: { sourceComponentId: null, state: "pending" } },
    { componentId: notesId, type: "amo.notes", schemaVersion: 1, data: { text: note } },
  ] };
}
export const createCard = (operation: CreateCardOperation) => requestCardJson<{ card: Card }>("http://127.0.0.1:17654/api/cards", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(operation) });
export async function requestCardJson<T>(url: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new CardRequestError(response.status === 409 ? "This card changed elsewhere. Refresh and review the latest update before trying again. Your note draft is kept." : typeof payload?.message === "string" ? payload.message : typeof payload?.error === "string" ? payload.error : `Broker returned ${response.status}`, response.status);
    if (!payload) throw new Error("Broker returned an empty response. Your draft is kept.");
    return payload as T;
  } catch (reason) {
    if (timedOut) throw new Error("The broker did not respond in time. Retry the same request to confirm its result.");
    throw reason;
  } finally { clearTimeout(timer); init.signal?.removeEventListener("abort", abort); }
}
