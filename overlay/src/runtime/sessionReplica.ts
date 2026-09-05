import type { AgentSession } from "../types";

export class SessionReplica {
  private instanceId: string | null = null;
  private latest = new Map<string, AgentSession>();
  private snapshot: AgentSession[] = [];
  private revision = 0;

  beginInstance(instanceId?: string) {
    if (!instanceId || instanceId === this.instanceId) return;
    this.instanceId = instanceId;
    this.latest.clear();
    this.revision = 0;
  }

  current() {
    return this.snapshot;
  }

  acceptsSnapshot(instanceId?: string, storeRevision?: number) {
    return instanceId !== this.instanceId || storeRevision === undefined || storeRevision >= this.revision;
  }

  markMissingActive(activeSessions: AgentSession[], storeRevision?: number) {
    if (storeRevision === undefined) return;
    const ids = new Set(activeSessions.map((session) => session.sessionId));
    for (const session of this.snapshot) {
      if (!session.archivedAt && !ids.has(session.sessionId)) {
        this.remember({ ...session, dismissedAt: "snapshot-absent", sessionRevision: storeRevision });
      }
    }
    this.revision = Math.max(this.revision, storeRevision);
  }

  remember(incoming: AgentSession) {
    if (this.instanceId && incoming.brokerInstanceId && incoming.brokerInstanceId !== this.instanceId) {
      return this.latest.get(incoming.sessionId) || null;
    }
    const previous = this.latest.get(incoming.sessionId);
    if (previous?.sessionRevision !== undefined && (incoming.sessionRevision ?? -1) < previous.sessionRevision) return previous;
    this.revision = Math.max(this.revision, incoming.sessionRevision || 0);
    if (previous === incoming || (previous && JSON.stringify(previous) === JSON.stringify(incoming))) return previous;
    this.latest.set(incoming.sessionId, incoming);
    return incoming;
  }

  replace(proposed: AgentSession[]) {
    const next: AgentSession[] = [];
    const ids = new Set<string>();
    for (const incoming of proposed) {
      const session = this.remember(incoming);
      if (!session || session.dismissedAt || ids.has(session.sessionId)) continue;
      ids.add(session.sessionId);
      next.push(session);
    }
    if (next.length !== this.snapshot.length || next.some((session, index) => session !== this.snapshot[index])) {
      this.snapshot = next;
    }
    return this.snapshot;
  }
}
