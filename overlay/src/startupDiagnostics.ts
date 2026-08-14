import { invoke } from "@tauri-apps/api/core";

export type StartupMilestoneName =
  | "mainHtmlReady"
  | "brokerReady"
  | "snapshotReady"
  | "interactive";

export interface StartupMilestone {
  name: string;
  elapsedMs: number;
}

export interface StartupDiagnosticsSnapshot {
  milestones: StartupMilestone[];
  totalElapsedMs: number;
}

const recordedMilestones = new Set<StartupMilestoneName>();

export function recordStartupMilestone(name: StartupMilestoneName) {
  if (recordedMilestones.has(name)) return Promise.resolve(null);
  recordedMilestones.add(name);
  return invoke<StartupDiagnosticsSnapshot>("record_startup_milestone", { name }).catch(() => null);
}

export function getStartupDiagnostics() {
  return invoke<StartupDiagnosticsSnapshot>("get_startup_diagnostics");
}
