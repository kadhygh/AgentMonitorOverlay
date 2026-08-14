import { getCurrentWindow } from "@tauri-apps/api/window";

export type StartupModule = "interface" | "broker" | "sessions";
export type StartupModuleState = "waiting" | "loading" | "ready" | "error";

export interface StartupStatusUpdate {
  module: StartupModule;
  state: StartupModuleState;
  message: string;
}

export interface StartupPhaseSnapshot extends StartupStatusUpdate {
  updatedAtMs: number;
}

export interface StartupCoordinatorSnapshot {
  shell: StartupPhaseSnapshot;
  runtime: StartupPhaseSnapshot;
  data: StartupPhaseSnapshot;
}

const startupStatusStartedAt = performance.now();
const statusSnapshot = new Map<StartupModule, StartupPhaseSnapshot>([
  ["interface", {
    module: "interface",
    state: "waiting",
    message: "Waiting for the UI shell",
    updatedAtMs: startupStatusStartedAt,
  }],
  ["broker", {
    module: "broker",
    state: "waiting",
    message: "Waiting for the local runtime",
    updatedAtMs: startupStatusStartedAt,
  }],
  ["sessions", {
    module: "sessions",
    state: "waiting",
    message: "Waiting for task data",
    updatedAtMs: startupStatusStartedAt,
  }],
]);
const snapshotListeners = new Set<(snapshot: StartupCoordinatorSnapshot) => void>();
let replayInstalled = false;

function phaseSnapshot(module: StartupModule, message: string): StartupPhaseSnapshot {
  return statusSnapshot.get(module) ?? { module, state: "waiting", message, updatedAtMs: startupStatusStartedAt };
}

export function getStartupCoordinatorSnapshot(): StartupCoordinatorSnapshot {
  return {
    shell: phaseSnapshot("interface", "Waiting for the UI shell"),
    runtime: phaseSnapshot("broker", "Waiting for the local runtime"),
    data: phaseSnapshot("sessions", "Waiting for task data"),
  };
}

export function subscribeStartupCoordinator(
  listener: (snapshot: StartupCoordinatorSnapshot) => void,
) {
  snapshotListeners.add(listener);
  listener(getStartupCoordinatorSnapshot());
  return () => snapshotListeners.delete(listener);
}

export async function installStartupStatusReplay() {
  if (replayInstalled) return;
  replayInstalled = true;
  await getCurrentWindow().listen("amo-startup-view-ready", () => {
    for (const update of statusSnapshot.values()) {
      void getCurrentWindow().emitTo("startup", "amo-startup-status", update);
    }
  });
}

export function publishStartupStatus(update: StartupStatusUpdate) {
  const phase = { ...update, updatedAtMs: performance.now() };
  statusSnapshot.set(update.module, phase);
  const snapshot = getStartupCoordinatorSnapshot();
  snapshotListeners.forEach((listener) => listener(snapshot));
  return getCurrentWindow().emitTo("startup", "amo-startup-status", update).catch(() => undefined);
}
