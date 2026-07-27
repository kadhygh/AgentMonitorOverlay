import { getCurrentWindow } from "@tauri-apps/api/window";

export type StartupModule = "interface" | "broker" | "sessions";
export type StartupModuleState = "waiting" | "loading" | "ready" | "error";

export interface StartupStatusUpdate {
  module: StartupModule;
  state: StartupModuleState;
  message: string;
}

const statusSnapshot = new Map<StartupModule, StartupStatusUpdate>();
let replayInstalled = false;

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
  statusSnapshot.set(update.module, update);
  return getCurrentWindow().emitTo("startup", "amo-startup-status", update).catch(() => undefined);
}
