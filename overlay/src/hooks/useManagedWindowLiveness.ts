import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { brokerSessionManagedOfflineUrl, postBrokerJson } from "../api/brokerClient";
import { mergeChangedSession } from "../domain/sessionModel";
import { activationWindowRequest } from "../domain/routingModel";
import type { ActivationResult, AgentSession } from "../types";

const PROBE_INTERVAL_MS = 2500;
const MISSES_BEFORE_OFFLINE = 2;

interface UseManagedWindowLivenessOptions {
  brokerReady: boolean;
  postDebugLog: (event: string, data?: unknown) => void;
  sessions: AgentSession[];
  setSessions: Dispatch<SetStateAction<AgentSession[]>>;
}

export function useManagedWindowLiveness(options: UseManagedWindowLivenessOptions) {
  const sessionsRef = useRef(options.sessions);
  const probeRunningRef = useRef(false);
  const missesRef = useRef(new Map<string, number>());
  const launchIdsRef = useRef(new Map<string, string>());

  useEffect(() => {
    sessionsRef.current = options.sessions;
  }, [options.sessions]);

  useEffect(() => {
    if (!options.brokerReady) return;

    async function probeManagedWindows() {
      if (probeRunningRef.current) return;
      probeRunningRef.current = true;
      try {
        const candidates = sessionsRef.current.filter(
          (session) =>
            session.launchId &&
            session.launchState === "connected" &&
            session.windowHint?.boundBy === "managed-launch" &&
            session.windowHint?.titleToken,
        );
        const activeIds = new Set(candidates.map((session) => session.sessionId));
        for (const sessionId of missesRef.current.keys()) {
          if (!activeIds.has(sessionId)) {
            missesRef.current.delete(sessionId);
            launchIdsRef.current.delete(sessionId);
          }
        }

        await Promise.all(
          candidates.map(async (session) => {
            const launchId = session.launchId as string;
            if (launchIdsRef.current.get(session.sessionId) !== launchId) {
              launchIdsRef.current.set(session.sessionId, launchId);
              missesRef.current.delete(session.sessionId);
            }

            try {
              const result = await invoke<ActivationResult>(
                "probe_session_window",
                activationWindowRequest(session, null, { includeWindowHintIdentity: true }),
              );
              if (result.ok) {
                if (missesRef.current.delete(session.sessionId)) {
                  options.postDebugLog("managed_window.probe_recovered", {
                    sessionId: session.sessionId,
                    launchId,
                  });
                }
                return;
              }

              const misses = (missesRef.current.get(session.sessionId) ?? 0) + 1;
              missesRef.current.set(session.sessionId, misses);
              options.postDebugLog("managed_window.probe_miss", {
                sessionId: session.sessionId,
                launchId,
                misses,
                message: result.message,
              });
              if (misses < MISSES_BEFORE_OFFLINE) return;

              const response = await postBrokerJson<{ ok: boolean; session: AgentSession }>(
                brokerSessionManagedOfflineUrl(session.sessionId),
                { launchId, reason: "window-heartbeat-missed" },
              );
              missesRef.current.delete(session.sessionId);
              options.setSessions((previous) => mergeChangedSession(previous, response.session));
              options.postDebugLog("managed_window.offline", {
                sessionId: session.sessionId,
                launchId,
                reason: "window-heartbeat-missed",
              });
            } catch (error) {
              options.postDebugLog("managed_window.probe_error", {
                sessionId: session.sessionId,
                launchId,
                message: (error as Error).message,
              });
            }
          }),
        );
      } finally {
        probeRunningRef.current = false;
      }
    }

    void probeManagedWindows();
    const interval = window.setInterval(() => void probeManagedWindows(), PROBE_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [options.brokerReady]);
}
