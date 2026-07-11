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

const PERMISSION_NOTIFICATION_DELAY_MS = 10_000;

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
  const sessionsRef = useRef(sessions);
  const enabledRef = useRef(enabled);
  const pendingPermissionNotificationsRef = useRef<
    Map<string, { key: string; timer: number }>
  >(new Map());

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    const pending = pendingPermissionNotificationsRef.current;
    return () => {
      pending.forEach(({ timer }) => window.clearTimeout(timer));
      pending.clear();
    };
  }, []);

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

    for (const [sessionId, pending] of pendingPermissionNotificationsRef.current) {
      if (currentKeys.get(sessionId) === pending.key && enabled) continue;
      window.clearTimeout(pending.timer);
      pendingPermissionNotificationsRef.current.delete(sessionId);
      postDebugLog("windows_notification.permission_cancelled", {
        sessionId,
        reason: enabled ? "attention-cleared-or-changed" : "notifications-disabled",
      });
    }

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
      const key = currentKeys.get(session.sessionId);
      if (!key) return;
      if (session.state !== "waiting_permission") {
        void sendNotification(session, key, postDebugLog);
        return;
      }

      const timer = window.setTimeout(() => {
        pendingPermissionNotificationsRef.current.delete(session.sessionId);
        if (!enabledRef.current) return;
        const currentSession = sessionsRef.current.find((item) => item.sessionId === session.sessionId);
        if (
          !currentSession ||
          currentSession.state !== "waiting_permission" ||
          !sessionHasAttentionSignal(currentSession) ||
          attentionNotificationKey(currentSession) !== key
        ) {
          postDebugLog("windows_notification.permission_cancelled", {
            sessionId: session.sessionId,
            reason: "resolved-before-delay",
          });
          return;
        }
        void sendNotification(currentSession, key, postDebugLog);
      }, PERMISSION_NOTIFICATION_DELAY_MS);
      pendingPermissionNotificationsRef.current.set(session.sessionId, { key, timer });
      postDebugLog("windows_notification.permission_scheduled", {
        sessionId: session.sessionId,
        delayMs: PERMISSION_NOTIFICATION_DELAY_MS,
      });
    });
  }, [brokerReady, enabled, sessions]);

  return { windowsNotificationsEnabled: enabled };
}

async function sendNotification(
  session: AgentSession,
  key: string,
  postDebugLog: (event: string, data?: unknown) => void,
) {
  const result = await showWindowsNotification(
    attentionNotificationTitle(session),
    attentionNotificationBody(session),
  );
  postDebugLog(result.ok ? "windows_notification.sent" : "windows_notification.skipped", {
    sessionId: session.sessionId,
    attentionKey: key,
    message: result.message,
  });
}
