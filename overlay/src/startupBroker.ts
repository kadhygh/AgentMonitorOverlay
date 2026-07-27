import { invoke } from "@tauri-apps/api/core";
import { publishStartupStatus } from "./startupStatus";
import type { BrokerEnsureResult } from "./types";

let brokerStartup: Promise<BrokerEnsureResult> | null = null;

export function ensureBrokerStarted() {
  if (!brokerStartup) {
    void publishStartupStatus({ module: "broker", state: "loading", message: "Starting" });
    brokerStartup = invoke<BrokerEnsureResult>("ensure_broker")
      .then((result) => {
        void publishStartupStatus({
          module: "broker",
          state: result.ok ? "ready" : "error",
          message: result.ok ? (result.started ? "Started" : "Ready") : "Startup failed",
        });
        return result;
      })
      .catch((error) => {
        void publishStartupStatus({ module: "broker", state: "error", message: "Unavailable" });
        throw error;
      });
  }

  return brokerStartup;
}
