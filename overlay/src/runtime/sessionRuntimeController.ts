export interface SessionRuntimeEventSource {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
}

export interface SessionRuntimeHost {
  createEventSource: ((url: string) => SessionRuntimeEventSource) | null;
  isOnline(): boolean;
  isVisible(): boolean;
  listenForResume(listener: () => void): () => void;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timerId: number): void;
}

export interface SessionRuntimeControllerOptions {
  eventUrl: string;
  fallbackBaseMs?: number;
  fallbackMaxMs?: number;
  reconcileDelayMs?: number;
  host?: SessionRuntimeHost;
  refresh(reason: string): Promise<void> | void;
  onBrokerReady(event: MessageEvent): void;
  onSessionsChanged(event: MessageEvent): void;
  onReconcileScheduled?(details: {
    reason: string;
    sessionId: string | null;
    delayMs: number;
    rescheduled: boolean;
  }): void;
  onStreamCreateError?(error: Error): void;
  onStreamHealthChanged?(healthy: boolean, readyState: number | null): void;
  onUnsupported?(): void;
}

const DEFAULT_FALLBACK_BASE_MS = 45_000;
const DEFAULT_FALLBACK_MAX_MS = 5 * 60_000;
const DEFAULT_RECONCILE_DELAY_MS = 350;

export function createBrowserSessionRuntimeHost(): SessionRuntimeHost {
  return {
    createEventSource: typeof EventSource === "undefined"
      ? null
      : (url) => new EventSource(url),
    isOnline: () => navigator.onLine,
    isVisible: () => document.visibilityState !== "hidden",
    listenForResume: (listener) => {
      const handleVisibility = () => {
        if (document.visibilityState !== "hidden") listener();
      };
      window.addEventListener("focus", listener);
      window.addEventListener("online", listener);
      document.addEventListener("visibilitychange", handleVisibility);
      return () => {
        window.removeEventListener("focus", listener);
        window.removeEventListener("online", listener);
        document.removeEventListener("visibilitychange", handleVisibility);
      };
    },
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timerId) => window.clearTimeout(timerId),
  };
}

export class SessionRuntimeController {
  private readonly fallbackBaseMs: number;
  private readonly fallbackMaxMs: number;
  private readonly host: SessionRuntimeHost;
  private readonly reconcileDelayMs: number;
  private eventSource: SessionRuntimeEventSource | null = null;
  private fallbackAttempt = 0;
  private fallbackTimer: number | null = null;
  private reconcileTimer: number | null = null;
  private removeResumeListener: (() => void) | null = null;
  private running = false;
  private sseHealthy = false;

  constructor(private readonly options: SessionRuntimeControllerOptions) {
    this.host = options.host ?? createBrowserSessionRuntimeHost();
    this.fallbackBaseMs = options.fallbackBaseMs ?? DEFAULT_FALLBACK_BASE_MS;
    this.fallbackMaxMs = options.fallbackMaxMs ?? DEFAULT_FALLBACK_MAX_MS;
    this.reconcileDelayMs = options.reconcileDelayMs ?? DEFAULT_RECONCILE_DELAY_MS;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.removeResumeListener = this.host.listenForResume(() => this.resume());

    if (!this.host.createEventSource) {
      this.options.onUnsupported?.();
      this.scheduleFallback();
      return;
    }

    try {
      const source = this.host.createEventSource(this.options.eventUrl);
      this.eventSource = source;
      source.onopen = () => this.updateStreamHealth(true);
      source.onerror = () => {
        this.updateStreamHealth(false, source.readyState);
        this.scheduleReconcile("stream-error", null);
        this.scheduleFallback();
      };
      source.addEventListener("broker.ready", ((event: MessageEvent) => {
        this.updateStreamHealth(true);
        this.options.onBrokerReady(event);
      }) as EventListener);
      source.addEventListener("sessions.changed", this.options.onSessionsChanged as EventListener);
      // A connecting EventSource can otherwise leave a failed startup without any snapshot recovery.
      this.scheduleFallback();
    } catch (error) {
      this.eventSource = null;
      this.updateStreamHealth(false);
      this.options.onStreamCreateError?.(error as Error);
      this.scheduleFallback();
    }
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.clearFallback();
    this.clearReconcile();
    this.removeResumeListener?.();
    this.removeResumeListener = null;
    this.eventSource?.close();
    this.eventSource = null;
    this.updateStreamHealth(false);
  }

  isStreamHealthy() {
    return this.sseHealthy;
  }

  scheduleReconcile(reason = "unknown", sessionId: string | null = null) {
    if (!this.running) return;
    const rescheduled = this.reconcileTimer !== null;
    this.clearReconcile();
    this.options.onReconcileScheduled?.({
      reason,
      sessionId,
      delayMs: this.reconcileDelayMs,
      rescheduled,
    });
    this.reconcileTimer = this.host.setTimeout(() => {
      this.reconcileTimer = null;
      void this.options.refresh("sse-reconcile");
    }, this.reconcileDelayMs);
  }

  private resume() {
    if (!this.running || this.sseHealthy || !this.canRefresh()) return;
    this.fallbackAttempt = 0;
    void Promise.resolve(this.options.refresh("runtime-resume")).finally(() => {
      if (this.running && !this.sseHealthy) this.scheduleFallback();
    });
  }

  private scheduleFallback() {
    if (!this.running || this.sseHealthy || this.fallbackTimer !== null) return;
    const delayMs = Math.min(
      this.fallbackMaxMs,
      this.fallbackBaseMs * (2 ** this.fallbackAttempt),
    );
    this.fallbackTimer = this.host.setTimeout(() => {
      this.fallbackTimer = null;
      if (!this.running || this.sseHealthy) return;
      if (!this.canRefresh()) {
        // Hidden/offline runtimes are resumed by semantic visibility and connectivity events.
        return;
      }
      void Promise.resolve(this.options.refresh("runtime-fallback")).finally(() => {
        if (!this.running || this.sseHealthy) return;
        this.fallbackAttempt += 1;
        this.scheduleFallback();
      });
    }, delayMs);
  }

  private updateStreamHealth(healthy: boolean, readyState: number | null = null) {
    if (this.sseHealthy === healthy) return;
    this.sseHealthy = healthy;
    if (healthy) {
      this.fallbackAttempt = 0;
      this.clearFallback();
    }
    this.options.onStreamHealthChanged?.(healthy, readyState);
  }

  private canRefresh() {
    return this.host.isVisible() && this.host.isOnline();
  }

  private clearFallback() {
    if (this.fallbackTimer === null) return;
    this.host.clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  private clearReconcile() {
    if (this.reconcileTimer === null) return;
    this.host.clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
  }
}
