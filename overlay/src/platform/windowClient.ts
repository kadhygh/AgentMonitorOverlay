import { invoke } from "@tauri-apps/api/core";
import type { ActivationResult, WindowActivationRequest, WindowProbeResult } from "../types";

interface NativeWindowProbeRequest {
  sessionId: string;
  hint: Omit<WindowActivationRequest, "sessionId">;
}

export function activateSessionWindow(request: WindowActivationRequest) {
  return invoke<ActivationResult>("activate_session_window", windowInvokeArgs(request));
}

export function listSessionWindowCandidates(request: WindowActivationRequest) {
  return invoke<ActivationResult>("list_session_window_candidates", windowInvokeArgs(request));
}

export function probeSessionWindow(request: WindowActivationRequest) {
  return invoke<ActivationResult>("probe_session_window", windowInvokeArgs(request));
}

export function probeSessionWindows(requests: WindowActivationRequest[]) {
  const nativeRequests: NativeWindowProbeRequest[] = requests.map(({ sessionId, ...hint }) => ({
    sessionId,
    hint,
  }));
  return invoke<WindowProbeResult[]>("probe_session_windows", { requests: nativeRequests });
}

export function windowCandidateAtCursor() {
  return invoke<ActivationResult>("window_candidate_at_cursor");
}

function windowInvokeArgs(request: WindowActivationRequest): Record<string, unknown> {
  return { ...request };
}
