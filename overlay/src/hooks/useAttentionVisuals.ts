import { useEffect, useRef, useState } from "react";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import {
  sessionArchived,
  sessionAttentionKey,
  sessionAttentionVisualActive,
  sessionHasAttentionSignal,
} from "../domain/sessionModel";
import type { AgentSession } from "../types";

interface UseAttentionVisualsOptions {
  brokerReady: boolean;
  postDebugLog: (event: string, data?: unknown) => void;
  reviewCount: number;
  sessions: AgentSession[];
}

export function useAttentionVisuals(options: UseAttentionVisualsOptions) {
  const [attentionVisualSeen, setAttentionVisualSeen] = useState<Record<string, string>>({});
  const [attentionClock, setAttentionClock] = useState(() => Date.now());
  const reviewTaskbarAttentionActiveRef = useRef(false);
  const hasAttentionSignal = options.sessions.some(
    (session) => !sessionArchived(session) && sessionHasAttentionSignal(session),
  );

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
    const hasPendingReview = options.brokerReady && options.reviewCount > 0;
    let disposed = false;

    async function requestReviewTaskbarAttention(reason: string) {
      try {
        const focused = await appWindow.isFocused();
        if (disposed || focused) {
          return;
        }

        await appWindow.requestUserAttention(UserAttentionType.Informational);
        reviewTaskbarAttentionActiveRef.current = true;
        options.postDebugLog("taskbar.review_attention.requested", {
          reason,
          reviewCount: options.reviewCount,
        });
      } catch (error) {
        options.postDebugLog("taskbar.review_attention.error", {
          reason,
          reviewCount: options.reviewCount,
          message: (error as Error).message,
        });
      }
    }

    async function clearReviewTaskbarAttention(reason: string) {
      if (!reviewTaskbarAttentionActiveRef.current) {
        return;
      }

      try {
        await appWindow.requestUserAttention(null);
        reviewTaskbarAttentionActiveRef.current = false;
        options.postDebugLog("taskbar.review_attention.cleared", {
          reason,
        });
      } catch (error) {
        options.postDebugLog("taskbar.review_attention.clear_error", {
          reason,
          message: (error as Error).message,
        });
      }
    }

    if (hasPendingReview) {
      void requestReviewTaskbarAttention("review-count");
    } else {
      void clearReviewTaskbarAttention("review-cleared");
    }

    let unlistenFocus: (() => void) | null = null;
    void appWindow
      .onFocusChanged(({ payload: focused }) => {
        if (focused) {
          void clearReviewTaskbarAttention("window-focused");
        } else if (hasPendingReview) {
          void requestReviewTaskbarAttention("window-blurred");
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
  }, [options.brokerReady, options.postDebugLog, options.reviewCount]);

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
