import type { WindowActivationRequest, WindowProbeResult } from "../types";

export interface ManagedWindowTarget {
  sessionId: string;
  launchId: string;
  request: WindowActivationRequest;
}

interface ManagedWindowMonitorOptions {
  intervalMs?: number;
  missesBeforeOffline?: number;
  onEvent?: (event: string, data: Record<string, unknown>) => void;
  onOffline: (target: ManagedWindowTarget) => Promise<void>;
  probe: (requests: WindowActivationRequest[]) => Promise<WindowProbeResult[]>;
}

const DEFAULT_INTERVAL_MS = 2500;
const DEFAULT_MISSES_BEFORE_OFFLINE = 2;

export class ManagedWindowMonitor {
  private readonly intervalMs: number;
  private readonly missesBeforeOffline: number;
  private readonly onEvent: (event: string, data: Record<string, unknown>) => void;
  private readonly onOffline: (target: ManagedWindowTarget) => Promise<void>;
  private readonly probe: (requests: WindowActivationRequest[]) => Promise<WindowProbeResult[]>;
  private readonly targets = new Map<string, ManagedWindowTarget>();
  private readonly misses = new Map<string, number>();
  private readonly offlinePending = new Set<string>();
  private timerId: number | null = null;
  private probeRunning = false;
  private generation = 0;

  constructor(options: ManagedWindowMonitorOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.missesBeforeOffline = options.missesBeforeOffline ?? DEFAULT_MISSES_BEFORE_OFFLINE;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.onOffline = options.onOffline;
    this.probe = options.probe;
  }

  updateTargets(nextTargets: ManagedWindowTarget[]) {
    const nextIds = new Set(nextTargets.map((target) => target.sessionId));
    for (const sessionId of this.targets.keys()) {
      if (nextIds.has(sessionId)) continue;
      this.targets.delete(sessionId);
      this.misses.delete(sessionId);
      this.offlinePending.delete(sessionId);
    }

    for (const target of nextTargets) {
      const previous = this.targets.get(target.sessionId);
      if (previous?.launchId !== target.launchId) {
        this.misses.delete(target.sessionId);
        this.offlinePending.delete(target.sessionId);
      }
      this.targets.set(target.sessionId, target);
    }
  }

  start() {
    if (this.timerId !== null) return;
    this.generation += 1;
    void this.runOnce();
    this.timerId = globalThis.setInterval(() => void this.runOnce(), this.intervalMs);
  }

  stop() {
    this.generation += 1;
    if (this.timerId !== null) {
      globalThis.clearInterval(this.timerId);
      this.timerId = null;
    }
    this.targets.clear();
    this.misses.clear();
    this.offlinePending.clear();
  }

  async runOnce() {
    if (this.probeRunning || this.targets.size === 0) return;
    this.probeRunning = true;
    const generation = this.generation;
    const targets = Array.from(this.targets.values());

    try {
      const results = await this.probe(targets.map((target) => target.request));
      if (generation !== this.generation) return;

      const resultBySessionId = new Map(results.map((result) => [result.sessionId, result.result]));
      for (const target of targets) {
        const current = this.targets.get(target.sessionId);
        if (!current || current.launchId !== target.launchId) continue;

        const result = resultBySessionId.get(target.sessionId);
        if (!result) {
          this.onEvent("managed_window.probe_missing_result", {
            sessionId: target.sessionId,
            launchId: target.launchId,
          });
          continue;
        }

        if (result.ok) {
          if (this.misses.delete(target.sessionId)) {
            this.onEvent("managed_window.probe_recovered", {
              sessionId: target.sessionId,
              launchId: target.launchId,
            });
          }
          continue;
        }

        const misses = (this.misses.get(target.sessionId) ?? 0) + 1;
        this.misses.set(target.sessionId, misses);
        this.onEvent("managed_window.probe_miss", {
          sessionId: target.sessionId,
          launchId: target.launchId,
          misses,
          message: result.message,
        });
        if (misses < this.missesBeforeOffline || this.offlinePending.has(target.sessionId)) {
          continue;
        }

        this.offlinePending.add(target.sessionId);
        try {
          await this.onOffline(target);
          if (generation !== this.generation) return;
          this.misses.delete(target.sessionId);
          this.onEvent("managed_window.offline", {
            sessionId: target.sessionId,
            launchId: target.launchId,
            reason: "window-heartbeat-missed",
          });
        } catch (error) {
          this.onEvent("managed_window.offline_error", {
            sessionId: target.sessionId,
            launchId: target.launchId,
            reason: "window-heartbeat-missed",
            message: (error as Error).message,
          });
        } finally {
          this.offlinePending.delete(target.sessionId);
        }
      }
    } catch (error) {
      if (generation === this.generation) {
        this.onEvent("managed_window.probe_error", {
          sessionCount: targets.length,
          message: (error as Error).message,
        });
      }
    } finally {
      this.probeRunning = false;
    }
  }
}
