import type { ActivationCandidate, AgentSession } from "../types";
import { isCodexSession } from "./routingModel";

const CODEX_ACTION_REQUIRED_TITLE_PATTERN = /\[\s*!\s*\]\s*Action Required/i;

export function shouldProbeCodexActionRequired(session: AgentSession) {
  if (session.archivedAt || !isCodexSession(session)) return false;
  if (session.state === "waiting_permission" || session.state === "waiting_user") return false;
  if (session.state !== "running" && session.state !== "starting") return false;
  return Boolean(session.windowHint?.hwnd || session.windowHint?.pid);
}

export function actionRequiredCandidate(candidates: ActivationCandidate[]) {
  return candidates.find((candidate) => CODEX_ACTION_REQUIRED_TITLE_PATTERN.test(candidate.title));
}

export function menuPosition(x?: number, y?: number) {
  const fallbackX = Math.max(12, window.innerWidth - 326);
  const fallbackY = 96;
  return {
    x: Math.max(10, Math.min(x ?? fallbackX, window.innerWidth - 326)),
    y: Math.max(54, Math.min(y ?? fallbackY, window.innerHeight - 220)),
  };
}

export function workspacePanelPosition(x?: number, y?: number) {
  const width = 356;
  const fallbackX = Math.max(12, window.innerWidth - width - 8);
  const fallbackY = 92;
  return {
    x: Math.max(10, Math.min(x ?? fallbackX, window.innerWidth - width - 10)),
    y: Math.max(54, Math.min(y ?? fallbackY, window.innerHeight - 360)),
  };
}

export function launchPanelPosition(x?: number, y?: number) {
  const width = 336;
  const fallbackX = Math.max(12, window.innerWidth - width - 8);
  const fallbackY = 92;
  return {
    x: Math.max(10, Math.min(x ?? fallbackX, window.innerWidth - width - 10)),
    y: Math.max(54, Math.min(y ?? fallbackY, window.innerHeight - 260)),
  };
}
