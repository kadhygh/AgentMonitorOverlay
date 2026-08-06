export interface SessionRevisionObservation {
  accepted: boolean;
  duplicate: boolean;
  gap: boolean;
  previousRevision: number;
  revision: number;
}

export class SessionRevisionGate {
  private revision = 0;

  current() {
    return this.revision;
  }

  observeEvent(value: unknown): SessionRevisionObservation {
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

  acceptSnapshot(value: unknown) {
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
