import { useRef, type Dispatch, type SetStateAction } from "react";
import { brokerSessionHeartbeatUrl, postBrokerJson } from "../api/brokerClient";
import { mergeChangedSession } from "../domain/sessionModel";
import {
  activationWindowRequest,
  projectName,
  windowTargetForSession,
} from "../domain/routingModel";
import {
  actionRequiredCandidate,
  shouldProbeCodexActionRequired,
} from "../domain/overlaySessionUi";
import { listSessionWindowCandidates } from "../platform/windowClient";
import type { AgentSession } from "../types";

interface UseCodexActionRequiredProbeOptions {
  postDebugLog: (event: string, data?: unknown) => void;
  setSessions: Dispatch<SetStateAction<AgentSession[]>>;
}

export function useCodexActionRequiredProbe(options: UseCodexActionRequiredProbeOptions) {
  const actionRequiredProbeRef = useRef<Record<string, string>>({});

  async function reconcileCodexActionRequired(candidateSessions: AgentSession[], reason: string) {
    const probeSessions = candidateSessions.filter(shouldProbeCodexActionRequired);
    const probeIds = new Set(probeSessions.map((session) => session.sessionId));
    for (const sessionId of Object.keys(actionRequiredProbeRef.current)) {
      if (!probeIds.has(sessionId)) {
        delete actionRequiredProbeRef.current[sessionId];
      }
    }

    await Promise.all(
      probeSessions.map(async (session) => {
        try {
          const result = await listSessionWindowCandidates(
            activationWindowRequest(session, windowTargetForSession(session), { includeWindowHintIdentity: true }),
          );
          const candidate = actionRequiredCandidate(result.candidates ?? []);
          if (!candidate) {
            delete actionRequiredProbeRef.current[session.sessionId];
            return;
          }

          const probeKey = `${candidate.hwnd}:${candidate.processId}:${candidate.title}`;
          if (actionRequiredProbeRef.current[session.sessionId] === probeKey) {
            return;
          }
          actionRequiredProbeRef.current[session.sessionId] = probeKey;

          options.postDebugLog("codex.action_required.detected", {
            reason,
            sessionId: session.sessionId,
            title: candidate.title,
            hwnd: candidate.hwnd,
            processId: candidate.processId,
          });

          const resultSession = await postBrokerJson<{ ok: boolean; session: AgentSession }>(
            brokerSessionHeartbeatUrl(session.sessionId),
            {
              state: "waiting_permission",
              eventName: "WindowActionRequired",
              message: "Codex CLI is waiting for a local action.",
              needsAttention: true,
              windowHint: {
                process: candidate.processName,
                title: candidate.title,
                project: session.windowHint?.project ?? projectName(session.cwd),
                cwd: session.windowHint?.cwd ?? session.cwd,
                tool: session.windowHint?.tool ?? session.tool,
                pid: candidate.processId,
                hwnd: candidate.hwnd,
                boundAt: session.windowHint?.boundAt ?? null,
                boundBy: session.windowHint?.boundBy ?? "overlay-action-required",
                boundLabel: candidate.label,
              },
            },
          );

          options.setSessions((previousSessions) => mergeChangedSession(previousSessions, resultSession.session));
        } catch (error) {
          options.postDebugLog("codex.action_required.probe_error", {
            reason,
            sessionId: session.sessionId,
            message: (error as Error).message,
          });
        }
      }),
    );
  }

  return {
    reconcileCodexActionRequired,
  };
}
