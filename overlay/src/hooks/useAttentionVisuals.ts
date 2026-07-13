import { useEffect, useRef, useState } from "react";
import { getCurrentWindow, ProgressBarStatus } from "@tauri-apps/api/window";
import {
  sessionArchived,
  sessionAttentionKey,
  sessionAttentionVisualActive,
  sessionHasAttentionSignal,
  sessionNeedsReview,
} from "../domain/sessionModel";
import type { AgentSession } from "../types";

interface UseAttentionVisualsOptions {
  brokerReady: boolean;
  postDebugLog: (event: string, data?: unknown) => void;
  sessions: AgentSession[];
}

type TaskbarAttentionLevel = "none" | "review" | "warning" | "error";

const taskbarAttentionRank: Record<TaskbarAttentionLevel, number> = {
  none: 0,
  review: 1,
  warning: 2,
  error: 3,
};

const taskbarProgressStatus: Record<TaskbarAttentionLevel, ProgressBarStatus> = {
  none: ProgressBarStatus.None,
  review: ProgressBarStatus.Normal,
  warning: ProgressBarStatus.Paused,
  error: ProgressBarStatus.Error,
};

function sessionTaskbarAttentionLevel(session: AgentSession): TaskbarAttentionLevel {
  if (sessionArchived(session) || !sessionHasAttentionSignal(session)) {
    return "none";
  }

  if (session.state === "failed" || /error|fail/i.test(session.lastEvent)) {
    return "error";
  }

  if (session.state === "waiting_permission" || session.state === "waiting_user") {
    return "warning";
  }

  if (sessionNeedsReview(session)) {
    return "review";
  }

  return "warning";
}

function highestTaskbarAttentionLevel(sessions: AgentSession[]): TaskbarAttentionLevel {
  return sessions.reduce<TaskbarAttentionLevel>((highest, session) => {
    const current = sessionTaskbarAttentionLevel(session);
    return taskbarAttentionRank[current] > taskbarAttentionRank[highest] ? current : highest;
  }, "none");
}

export function useAttentionVisuals(options: UseAttentionVisualsOptions) {
  const [attentionVisualSeen, setAttentionVisualSeen] = useState<Record<string, string>>({});
  const [attentionClock, setAttentionClock] = useState(() => Date.now());
  const taskbarAttentionLevelRef = useRef<TaskbarAttentionLevel>("none");
  const hasAttentionSignal = options.sessions.some(
    (session) => !sessionArchived(session) && sessionHasAttentionSignal(session),
  );
  const taskbarAttentionLevel = options.brokerReady
    ? highestTaskbarAttentionLevel(options.sessions)
    : "none";

  useEffect(() => {
    if (!hasAttentionSignal) {
      return undefined;
    }

    setAttentionClock(Date.now());
    const intervalId = window.setInterval(() => setAttentionClock(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [hasAttentionSignal]);

  useEffect(() => {
    setAttentionVisualSeen((previous) => {
      const sessionIds = new Set(options.sessions.map((session) => session.sessionId));
      let changed = false;
      const next: Record<string, string> = {};

      Object.entries(previous).forEach(([sessionId, attentionKey]) => {
        const session = options.sessions.find((item) => item.sessionId === sessionId);
        if (sessionIds.has(sessionId) && session && sessionHasAttentionSignal(session) && attentionKey === sessionAttentionKey(session)) {
          next[sessionId] = attentionKey;
        } else {
          changed = true;
        }
      });

      return changed ? next : previous;
    });
  }, [options.sessions]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;

    async function showTaskbarAttention(reason: string) {
      if (
        taskbarAttentionLevel === "none" ||
        taskbarAttentionLevelRef.current === taskbarAttentionLevel
      ) {
        return;
      }

      try {
        const focused = await appWindow.isFocused();
        if (disposed || focused) {
          return;
        }

        await appWindow.setProgressBar({
          status: taskbarProgressStatus[taskbarAttentionLevel],
          progress: 100,
        });
        taskbarAttentionLevelRef.current = taskbarAttentionLevel;
        options.postDebugLog("taskbar.attention.shown", {
          reason,
          level: taskbarAttentionLevel,
        });
      } catch (error) {
        options.postDebugLog("taskbar.attention.error", {
          reason,
          level: taskbarAttentionLevel,
          message: (error as Error).message,
        });
      }
    }

    async function clearTaskbarAttention(reason: string) {
      if (taskbarAttentionLevelRef.current === "none") {
        return;
      }

      try {
        await appWindow.setProgressBar({ status: ProgressBarStatus.None });
        taskbarAttentionLevelRef.current = "none";
        options.postDebugLog("taskbar.attention.cleared", {
          reason,
        });
      } catch (error) {
        options.postDebugLog("taskbar.attention.clear_error", {
          reason,
          message: (error as Error).message,
        });
      }
    }

    if (taskbarAttentionLevel !== "none") {
      void showTaskbarAttention("attention-level");
    } else {
      void clearTaskbarAttention("attention-cleared");
    }

    let unlistenFocus: (() => void) | null = null;
    void appWindow
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          void clearTaskbarAttention("window-focused");
        } else if (taskbarAttentionLevel !== "none") {
          void showTaskbarAttention("window-blurred");
        }
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenFocus = unlisten;
        }
      })
      .catch((error) => {
        options.postDebugLog("taskbar.review_attention.focus_listener_error", {
          message: (error as Error).message,
        });
      });

    return () => {
      disposed = true;
      unlistenFocus?.();
    };
  }, [options.postDebugLog, taskbarAttentionLevel]);

  function markSessionVisuallySeen(session: AgentSession) {
    if (!sessionHasAttentionSignal(session)) {
      return;
    }

    const attentionKey = sessionAttentionKey(session);
    setAttentionVisualSeen((previous) =>
      previous[session.sessionId] === attentionKey ? previous : { ...previous, [session.sessionId]: attentionKey },
    );
  }

  function isSessionVisuallySeen(session: AgentSession) {
    return attentionVisualSeen[session.sessionId] === sessionAttentionKey(session);
  }

  function isSessionVisualAttentionActive(session: AgentSession) {
    return sessionAttentionVisualActive(session, isSessionVisuallySeen(session), attentionClock);
  }

  return {
    isSessionVisualAttentionActive,
    isSessionVisuallySeen,
    markSessionVisuallySeen,
  };
}
