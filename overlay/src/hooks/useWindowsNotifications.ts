import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  sessionArchived,
  sessionHasAttentionSignal,
  sessionNeedsReview,
} from "../domain/sessionModel";
import { projectName } from "../domain/routingModel";
import {
  loadWindowsNotificationsEnabled,
  showWindowsNotification,
  WINDOWS_NOTIFICATIONS_CHANGED_EVENT,
  type WindowsNotificationsChangedEvent,
} from "../native/windowsNotifications";
import type { AgentSession } from "../types";

interface UseWindowsNotificationsOptions {
  brokerReady: boolean;
  postDebugLog: (event: string, data?: unknown) => void;
  sessions: AgentSession[];
}

function attentionNotificationKey(session: AgentSession) {
  if (sessionNeedsReview(session)) {
    return `review|${session.reviewTurnId || session.reviewRequestedAt || session.lastReplyAt || session.updatedAt}`;
  }

  return [
    session.state,
    session.lastEvent,
    session.pendingPromptId || "",
    session.lastMessage || session.updatedAt,
  ].join("|");
}

function attentionNotificationTitle(session: AgentSession) {
  if (sessionNeedsReview(session)) {
    return "AMO: Ready for review";
  }
  if (session.state === "waiting_permission") {
    return "AMO: Permission required";
  }
  if (session.state === "failed" || /error|fail/i.test(session.lastEvent)) {
    return "AMO: Task failed";
  }
  return "AMO: Task needs attention";
}

function toolLabel(session: AgentSession) {
  if (session.tool === "claude" || session.tool === "claude-cli") return "Claude CLI";
  if (session.tool === "codex-app") return "Codex App";
  if (session.tool === "codex" || session.tool === "codex-cli") return "Codex CLI";
  return session.tool;
}

function attentionNotificationBody(session: AgentSession) {
  const taskName = session.taskTitle?.trim() || session.title?.trim() || projectName(session.cwd || "") || "Agent task";
  const context = [projectName(session.cwd || session.workspacePath || ""), toolLabel(session)]
    .filter(Boolean)
    .join(" | ");
  const message = session.lastMessage?.replace(/\s+/g, " ").trim();
  const preview = message ? message.slice(0, 140) : "Open AMO to continue.";
  return [taskName, context, preview].filter(Boolean).join("\n");
}

export function useWindowsNotifications({
  brokerReady,
  postDebugLog,
  sessions,
}: UseWindowsNotificationsOptions) {
  const [enabled, setEnabled] = useState(() => loadWindowsNotificationsEnabled());
  const previousAttentionKeysRef = useRef<Map<string, string> | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .listen<WindowsNotificationsChangedEvent>(WINDOWS_NOTIFICATIONS_CHANGED_EVENT, (event) => {
        setEnabled(event.payload?.enabled !== false);
      })
      .then((handler) => {
        unlisten = handler;
      });

    function handleStorage(event: StorageEvent) {
      if (event.key === "amo.notifications.windows.enabled") {
        setEnabled(event.newValue !== "false");
      }
    }

    window.addEventListener("storage", handleStorage);
    return () => {
      unlisten?.();
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    if (!brokerReady) {
      return;
    }

    const attentionSessions = sessions.filter(
      (session) => !sessionArchived(session) && sessionHasAttentionSignal(session),
    );
    const currentKeys = new Map(
      attentionSessions.map((session) => [session.sessionId, attentionNotificationKey(session)]),
    );
    const previousKeys = previousAttentionKeysRef.current;
    previousAttentionKeysRef.current = currentKeys;

    if (previousKeys === null) {
      postDebugLog("windows_notification.baseline", {
        attentionCount: attentionSessions.length,
      });
      return;
    }

    const newlyAttention = attentionSessions.filter(
      (session) => previousKeys.get(session.sessionId) !== currentKeys.get(session.sessionId),
    );
    if (!enabled || newlyAttention.length === 0) {
      return;
    }

    newlyAttention.forEach((session) => {
      void showWindowsNotification(
        attentionNotificationTitle(session),
        attentionNotificationBody(session),
      ).then((result) => {
        postDebugLog(result.ok ? "windows_notification.sent" : "windows_notification.skipped", {
          sessionId: session.sessionId,
          message: result.message,
        });
      });
    });
  }, [brokerReady, enabled, sessions]);

  return { windowsNotificationsEnabled: enabled };
}
