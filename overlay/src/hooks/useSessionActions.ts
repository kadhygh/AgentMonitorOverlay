import { useState, type Dispatch, type SetStateAction } from "react";
import {
  brokerSessionArchiveUrl,
  brokerSessionAttentionClearedUrl,
  brokerSessionDismissUrl,
  brokerSessionReviewedUrl,
  brokerSessionTargetBindingClearUrl,
  postBrokerJson,
} from "../api/brokerClient";
import { sessionNeedsManualAttentionClear, sessionNeedsReview } from "../domain/sessionModel";
import { targetBindingForSession } from "../domain/routingModel";
import type { CandidateMenuState } from "../components/CandidateMenu";
import type { LaunchPanelState } from "../components/LaunchPanel";
import type { WorkspacePanelState } from "../components/WorkspacePanel";
import type { AgentSession } from "../types";

interface UseSessionActionsOptions {
  markSessionVisuallySeen: (session: AgentSession) => void;
  postDebugLog: (event: string, data?: unknown) => void;
  refreshSessions: (reason?: string) => Promise<void>;
  setCandidateMenu: Dispatch<SetStateAction<CandidateMenuState | null>>;
  setFeedback: Dispatch<SetStateAction<string>>;
  setLaunchPanel: Dispatch<SetStateAction<LaunchPanelState | null>>;
  setSessionOrder: Dispatch<SetStateAction<string[]>>;
  setSessions: Dispatch<SetStateAction<AgentSession[]>>;
  setWorkspacePanel: Dispatch<SetStateAction<WorkspacePanelState | null>>;
}

export function useSessionActions(options: UseSessionActionsOptions) {
  const [unbindingWindowId, setUnbindingWindowId] = useState<string | null>(null);
  const [reviewingSessionId, setReviewingSessionId] = useState<string | null>(null);
  const [dismissingSessionId, setDismissingSessionId] = useState<string | null>(null);
  const [archivingSessionId, setArchivingSessionId] = useState<string | null>(null);

  async function clearWindowBinding(session: AgentSession) {
    setUnbindingWindowId(session.sessionId);
    options.setFeedback(`Clearing target binding for ${session.title}...`);
    options.postDebugLog("window.unbind.start", {
      sessionId: session.sessionId,
      targetType: targetBindingForSession(session)?.type ?? "auto",
      hwnd: session.windowHint?.hwnd ?? null,
      pid: session.windowHint?.pid ?? null,
    });

    try {
      const result = await postBrokerJson<{ ok: boolean; session: AgentSession }>(
        brokerSessionTargetBindingClearUrl(session.sessionId),
        {},
      );
      options.setSessions((previous) =>
        previous.map((item) => (item.sessionId === result.session.sessionId ? result.session : item)),
      );
      options.postDebugLog("window.unbind.ok", {
        sessionId: session.sessionId,
      });
      options.setFeedback("Target binding cleared.");
      void options.refreshSessions("target-unbind");
    } catch (error) {
      options.postDebugLog("window.unbind.error", {
        sessionId: session.sessionId,
        message: (error as Error).message,
      });
      options.setFeedback(`Unbind failed: ${(error as Error).message}`);
    } finally {
      setUnbindingWindowId(null);
    }
  }

  async function markSessionReviewed(
    session: AgentSession,
    action = "manual",
    markOptions: { quiet?: boolean } = {},
  ) {
    options.markSessionVisuallySeen(session);
    if (!sessionNeedsReview(session)) {
      return;
    }

    setReviewingSessionId(session.sessionId);
    if (!markOptions.quiet) {
      options.setFeedback(`Marking ${session.title} as reviewed...`);
    }
    options.postDebugLog("session.review.start", {
      sessionId: session.sessionId,
      action,
      reviewTurnId: session.reviewTurnId ?? null,
    });

    try {
      const result = await postBrokerJson<{ ok: boolean; session: AgentSession }>(
        brokerSessionReviewedUrl(session.sessionId),
        { action, by: "overlay" },
      );
      options.setSessions((previous) =>
        previous.map((item) => (item.sessionId === result.session.sessionId ? result.session : item)),
      );
      if (!markOptions.quiet) {
        options.setFeedback("Marked as reviewed.");
      }
      options.postDebugLog("session.review.ok", {
        sessionId: result.session.sessionId,
        action,
      });
    } catch (error) {
      const message = (error as Error).message;
      if (!markOptions.quiet) {
        options.setFeedback(`Review mark failed: ${message}`);
      }
      options.postDebugLog("session.review.error", {
        sessionId: session.sessionId,
        action,
        message,
      });
    } finally {
      setReviewingSessionId(null);
    }
  }

  async function clearSessionAttentionAfterActivation(session: AgentSession, action = "activate-target") {
    if (!sessionNeedsManualAttentionClear(session)) {
      return null;
    }

    options.postDebugLog("session.attention_clear.start", {
      sessionId: session.sessionId,
      action,
      state: session.state,
    });

    try {
      const result = await postBrokerJson<{ ok: boolean; session: AgentSession }>(
        brokerSessionAttentionClearedUrl(session.sessionId),
        {
          action,
          by: "overlay",
          state: "running",
        },
      );
      options.setSessions((previous) =>
        previous.map((item) => (item.sessionId === result.session.sessionId ? result.session : item)),
      );
      options.setFeedback("Permission attention cleared.");
      options.postDebugLog("session.attention_clear.ok", {
        sessionId: result.session.sessionId,
        action,
        state: result.session.state,
      });
      return result.session;
    } catch (error) {
      const message = (error as Error).message;
      options.setFeedback(`Attention clear failed: ${message}`);
      options.postDebugLog("session.attention_clear.error", {
        sessionId: session.sessionId,
        action,
        message,
      });
      return null;
    }
  }

  async function archiveSession(session: AgentSession) {
    setArchivingSessionId(session.sessionId);
    options.setFeedback(`Archiving ${session.title}...`);
    options.postDebugLog("session.archive.start", {
      sessionId: session.sessionId,
      title: session.title,
    });

    try {
      const result = await postBrokerJson<{ ok: boolean; session: AgentSession }>(
        brokerSessionArchiveUrl(session.sessionId),
        { reason: "user" },
      );
      options.setSessions((previous) =>
        previous.map((item) => (item.sessionId === result.session.sessionId ? result.session : item)),
      );
      options.setCandidateMenu((current) =>
        current?.session.sessionId === result.session.sessionId ? null : current,
      );
      options.setWorkspacePanel((current) =>
        current?.session.sessionId === result.session.sessionId ? null : current,
      );
      options.setLaunchPanel((current) =>
        current?.session.sessionId === result.session.sessionId ? null : current,
      );
      options.setFeedback(`Archived ${session.title}.`);
      options.postDebugLog("session.archive.ok", {
        sessionId: result.session.sessionId,
      });
    } catch (error) {
      const message = (error as Error).message;
      options.setFeedback(`Archive failed: ${message}`);
      options.postDebugLog("session.archive.error", {
        sessionId: session.sessionId,
        message,
      });
    } finally {
      setArchivingSessionId(null);
    }
  }

  async function dismissSession(session: AgentSession) {
    setDismissingSessionId(session.sessionId);
    options.setFeedback(`Hiding ${session.title}...`);
    options.postDebugLog("session.dismiss.start", {
      sessionId: session.sessionId,
      title: session.title,
    });

    try {
      const result = await postBrokerJson<{ ok: boolean; sessionId: string }>(
        brokerSessionDismissUrl(session.sessionId),
        { reason: "user" },
      );
      const dismissedSessionId = result.sessionId || session.sessionId;
      options.setSessions((previous) => previous.filter((item) => item.sessionId !== dismissedSessionId));
      options.setSessionOrder((previousOrder) => previousOrder.filter((sessionId) => sessionId !== dismissedSessionId));
      options.setCandidateMenu((current) =>
        current?.session.sessionId === dismissedSessionId ? null : current,
      );
      options.setWorkspacePanel((current) =>
        current?.session.sessionId === dismissedSessionId ? null : current,
      );
      options.setLaunchPanel((current) =>
        current?.session.sessionId === dismissedSessionId ? null : current,
      );
      options.setFeedback(`Hidden ${session.title}.`);
      options.postDebugLog("session.dismiss.ok", {
        sessionId: dismissedSessionId,
      });
    } catch (error) {
      const message = (error as Error).message;
      options.setFeedback(`Dismiss failed: ${message}`);
      options.postDebugLog("session.dismiss.error", {
        sessionId: session.sessionId,
        message,
      });
    } finally {
      setDismissingSessionId(null);
    }
  }

  return {
    archiveSession,
    archivingSessionId,
    clearSessionAttentionAfterActivation,
    clearWindowBinding,
    dismissingSessionId,
    dismissSession,
    markSessionReviewed,
    reviewingSessionId,
    unbindingWindowId,
  };
}
