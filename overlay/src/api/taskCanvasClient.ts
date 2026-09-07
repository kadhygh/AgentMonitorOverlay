import type { AgentSession } from "../types";
import type { CanvasBoard, CanvasDocument } from "../canvas/model";

const URL = "http://127.0.0.1:17654/api/task-canvas";
export class CanvasRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const abort = () => controller.abort();
  init.signal?.addEventListener("abort", abort, { once: true });
  if (init.signal?.aborted) controller.abort();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new CanvasRequestError(response.status === 409 ? "Board changed elsewhere. Your edits are preserved. Reload to use the stored board." : payload?.message ?? payload?.error ?? `Broker returned ${response.status}`, response.status);
    return payload as T;
  } finally { clearTimeout(timeout); init.signal?.removeEventListener("abort", abort); }
}
export const loadCanvas = () => request<{ board: CanvasBoard }>(URL);
export const saveCanvas = (operationId: string, expectedRevision: number, document: CanvasDocument) => request<{ board: CanvasBoard }>(URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId, expectedRevision, document }) });
export async function loadCanvasSessions(ids: string[], signal?: AbortSignal): Promise<{ sessions: AgentSession[] }> {
  const chunks: string[][] = [];
  let chunk: string[] = [], length = 0;
  for (const id of [...new Set(ids)]) {
    const encoded = encodeURIComponent(id);
    if (chunk.length && length + encoded.length + 1 > 6000) { chunks.push(chunk); chunk = []; length = 0; }
    chunk.push(encoded); length += encoded.length + 1;
  }
  if (chunk.length) chunks.push(chunk);
  const sessions: AgentSession[] = [];
  for (const batch of chunks) {
    const result = await request<{ sessions: AgentSession[] }>(`${URL}/sessions?ids=${batch.join(",")}`, { signal });
    sessions.push(...result.sessions);
  }
  return { sessions };
}
