import type { ActivationCandidate, WindowActivationRequest, WindowProbeResult } from "../types";

export interface ManagedWindowTarget {
  sessionId: string;
  launchId: string;
  request: WindowActivationRequest;
}

interface ManagedWindowMonitorOptions {
  intervalMs?: number;
  missesBeforeOffline?: number;
  initialResolutionGraceMs?: number;
  now?: () => number;
  onEvent?: (event: string, data: Record<string, unknown>) => void;
  onOffline: (target: ManagedWindowTarget) => Promise<void>;
  onResolved?: (target: ManagedWindowTarget, candidate: ActivationCandidate) => Promise<void>;
  probe: (requests: WindowActivationRequest[]) => Promise<WindowProbeResult[]>;
}

const DEFAULT_INTERVAL_MS = 2500;
const DEFAULT_MISSES_BEFORE_OFFLINE = 2;
const DEFAULT_INITIAL_RESOLUTION_GRACE_MS = 15_000;

interface ManagedWindowPhase {
  launchId: string;
  firstObservedAt: number;
  resolved: boolean;
  unresolvedLogged: boolean;
}

export class ManagedWindowMonitor {
  private readonly intervalMs: number;
  private readonly missesBeforeOffline: number;
  private readonly initialResolutionGraceMs: number;
  private readonly now: () => number;
  private readonly onEvent: (event: string, data: Record<string, unknown>) => void;
  private readonly onOffline: (target: ManagedWindowTarget) => Promise<void>;
  private readonly onResolved: (target: ManagedWindowTarget, candidate: ActivationCandidate) => Promise<void>;
  private readonly probe: (requests: WindowActivationRequest[]) => Promise<WindowProbeResult[]>;
  private readonly targets = new Map<string, ManagedWindowTarget>();
  private readonly phases = new Map<string, ManagedWindowPhase>();
  private readonly misses = new Map<string, number>();
  private readonly offlinePending = new Set<string>();
  private readonly resolutionPending = new Set<string>();
  private timerId: number | null = null;
  private probeRunning = false;
  private generation = 0;

  constructor(options: ManagedWindowMonitorOptions) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.missesBeforeOffline = options.missesBeforeOffline ?? DEFAULT_MISSES_BEFORE_OFFLINE;
    this.initialResolutionGraceMs = options.initialResolutionGraceMs ?? DEFAULT_INITIAL_RESOLUTION_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.onOffline = options.onOffline;
    this.onResolved = options.onResolved ?? (async () => undefined);
    this.probe = options.probe;
  }

  updateTargets(nextTargets: ManagedWindowTarget[]) {
    const nextIds = new Set(nextTargets.map((target) => target.sessionId));
    for (const sessionId of this.targets.keys()) {
      if (nextIds.has(sessionId)) continue;
      this.targets.delete(sessionId);
      this.phases.delete(sessionId);
      this.misses.delete(sessionId);
      this.offlinePending.delete(sessionId);
      this.resolutionPending.delete(sessionId);
    }

    for (const target of nextTargets) {
      const previous = this.targets.get(target.sessionId);
      const previousPhase = this.phases.get(target.sessionId);
      if (previous?.launchId !== target.launchId) {
        this.phases.set(target.sessionId, {
          launchId: target.launchId,
          firstObservedAt: this.now(),
          resolved: Boolean(target.request.hwnd),
          unresolvedLogged: false,
        });
        this.misses.delete(target.sessionId);
        this.offlinePending.delete(target.sessionId);
        this.resolutionPending.delete(target.sessionId);
      } else if (previousPhase && target.request.hwnd) {
        previousPhase.resolved = true;
        previousPhase.unresolvedLogged = false;
      }
      const request = previous?.request.hwnd && !target.request.hwnd
        ? { ...target.request, hwnd: previous.request.hwnd, pid: previous.request.pid, processName: previous.request.processName }
        : target.request;
      this.targets.set(target.sessionId, { ...target, request });
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
    this.phases.clear();
    this.misses.clear();
    this.offlinePending.clear();
    this.resolutionPending.clear();
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
          const candidate = result.candidates?.[0];
          if (candidate) {
            const phase = this.phases.get(target.sessionId);
            if (phase) {
              phase.resolved = true;
              phase.unresolvedLogged = false;
            }
            if (!current.request.hwnd && !this.resolutionPending.has(target.sessionId)) {
              const resolvedTarget = {
                ...current,
                request: {
                  ...current.request,
                  hwnd: candidate.hwnd,
                  pid: candidate.processId,
                  processName: candidate.processName ?? current.request.processName,
                },
              };
              this.targets.set(target.sessionId, resolvedTarget);
              this.resolutionPending.add(target.sessionId);
              try {
                await this.onResolved(resolvedTarget, candidate);
                this.onEvent("managed_window.resolved", {
                  sessionId: target.sessionId,
                  launchId: target.launchId,
                  hwnd: candidate.hwnd,
                  pid: candidate.processId,
                  processName: candidate.processName ?? null,
                });
              } catch (error) {
                this.onEvent("managed_window.resolve_error", {
                  sessionId: target.sessionId,
                  launchId: target.launchId,
                  message: (error as Error).message,
                });
              } finally {
                this.resolutionPending.delete(target.sessionId);
              }
            }
          }
          continue;
        }

        const phase = this.phases.get(target.sessionId);
        if (!phase?.resolved) {
          const elapsedMs = phase ? this.now() - phase.firstObservedAt : 0;
          if (elapsedMs < this.initialResolutionGraceMs) {
            this.onEvent("managed_window.awaiting_resolution", {
              sessionId: target.sessionId,
              launchId: target.launchId,
              elapsedMs,
              graceMs: this.initialResolutionGraceMs,
              message: result.message,
            });
          } else if (phase && !phase.unresolvedLogged) {
            phase.unresolvedLogged = true;
            this.onEvent("managed_window.unresolved", {
              sessionId: target.sessionId,
              launchId: target.launchId,
              elapsedMs,
              message: result.message,
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
