const { randomUUID } = require("node:crypto");

class SessionCollection extends Map {
  constructor() {
    super();
    this.brokerInstanceId = randomUUID();
    this.revision = 0;
    this.archivedCount = 0;
  }

  stamp(session) {
    // Version the mutation before any asynchronous persistence or publication can interleave.
    session.sessionRevision = ++this.revision;
    session.brokerInstanceId = this.brokerInstanceId;
    return session;
  }

  set(sessionId, session) {
    if (this.get(sessionId)?.archivedAt) this.archivedCount -= 1;
    if (session.archivedAt) this.archivedCount += 1;
    return super.set(sessionId, this.stamp(session));
  }

  delete(sessionId) {
    if (this.get(sessionId)?.archivedAt) this.archivedCount -= 1;
    return super.delete(sessionId);
  }

  clear() {
    this.archivedCount = 0;
    super.clear();
  }

  get counts() {
    return { active: this.size - this.archivedCount, archived: this.archivedCount, total: this.size };
  }
}

module.exports = { SessionCollection };
