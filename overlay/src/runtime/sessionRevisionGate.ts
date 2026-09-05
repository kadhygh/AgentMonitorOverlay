export interface SessionRevisionObservation {
  accepted: boolean;
  duplicate: boolean;
  gap: boolean;
  previousRevision: number;
  revision: number;
}

export class SessionRevisionGate {
  private revision = 0;
  private instanceId: string | null = null;
  private retiredInstances = new Set<string>();
  private generation = 0;

  requestGeneration() {
    return this.generation;
  }

  instance() {
    return this.instanceId;
  }

  observeInstance(instanceId?: string) {
    if (!instanceId || instanceId === this.instanceId) return { accepted: true, changed: false };
    if (this.retiredInstances.has(instanceId)) return { accepted: false, changed: false };
    if (this.instanceId) this.retiredInstances.add(this.instanceId);
    this.instanceId = instanceId;
    this.generation += 1;
    this.revision = 0;
    return { accepted: true, changed: true };
  }

  current() {
    return this.revision;
  }

  observeEvent(value: unknown, instanceId?: string): SessionRevisionObservation {
    if (instanceId && this.instanceId && instanceId !== this.instanceId) {
      return { accepted: false, duplicate: true, gap: false, previousRevision: this.revision, revision: this.revision };
    }
    this.observeInstance(instanceId);
    const next = normalizeRevision(value);
    const previousRevision = this.revision;
    if (next === null || next <= previousRevision) {
      return {
        accepted: next === null,
        duplicate: next !== null,
        gap: false,
        previousRevision,
        revision: next ?? previousRevision,
      };
    }

    this.revision = next;
    return {
      accepted: true,
      duplicate: false,
      gap: previousRevision > 0 && next > previousRevision + 1,
      previousRevision,
      revision: next,
    };
  }

  acceptSnapshot(value: unknown, instanceId?: string, requestGeneration = this.generation) {
    if (requestGeneration !== this.generation && instanceId !== this.instanceId) {
      return { accepted: false, revision: this.revision };
    }
    if (!this.observeInstance(instanceId).accepted) return { accepted: false, revision: this.revision };
    const next = normalizeRevision(value);
    if (next === null) return { accepted: this.revision === 0, revision: this.revision };
    if (next < this.revision) return { accepted: false, revision: next };
    this.revision = next;
    return { accepted: true, revision: next };
  }
}

export function createSingleFlight<T>() {
  let inFlight: Promise<T> | null = null;
  return {
    run(factory: () => Promise<T>) {
      if (inFlight) return inFlight;
      inFlight = factory().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
    active() {
      return inFlight !== null;
    },
  };
}

function normalizeRevision(value: unknown) {
  const revision = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(revision) && revision >= 0 ? revision : null;
}
