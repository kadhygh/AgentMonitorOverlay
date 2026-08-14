export interface AdaptivePollHost {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timerId: number): void;
}

export interface AdaptivePollControllerOptions {
  host?: AdaptivePollHost;
  nextDelayMs(): number | null;
  run(reason: string): Promise<void> | void;
  onError?(error: Error, reason: string): void;
}

function createBrowserPollHost(): AdaptivePollHost {
  return {
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timerId) => window.clearTimeout(timerId),
  };
}

export class AdaptivePollController {
  private active = true;
  private inFlight = false;
  private queuedReason: string | null = null;
  private running = false;
  private timerId: number | null = null;
  private readonly host: AdaptivePollHost;

  constructor(private readonly options: AdaptivePollControllerOptions) {
    this.host = options.host ?? createBrowserPollHost();
  }

  start(reason = "startup") {
    if (this.running) return;
    this.running = true;
    if (this.active) this.request(reason);
  }

  stop() {
    this.running = false;
    this.queuedReason = null;
    this.clearTimer();
  }

  setActive(active: boolean, resumeReason = "resume") {
    if (this.active === active) return false;
    this.active = active;
    if (!active) {
      this.clearTimer();
    } else if (this.running) {
      this.request(resumeReason);
    }
    return true;
  }

  request(reason: string) {
    if (!this.running || !this.active) return;
    this.clearTimer();
    if (this.inFlight) {
      this.queuedReason = reason;
      return;
    }

    this.inFlight = true;
    void Promise.resolve(this.options.run(reason))
      .catch((error) => this.options.onError?.(error as Error, reason))
      .finally(() => {
        this.inFlight = false;
        if (!this.running || !this.active) return;
        const queuedReason = this.queuedReason;
        this.queuedReason = null;
        if (queuedReason) this.request(queuedReason);
        else this.scheduleNext();
      });
  }

  private scheduleNext() {
    if (!this.running || !this.active || this.timerId !== null) return;
    const delayMs = this.options.nextDelayMs();
    if (delayMs === null || !Number.isFinite(delayMs) || delayMs <= 0) return;
    this.timerId = this.host.setTimeout(() => {
      this.timerId = null;
      this.request("poll");
    }, delayMs);
  }

  private clearTimer() {
    if (this.timerId === null) return;
    this.host.clearTimeout(this.timerId);
    this.timerId = null;
  }
}
