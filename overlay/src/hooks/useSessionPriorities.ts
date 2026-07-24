import { useState, type Dispatch, type SetStateAction } from "react";
import {
  BROKER_SESSION_DISPLAY_ORDER_URL,
  BROKER_SESSION_PRIORITIES_URL,
  postBrokerJson,
} from "../api/brokerClient";
import { mergeChangedSession } from "../domain/sessionModel";
import type { AgentSession, SessionPriority } from "../types";

export interface SessionPriorityUpdateResult {
  ok: boolean;
  priority: SessionPriority | null;
  count: number;
  sessionIds: string[];
  sessions: AgentSession[];
}

interface SessionDisplayOrderResult {
  ok: boolean;
  count: number;
  sessionIds: string[];
  sessions: AgentSession[];
}

interface UseSessionPrioritiesOptions {
  postDebugLog: (event: string, data?: unknown) => void;
  setFeedback: Dispatch<SetStateAction<string>>;
  setSessions: Dispatch<SetStateAction<AgentSession[]>>;
}

export function useSessionPriorities(options: UseSessionPrioritiesOptions) {
  const [priorityBusy, setPriorityBusy] = useState(false);

  async function updateSessionPriorities(sessionIds: string[], priority: SessionPriority | null) {
    if (sessionIds.length === 0 || priorityBusy) return false;

    setPriorityBusy(true);
    try {
      const result = await postBrokerJson<SessionPriorityUpdateResult>(BROKER_SESSION_PRIORITIES_URL, {
        sessionIds,
        priority,
      });
      options.setSessions((previous) =>
        result.sessions.reduce(
          (current, session) => mergeChangedSession(current, session),
          previous,
        ),
      );
      options.setFeedback(
        priority
          ? `Set ${result.count} card${result.count === 1 ? "" : "s"} to ${priority}.`
          : `Cleared priority from ${result.count} card${result.count === 1 ? "" : "s"}.`,
      );
      options.postDebugLog("session.priority.update.ok", {
        sessionIds: result.sessionIds,
        priority,
        count: result.count,
      });
      return true;
    } catch (error) {
      const message = (error as Error).message;
      options.setFeedback(`Priority update failed: ${message}`);
      options.postDebugLog("session.priority.update.error", { sessionIds, priority, message });
      return false;
    } finally {
      setPriorityBusy(false);
    }
  }

  async function persistSessionDisplayOrder(sessionIds: string[]) {
    if (sessionIds.length === 0) return;
    try {
      await postBrokerJson<SessionDisplayOrderResult>(BROKER_SESSION_DISPLAY_ORDER_URL, { sessionIds });
      options.postDebugLog("session.display_order.update.ok", { sessionIds });
    } catch (error) {
      const message = (error as Error).message;
      options.setFeedback(`Could not save card order: ${message}`);
      options.postDebugLog("session.display_order.update.error", { sessionIds, message });
    }
  }

  return {
    persistSessionDisplayOrder,
    priorityBusy,
    updateSessionPriorities,
  };
}
