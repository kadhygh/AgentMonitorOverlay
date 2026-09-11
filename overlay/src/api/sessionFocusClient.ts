import { CardRequestError, requestCardJson, type Card } from "./cardClient";
import type { TaskGroupSnapshot } from "./taskGroupClient";

export interface AddSessionToFocusOperation {
  operationId: string;
  sessionRef: { frameworkId: string; sessionId: string };
  groupId: string;
}

export const loadFocusGroups = (signal?: AbortSignal) => requestCardJson<TaskGroupSnapshot>(
  "http://127.0.0.1:17654/api/card-groups", { signal },
);

export async function addSessionToFocus(operation: AddSessionToFocusOperation) {
  try {
    return await requestCardJson<{ card: Card }>("http://127.0.0.1:17654/api/cards/from-session", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(operation),
    });
  } catch (error) {
    if (error instanceof CardRequestError && error.status === 409) {
      throw new CardRequestError("分组或会话状态已变更。请刷新分组；已归档的会话需要先恢复。", 409);
    }
    throw error;
  }
}
