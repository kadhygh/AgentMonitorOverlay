import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import {
  brokerSessionManagedOfflineUrl,
  brokerSessionManagedWindowUrl,
  postBrokerJson,
} from "../api/brokerClient";
import { activationWindowRequest } from "../domain/routingModel";
import { mergeChangedSession } from "../domain/sessionModel";
import { probeSessionWindows } from "../platform/windowClient";
import { ManagedWindowMonitor, type ManagedWindowTarget } from "../runtime/managedWindowMonitor";
import type { AgentSession } from "../types";

interface UseManagedWindowLivenessOptions {
  brokerReady: boolean;
  postDebugLog: (event: string, data?: unknown) => void;
  sessions: AgentSession[];
  setSessions: Dispatch<SetStateAction<AgentSession[]>>;
}

function managedWindowTargets(sessions: AgentSession[]): ManagedWindowTarget[] {
  return sessions
    .filter(
      (session) =>
        session.launchId &&
        session.launchState === "connected" &&
        session.windowHint?.boundBy === "managed-launch" &&
        session.windowHint?.titleToken,
    )
    .map((session) => ({
      sessionId: session.sessionId,
      launchId: session.launchId as string,
      request: activationWindowRequest(session, null, { includeWindowHintIdentity: true }),
    }));
}

export function useManagedWindowLiveness(options: UseManagedWindowLivenessOptions) {
  const callbacksRef = useRef({
    postDebugLog: options.postDebugLog,
    setSessions: options.setSessions,
  });
  const monitorRef = useRef<ManagedWindowMonitor | null>(null);

  useEffect(() => {
    callbacksRef.current = {
      postDebugLog: options.postDebugLog,
      setSessions: options.setSessions,
    };
  }, [options.postDebugLog, options.setSessions]);

  useEffect(() => {
    monitorRef.current?.updateTargets(managedWindowTargets(options.sessions));
  }, [options.sessions]);

  useEffect(() => {
    if (!options.brokerReady) return undefined;

    const monitor = new ManagedWindowMonitor({
      probe: probeSessionWindows,
      onEvent: (event, data) => callbacksRef.current.postDebugLog(event, data),
      onResolved: async (target, candidate) => {
        const response = await postBrokerJson<{ ok: boolean; session: AgentSession }>(
          brokerSessionManagedWindowUrl(target.sessionId),
          {
            launchId: target.launchId,
            hwnd: candidate.hwnd,
            processId: candidate.processId,
            processName: candidate.processName ?? null,
            title: candidate.title,
          },
        );
        callbacksRef.current.setSessions((previous) => mergeChangedSession(previous, response.session));
      },
      onOffline: async (target) => {
        const response = await postBrokerJson<{ ok: boolean; session: AgentSession }>(
          brokerSessionManagedOfflineUrl(target.sessionId),
          { launchId: target.launchId, reason: "window-heartbeat-missed" },
        );
        callbacksRef.current.setSessions((previous) => mergeChangedSession(previous, response.session));
      },
    });
    monitorRef.current = monitor;
    monitor.updateTargets(managedWindowTargets(options.sessions));
    monitor.start();

    return () => {
      monitor.stop();
      if (monitorRef.current === monitor) {
        monitorRef.current = null;
      }
    };
  }, [options.brokerReady]);
}
