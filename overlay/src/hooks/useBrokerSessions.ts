import { useEffect, useRef, useState } from "react";
import {
  BROKER_REFRESH_SESSION_TITLES_URL,
  BROKER_SESSION_EVENTS_URL,
  BROKER_SESSIONS_URL,
  getBrokerJson,
} from "../api/brokerClient";
import { mergeChangedSession, mergeSessionOrder, normalizeSessions } from "../domain/sessionModel";
import { createSingleFlight, SessionRevisionGate } from "../runtime/sessionRevisionGate";
import type { BrokerReadiness } from "../components/BrokerReadinessPanel";
import { ensureBrokerStarted } from "../startupBroker";
import { publishStartupStatus } from "../startupStatus";
import type { AgentSession } from "../types";

const FALLBACK_REFRESH_INTERVAL_MS = 45_000;
const REFRESH_TIMEOUT_MS = 2_500;
const EVENT_RECONCILE_DELAY_MS = 350;

interface UseBrokerSessionsOptions {
  autoCopyAndFocusPendingPrompt: (session: AgentSession, reason: string) => void;
  clearLaunchPanelForSession: (sessionId: string) => void;
  clearSessionMenus: () => void;
  clearWorkspacePanelForSession: (sessionId: string) => void;
  onStartupRefreshSettled: () => void;
  postDebugLog: (event: string, data?: unknown) => void;
  reconcileCodexActionRequired: (sessions: AgentSession[], reason: string) => Promise<void>;
}

interface SessionCounts {
  active: number;
  archived: number;
  total: number;
}

interface SessionSnapshotPayload {
  revision?: number;
  sessions?: AgentSession[];
  counts?: SessionCounts;
  offset?: number;
  limit?: number;
  total?: number;
  hasMore?: boolean;
}

interface SessionChangedPayload {
  brokerPublishedAtMs?: number;
  reason?: string;
  sequence?: number;
  session?: AgentSession;
  sessionId?: string | null;
}

interface SessionTitleRefreshPayload {
  count?: number;
}

export interface SessionHydration {
  state: "loading" | "ready" | "error";
  message: string;
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
  const [sessionHydration, setSessionHydration] = useState<SessionHydration>({
    state: "loading",
    message: "Waiting for the initial task snapshot",
  });
  const [sessionCounts, setSessionCounts] = useState<SessionCounts>({ active: 0, archived: 0, total: 0 });
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [refreshingSessionTitles, setRefreshingSessionTitles] = useState(false);
  const [archiveHasMore, setArchiveHasMore] = useState(false);
  const archiveOffsetRef = useRef(0);
  const archiveLoadingRef = useRef(false);
  const sessionsRef = useRef(sessions);
  const hasLoadedSessionSnapshotRef = useRef(false);
  const revisionGateRef = useRef<SessionRevisionGate | null>(null);
  const refreshSingleFlightRef = useRef<ReturnType<typeof createSingleFlight<void>> | null>(null);
  const sseHealthyRef = useRef(false);
  if (!revisionGateRef.current) revisionGateRef.current = new SessionRevisionGate();
  if (!refreshSingleFlightRef.current) refreshSingleFlightRef.current = createSingleFlight<void>();

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  async function refreshSessions(reason = "manual") {
    const singleFlight = refreshSingleFlightRef.current!;
    if (singleFlight.active()) {
      options.postDebugLog("sessions.refresh.coalesced", { reason });
    }

    return singleFlight.run(async () => {
      const startedAt = performance.now();
      const shouldLog = reason !== "interval";
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort("session snapshot timed out"), REFRESH_TIMEOUT_MS);
      if (shouldLog) {
        options.postDebugLog("sessions.refresh.start", {
          reason,
          timeoutMs: REFRESH_TIMEOUT_MS,
          currentRevision: revisionGateRef.current!.current(),
        });
      }

      try {
        const response = await fetch(BROKER_SESSIONS_URL, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`broker returned ${response.status}`);

        const payload = (await response.json()) as SessionSnapshotPayload | AgentSession[];
        const nextSessions = normalizeSessions(payload);
        if (!nextSessions) throw new Error("broker response has no sessions");
        const snapshotRevision = Array.isArray(payload) ? undefined : payload.revision;
        const revisionResult = revisionGateRef.current!.acceptSnapshot(snapshotRevision);
        if (!revisionResult.accepted) {
          options.postDebugLog("sessions.refresh.stale_ignored", {
            reason,
            snapshotRevision: revisionResult.revision,
            currentRevision: revisionGateRef.current!.current(),
            durationMs: Math.round(performance.now() - startedAt),
          });
          if (!hasLoadedSessionSnapshotRef.current) {
            setSessionHydration({ state: "loading", message: "Synchronizing the latest task snapshot" });
            window.setTimeout(() => void refreshSessions("initial-stale-retry"), 0);
          }
          return;
        }

        const incomingActive = nextSessions.filter((session) => !session.archivedAt);
        const incomingArchived = nextSessions.filter((session) => Boolean(session.archivedAt));
        const preservedArchived = incomingArchived.length > 0
          ? incomingArchived
          : sessionsRef.current.filter((session) => Boolean(session.archivedAt));
        const activeIds = new Set(incomingActive.map((session) => session.sessionId));
        const mergedSessions = [
          ...incomingActive,
          ...preservedArchived.filter((session) => !activeIds.has(session.sessionId)),
        ];
        setSessions(mergedSessions);
        sessionsRef.current = mergedSessions;
        setSessionOrder((previousOrder) => mergeSessionOrder(previousOrder, mergedSessions));
        if (!Array.isArray(payload) && payload.counts) setSessionCounts(payload.counts);
        else setSessionCounts({
          active: incomingActive.length,
          archived: preservedArchived.length,
          total: incomingActive.length + preservedArchived.length,
        });
        setBrokerReadiness({
          state: "ready",
          message: "Broker ready",
          detail: `${incomingActive.length} active session${incomingActive.length === 1 ? "" : "s"} loaded`,
        });
        setLastRefreshAt(new Date().toISOString());
        hasLoadedSessionSnapshotRef.current = true;
        setHasLoadedSessionSnapshot(true);
        setSessionHydration({ state: "ready", message: `${incomingActive.length} active task${incomingActive.length === 1 ? "" : "s"} loaded` });
        void publishStartupStatus({ module: "sessions", state: "ready", message: `${incomingActive.length} loaded` });
        setFeedback(incomingActive.length > 0 ? `Broker sessions loaded: ${incomingActive.length}` : "No active broker sessions.");
        void options.reconcileCodexActionRequired(incomingActive, reason);
        if (shouldLog) {
          options.postDebugLog("sessions.refresh.ok", {
            reason,
            durationMs: Math.round(performance.now() - startedAt),
            revision: revisionGateRef.current!.current(),
            sessionCount: nextSessions.length,
            trackedSessionCount: nextSessions.length,
          });
        }
      } catch (error) {
        const timedOut = controller.signal.aborted;
        const message = timedOut ? `request timed out after ${REFRESH_TIMEOUT_MS} ms` : (error as Error).message;
        if (!sseHealthyRef.current) {
          void publishStartupStatus({ module: "sessions", state: "error", message: "Unavailable" });
          setBrokerReadiness({ state: "error", message: "Broker is not ready", detail: message });
          setFeedback(`Broker unavailable: ${message}`);
        }
        if (!hasLoadedSessionSnapshotRef.current) {
          setSessionHydration({ state: "error", message });
        }
        setLastRefreshAt(new Date().toISOString());
        if (shouldLog) {
          options.postDebugLog(timedOut ? "sessions.refresh.timeout" : "sessions.refresh.error", {
            reason,
            durationMs: Math.round(performance.now() - startedAt),
            timeoutMs: REFRESH_TIMEOUT_MS,
            message,
          });
        }
      } finally {
        window.clearTimeout(timeoutId);
      }
    });
  }

  async function refreshSessionTitles() {
    if (refreshingSessionTitles) return;

    setRefreshingSessionTitles(true);
    setFeedback("Refreshing session names...");
    options.postDebugLog("session_titles.refresh.start", {});

    try {
      const response = await fetch(BROKER_REFRESH_SESSION_TITLES_URL, {
        method: "POST",
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`broker returned ${response.status}`);

      const payload = (await response.json()) as SessionTitleRefreshPayload;
      await refreshSessions("manual-title-refresh");
      const changedCount = Number.isFinite(payload.count) ? Number(payload.count) : 0;
      setFeedback(
        changedCount > 0
          ? `Refreshed ${changedCount} session name${changedCount === 1 ? "" : "s"}.`
          : "Session names are already up to date.",
      );
      options.postDebugLog("session_titles.refresh.ok", { changedCount });
    } catch (error) {
      const message = (error as Error).message;
      setFeedback(`Session name refresh failed: ${message}`);
      options.postDebugLog("session_titles.refresh.error", { message });
    } finally {
      setRefreshingSessionTitles(false);
    }
  }

  async function loadArchivedSessions({ reset = false }: { reset?: boolean } = {}) {
    if (archiveLoadingRef.current) return;
    archiveLoadingRef.current = true;
    setArchiveLoading(true);
    const offset = reset ? 0 : archiveOffsetRef.current;
    const startedAt = performance.now();
    options.postDebugLog("sessions.archive_load.start", { offset, limit: 50, reset });
    try {
      const payload = await getBrokerJson<SessionSnapshotPayload>(
        `${BROKER_SESSIONS_URL}?scope=archived&offset=${offset}&limit=50&summary=1`,
        { timeoutMs: REFRESH_TIMEOUT_MS },
      );
      const page = normalizeSessions(payload);
      if (!page) throw new Error("archive response has no sessions");
      const activeSessions = sessionsRef.current.filter((session) => !session.archivedAt);
      const existingArchived = reset ? [] : sessionsRef.current.filter((session) => Boolean(session.archivedAt));
      const archivedById = new Map(existingArchived.map((session) => [session.sessionId, session]));
      for (const session of page) archivedById.set(session.sessionId, session);
      const mergedSessions = [...activeSessions, ...archivedById.values()];
      sessionsRef.current = mergedSessions;
      setSessions(mergedSessions);
      setSessionOrder((previousOrder) => mergeSessionOrder(previousOrder, mergedSessions));
      if (payload.counts) setSessionCounts(payload.counts);
      archiveOffsetRef.current = offset + page.length;
      setArchiveHasMore(Boolean(payload.hasMore));
      options.postDebugLog("sessions.archive_load.ok", {
        offset,
        loaded: page.length,
        total: payload.total ?? null,
        hasMore: Boolean(payload.hasMore),
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      options.postDebugLog("sessions.archive_load.error", {
        offset,
        durationMs: Math.round(performance.now() - startedAt),
        message: (error as Error).message,
      });
      setFeedback(`Archive unavailable: ${(error as Error).message}`);
    } finally {
      archiveLoadingRef.current = false;
      setArchiveLoading(false);
    }
  }
  async function ensureBrokerThenRefresh() {
    void publishStartupStatus({ module: "sessions", state: "loading", message: "Loading snapshot" });
    if (!hasLoadedSessionSnapshotRef.current) {
      setSessionHydration({ state: "loading", message: "Connecting to the task runtime" });
    }
    setBrokerReadiness({ state: "checking", message: "Checking AMO broker", detail: "127.0.0.1:17654" });
    try {
      const result = await ensureBrokerStarted();
      setBrokerReadiness({
        state: result.ok ? (result.started ? "starting" : "checking") : "error",
        message: result.ok ? (result.started ? "Starting AMO broker" : "AMO broker found") : "Broker startup failed",
        detail: result.message,
      });
      setFeedback(result.message);
    } catch (error) {
      setBrokerReadiness({ state: "error", message: "Broker auto-start failed", detail: (error as Error).message });
      setFeedback(`Broker auto-start unavailable: ${(error as Error).message}`);
    }

    await refreshSessions("startup");
  }

  useEffect(() => {
    void ensureBrokerThenRefresh().finally(() => options.onStartupRefreshSettled());
    let eventSource: EventSource | null = null;
    let eventRefreshTimer: number | null = null;

    const scheduleEventRefresh = (eventReason = "unknown", sessionId: string | null = null) => {
      const rescheduled = eventRefreshTimer !== null;
      if (eventRefreshTimer !== null) window.clearTimeout(eventRefreshTimer);
      options.postDebugLog(
        rescheduled ? "session_event.reconcile_rescheduled" : "session_event.reconcile_scheduled",
        { reason: eventReason, sessionId, delayMs: EVENT_RECONCILE_DELAY_MS },
      );
      eventRefreshTimer = window.setTimeout(() => {
        eventRefreshTimer = null;
        void refreshSessions("sse-reconcile");
      }, EVENT_RECONCILE_DELAY_MS);
    };

    const applyChangedSession = (changedSession: AgentSession, eventReason: string, sequence: number | undefined, applyStartedAt: number) => {
      if (changedSession.dismissedAt) {
        const nextSessions = sessionsRef.current.filter((session) => session.sessionId !== changedSession.sessionId);
        sessionsRef.current = nextSessions;
        setSessions(nextSessions);
        setSessionOrder((previousOrder) => previousOrder.filter((sessionId) => sessionId !== changedSession.sessionId));
        options.clearWorkspacePanelForSession(changedSession.sessionId);
        options.clearLaunchPanelForSession(changedSession.sessionId);
        options.postDebugLog("session_event.dismiss_applied", {
          sequence: sequence ?? null,
          reason: eventReason,
          sessionId: changedSession.sessionId,
          durationMs: Math.round(performance.now() - applyStartedAt),
        });
        return;
      }

      const nextSessions = mergeChangedSession(sessionsRef.current, changedSession);
      sessionsRef.current = nextSessions;
      setSessions(nextSessions);
      setSessionOrder((previousOrder) =>
        previousOrder.includes(changedSession.sessionId) ? previousOrder : [...previousOrder, changedSession.sessionId],
      );
      options.postDebugLog("session_event.optimistic_applied", {
        sequence: sequence ?? null,
        reason: eventReason,
        sessionId: changedSession.sessionId,
        durationMs: Math.round(performance.now() - applyStartedAt),
      });
      if (eventReason === "obsidian-annotations" || eventReason === "obsidian-return") {
        window.setTimeout(() => options.autoCopyAndFocusPendingPrompt(changedSession, eventReason), 0);
      }
    };

    const handleSessionChanged = (event: MessageEvent) => {
      const receivedAtMs = Date.now();
      const applyStartedAt = performance.now();
      try {
        const payload = JSON.parse(event.data) as SessionChangedPayload;
        const eventReason = payload.reason ?? "unknown";
        const changedSession = payload.session;
        const eventSessionId = payload.sessionId ?? changedSession?.sessionId ?? null;
        const revision = revisionGateRef.current!.observeEvent(payload.sequence);
        options.postDebugLog("session_event.received", {
          sequence: payload.sequence ?? null,
          reason: eventReason,
          sessionId: eventSessionId,
          hasSession: Boolean(changedSession),
          duplicate: revision.duplicate,
          gap: revision.gap,
          brokerToOverlayMs: typeof payload.brokerPublishedAtMs === "number" ? receivedAtMs - payload.brokerPublishedAtMs : null,
        });
        if (revision.duplicate) return;

        const previousSession = changedSession?.sessionId
          ? sessionsRef.current.find((session) => session.sessionId === changedSession.sessionId)
          : null;
        setSessionCounts((current) => {
          let active = current.active;
          let archived = current.archived;
          if (eventReason === "dismiss-all") {
            active = 0;
            archived = 0;
          } else if (eventReason === "dismiss-archived") {
            archived = 0;
          } else if (changedSession?.sessionId) {
            const wasArchived = Boolean(previousSession?.archivedAt);
            const isArchived = Boolean(changedSession.archivedAt);
            if (changedSession.dismissedAt) {
              if (previousSession) wasArchived ? archived -= 1 : active -= 1;
            } else if (!previousSession) {
              isArchived ? archived += 1 : active += 1;
            } else if (wasArchived !== isArchived) {
              if (isArchived) {
                active -= 1;
                archived += 1;
              } else {
                archived -= 1;
                active += 1;
              }
            }
          }
          active = Math.max(0, active);
          archived = Math.max(0, archived);
          return { active, archived, total: active + archived };
        });

        if (eventReason === "dismiss-archived") {
          const archivedIds = new Set(sessionsRef.current.filter((session) => Boolean(session.archivedAt)).map((session) => session.sessionId));
          const nextSessions = sessionsRef.current.filter((session) => !archivedIds.has(session.sessionId));
          sessionsRef.current = nextSessions;
          setSessions(nextSessions);
          setSessionOrder((previousOrder) => previousOrder.filter((sessionId) => !archivedIds.has(sessionId)));
          options.clearSessionMenus();
        } else if (eventReason === "dismiss-all") {
          sessionsRef.current = [];
          setSessions([]);
          setSessionOrder([]);
          options.clearSessionMenus();
        } else if (changedSession?.sessionId) {
          applyChangedSession(changedSession, eventReason, payload.sequence, applyStartedAt);
        } else {
          scheduleEventRefresh(eventReason, eventSessionId);
        }
        setLastRefreshAt(new Date().toISOString());
        if (revision.gap) scheduleEventRefresh("sequence-gap", eventSessionId);
      } catch (error) {
        options.postDebugLog("session_event.parse_error", { message: (error as Error).message });
        scheduleEventRefresh("parse-error", null);
      }
    };

    const handleBrokerReady = (event: MessageEvent) => {
      sseHealthyRef.current = true;
      let brokerRevision: number | null = null;
      try {
        const payload = JSON.parse(event.data) as { revision?: number };
        brokerRevision = typeof payload.revision === "number" ? payload.revision : null;
      } catch {
        // Older brokers did not include a ready payload revision.
      }
      options.postDebugLog("session_event.stream_open", {
        url: BROKER_SESSION_EVENTS_URL,
        brokerRevision,
        overlayRevision: revisionGateRef.current!.current(),
      });
      if (brokerRevision !== null && brokerRevision !== revisionGateRef.current!.current()) {
        scheduleEventRefresh("stream-reconcile", null);
      }
    };

    if (typeof EventSource !== "undefined") {
      try {
        eventSource = new EventSource(BROKER_SESSION_EVENTS_URL);
        eventSource.onopen = () => {
          sseHealthyRef.current = true;
          setBrokerReadiness((current) => current.state === "ready" ? current : {
            state: "ready",
            message: "Broker ready",
            detail: "Event stream connected",
          });
        };
        eventSource.onerror = () => {
          sseHealthyRef.current = false;
          options.postDebugLog("session_event.stream_error", { readyState: eventSource?.readyState ?? null });
          scheduleEventRefresh("stream-error", null);
        };
        eventSource.addEventListener("broker.ready", handleBrokerReady);
        eventSource.addEventListener("sessions.changed", handleSessionChanged);
      } catch (error) {
        sseHealthyRef.current = false;
        options.postDebugLog("session_event.stream_create_error", {
          url: BROKER_SESSION_EVENTS_URL,
          message: (error as Error).message,
        });
        eventSource = null;
      }
    } else {
      options.postDebugLog("session_event.unsupported", {});
    }

    const interval = window.setInterval(() => {
      if (!sseHealthyRef.current) void refreshSessions("interval");
    }, FALLBACK_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
      if (eventRefreshTimer !== null) window.clearTimeout(eventRefreshTimer);
      sseHealthyRef.current = false;
      eventSource?.close();
    };
  }, []);

  return {
    archiveHasMore,
    archiveLoading,
    brokerReadiness,
    ensureBrokerThenRefresh,
    feedback,
    hasLoadedSessionSnapshot,
    lastRefreshAt,
    loadArchivedSessions,
    refreshingSessionTitles,
    refreshSessionTitles,
    refreshSessions,
    sessionCounts,
    sessionOrder,
    sessionHydration,
    sessions,
    sessionsRef,
    setFeedback,
    setLastRefreshAt,
    setSessionOrder,
    setSessions,
  };
}
