import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BROKER_SESSION_EVENTS_URL, BROKER_SESSIONS_URL } from "../api/brokerClient";
import { mergeChangedSession, mergeSessionOrder, normalizeSessions } from "../domain/sessionModel";
import type { BrokerReadiness } from "../components/BrokerReadinessPanel";
import type { AgentSession, BrokerEnsureResult } from "../types";

const REFRESH_INTERVAL_MS = 3000;

interface UseBrokerSessionsOptions {
  autoCopyAndFocusPendingPrompt: (session: AgentSession, reason: string) => void;
  clearLaunchPanelForSession: (sessionId: string) => void;
  clearSessionMenus: () => void;
  clearWorkspacePanelForSession: (sessionId: string) => void;
  onStartupRefreshSettled: () => void;
  postDebugLog: (event: string, data?: unknown) => void;
  reconcileCodexActionRequired: (sessions: AgentSession[], reason: string) => Promise<void>;
}

export function useBrokerSessions(options: UseBrokerSessionsOptions) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [sessionOrder, setSessionOrder] = useState<string[]>([]);
  const [brokerReadiness, setBrokerReadiness] = useState<BrokerReadiness>({
    state: "checking",
    message: "Checking AMO broker",
    detail: "127.0.0.1:17654",
  });
  const [feedback, setFeedback] = useState("Checking AMO broker...");
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const [hasLoadedSessionSnapshot, setHasLoadedSessionSnapshot] = useState(false);
  const sessionsRef = useRef(sessions);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  async function refreshSessions(reason = "manual") {
    const startedAt = performance.now();
    const shouldLog = reason !== "interval";
    if (shouldLog) {
      void options.postDebugLog("sessions.refresh.start", {
        reason,
      });
    }

    try {
      const response = await fetch(BROKER_SESSIONS_URL, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`broker returned ${response.status}`);
      }

      const payload = await response.json();
      const nextSessions = normalizeSessions(payload);
      if (!nextSessions) {
        throw new Error("broker response has no sessions");
      }

      const visibleSessions = nextSessions.slice(0, 8);
      setSessions(visibleSessions);
      sessionsRef.current = visibleSessions;
      setSessionOrder((previousOrder) => mergeSessionOrder(previousOrder, visibleSessions));
      setBrokerReadiness({
        state: "ready",
        message: "Broker ready",
        detail: `${nextSessions.length} session${nextSessions.length === 1 ? "" : "s"} loaded`,
      });
      setLastRefreshAt(new Date().toISOString());
      setHasLoadedSessionSnapshot(true);
      setFeedback(nextSessions.length > 0 ? `Broker sessions loaded: ${nextSessions.length}` : "No active broker sessions.");
      void options.reconcileCodexActionRequired(visibleSessions, reason);
      if (shouldLog) {
        void options.postDebugLog("sessions.refresh.ok", {
          reason,
          durationMs: Math.round(performance.now() - startedAt),
          sessionCount: nextSessions.length,
          visibleSessionCount: visibleSessions.length,
        });
      }
    } catch (error) {
      setBrokerReadiness({
        state: "error",
        message: "Broker is not ready",
        detail: (error as Error).message,
      });
      setLastRefreshAt(new Date().toISOString());
      setFeedback(`Broker unavailable: ${(error as Error).message}`);
      if (shouldLog) {
        void options.postDebugLog("sessions.refresh.error", {
          reason,
          durationMs: Math.round(performance.now() - startedAt),
          message: (error as Error).message,
        });
      }
    }
  }

  async function ensureBrokerThenRefresh() {
    setBrokerReadiness({
      state: "checking",
      message: "Checking AMO broker",
      detail: "127.0.0.1:17654",
    });
    try {
      const result = await invoke<BrokerEnsureResult>("ensure_broker");
      setBrokerReadiness({
        state: result.ok ? (result.started ? "starting" : "checking") : "error",
        message: result.ok ? (result.started ? "Starting AMO broker" : "AMO broker found") : "Broker startup failed",
        detail: result.message,
      });
      setFeedback(result.message);
    } catch (error) {
      setBrokerReadiness({
        state: "error",
        message: "Broker auto-start failed",
        detail: (error as Error).message,
      });
      setFeedback(`Broker auto-start unavailable: ${(error as Error).message}`);
    }

    await refreshSessions("startup");
  }

  useEffect(() => {
    void ensureBrokerThenRefresh().finally(() => {
      options.onStartupRefreshSettled();
    });
    let eventSource: EventSource | null = null;
    let eventRefreshTimer: number | null = null;
    const scheduleEventRefresh = (eventReason = "unknown", sessionId: string | null = null) => {
      if (eventRefreshTimer !== null) {
        window.clearTimeout(eventRefreshTimer);
        options.postDebugLog("session_event.reconcile_rescheduled", {
          reason: eventReason,
          sessionId,
        });
        return;
      }

      options.postDebugLog("session_event.reconcile_scheduled", {
        reason: eventReason,
        sessionId,
        delayMs: 650,
      });
      eventRefreshTimer = window.setTimeout(() => {
        eventRefreshTimer = null;
        void refreshSessions("sse-reconcile");
      }, 650);
    };
    const handleSessionChanged = (event: MessageEvent) => {
      const receivedAtMs = Date.now();
      const applyStartedAt = performance.now();
      let eventReason = "unknown";
      let eventSessionId: string | null = null;
      try {
        const payload = JSON.parse(event.data) as {
          brokerPublishedAtMs?: number;
          reason?: string;
          sequence?: number;
          session?: AgentSession;
          sessionId?: string | null;
        };
        const changedSession = payload.session;
        eventReason = payload.reason ?? "unknown";
        eventSessionId = payload.sessionId ?? changedSession?.sessionId ?? null;
        options.postDebugLog("session_event.received", {
          sequence: payload.sequence ?? null,
          reason: eventReason,
          sessionId: eventSessionId,
          hasSession: Boolean(changedSession),
          sessionState: changedSession?.state ?? null,
          pendingPromptId: changedSession?.pendingPromptId ?? null,
          brokerToOverlayMs:
            typeof payload.brokerPublishedAtMs === "number" ? receivedAtMs - payload.brokerPublishedAtMs : null,
        });
        if (eventReason === "dismiss-all") {
          setSessions([]);
          sessionsRef.current = [];
          setSessionOrder([]);
          options.clearSessionMenus();
          setLastRefreshAt(new Date().toISOString());
          options.postDebugLog("session_event.dismiss_all_applied", {
            sequence: payload.sequence ?? null,
            durationMs: Math.round(performance.now() - applyStartedAt),
          });
        } else if (changedSession?.sessionId && changedSession.dismissedAt) {
          setSessions((previousSessions) => {
            const nextSessions = previousSessions.filter((session) => session.sessionId !== changedSession.sessionId);
            sessionsRef.current = nextSessions;
            return nextSessions;
          });
          setSessionOrder((previousOrder) => previousOrder.filter((sessionId) => sessionId !== changedSession.sessionId));
          options.clearWorkspacePanelForSession(changedSession.sessionId);
          options.clearLaunchPanelForSession(changedSession.sessionId);
          setLastRefreshAt(new Date().toISOString());
          options.postDebugLog("session_event.dismiss_applied", {
            sequence: payload.sequence ?? null,
            reason: eventReason,
            sessionId: changedSession.sessionId,
            durationMs: Math.round(performance.now() - applyStartedAt),
          });
        } else if (changedSession?.sessionId) {
          setSessions((previousSessions) => {
            const nextSessions = mergeChangedSession(previousSessions, changedSession);
            sessionsRef.current = nextSessions;
            return nextSessions;
          });
          setSessionOrder((previousOrder) =>
            previousOrder.includes(changedSession.sessionId)
              ? previousOrder
              : [...previousOrder, changedSession.sessionId],
          );
          setLastRefreshAt(new Date().toISOString());
          options.postDebugLog("session_event.optimistic_applied", {
            sequence: payload.sequence ?? null,
            reason: eventReason,
            sessionId: changedSession.sessionId,
            durationMs: Math.round(performance.now() - applyStartedAt),
          });
          if (eventReason === "obsidian-annotations") {
            window.setTimeout(() => options.autoCopyAndFocusPendingPrompt(changedSession, eventReason), 0);
          }
        }
      } catch (error) {
        options.postDebugLog("session_event.parse_error", {
          message: (error as Error).message,
        });
      }

      scheduleEventRefresh(eventReason, eventSessionId);
    };

    if (typeof EventSource !== "undefined") {
      try {
        eventSource = new EventSource(BROKER_SESSION_EVENTS_URL);
        eventSource.onopen = () => {
          setBrokerReadiness((current) =>
            current.state === "ready"
              ? current
              : {
                  state: "ready",
                  message: "Broker ready",
                  detail: "Event stream connected",
                },
          );
          options.postDebugLog("session_event.stream_open", {
            url: BROKER_SESSION_EVENTS_URL,
          });
        };
        eventSource.onerror = () => {
          options.postDebugLog("session_event.stream_error", {
            readyState: eventSource?.readyState ?? null,
          });
        };
        eventSource.addEventListener("sessions.changed", handleSessionChanged);
      } catch {
        options.postDebugLog("session_event.stream_create_error", {
          url: BROKER_SESSION_EVENTS_URL,
        });
        eventSource = null;
      }
    } else {
      options.postDebugLog("session_event.unsupported", {});
    }

    const interval = window.setInterval(() => {
      void refreshSessions("interval");
    }, REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
      if (eventRefreshTimer !== null) {
        window.clearTimeout(eventRefreshTimer);
      }
      eventSource?.close();
    };
  }, []);

  return {
    brokerReadiness,
    ensureBrokerThenRefresh,
    feedback,
    hasLoadedSessionSnapshot,
    lastRefreshAt,
    refreshSessions,
    sessionOrder,
    sessions,
    sessionsRef,
    setFeedback,
    setLastRefreshAt,
    setSessionOrder,
    setSessions,
  };
}
