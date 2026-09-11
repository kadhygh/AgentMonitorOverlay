const { randomUUID } = require("node:crypto");

class SessionCollection extends Map {
  constructor() {
    super();
    this.brokerInstanceId = randomUUID();
    this.revision = 0;
    this.archivedCount = 0;
    this.observers = new Set();
  }

  observe(observer) {
    if (typeof observer !== "function") throw new TypeError("Session observer must be a function");
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  notify(change) {
    // Observers must not change existing Map mutation semantics or break legacy writers.
    for (const observer of this.observers) {
      try { observer(change); } catch { /* Observer owners report/retry their own failures. */ }
    }
  }

  stamp(session) {
    // Version the mutation before any asynchronous persistence or publication can interleave.
    session.sessionRevision = ++this.revision;
    session.brokerInstanceId = this.brokerInstanceId;
    return session;
  }

  set(sessionId, session) {
    const previous = this.get(sessionId);
    if (this.get(sessionId)?.archivedAt) this.archivedCount -= 1;
    if (session.archivedAt) this.archivedCount += 1;
    const result = super.set(sessionId, this.stamp(session));
    this.notify({ type: "set", sessionId, session, previous });
    return result;
  }

  delete(sessionId) {
    const session = this.get(sessionId);
    if (this.get(sessionId)?.archivedAt) this.archivedCount -= 1;
    const deleted = super.delete(sessionId);
    if (deleted) this.notify({ type: "delete", sessionId, session });
    return deleted;
  }

  clear() {
    const sessions = [...this.values()];
    this.archivedCount = 0;
    super.clear();
    if (sessions.length) this.notify({ type: "clear", sessions });
  }

  get counts() {
    return { active: this.size - this.archivedCount, archived: this.archivedCount, total: this.size };
  }
}

module.exports = { SessionCollection };
