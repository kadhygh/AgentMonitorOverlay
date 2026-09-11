const { createHash } = require("node:crypto");
const text = (value, max = 1024) => typeof value === "string" ? value.slice(0, max) : "";
const timestamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function observeAttention(session) {
  const replyAt = timestamp(session.lastReplyAt);
  // Reply artifacts retain identity after legacy review flags and reviewTurnId are cleared.
  const replyIdentity = text(session.lastReplyNoteAbsolutePath || session.lastReplyNote, 4096);
  const replyTurn = text(session.reviewTurnId);
  const keys = [hash(["reply-time", replyAt])];
  if (replyIdentity) keys.push(hash(["reply-artifact", replyIdentity]));
  if (replyTurn && replyTurn !== "unknown-turn") keys.push(hash(["reply-turn", replyTurn]));
  const reply = replyAt ? { keys, at: replyAt } : null;
  const blockingKind = { waiting_permission: "permission", waiting_user: "input", failed: "failure" }[session.state] || null;
  return {
    reply,
    blocking: blockingKind ? { kind: blockingKind, identity: hash([blockingKind, text(session.activeTurnId), text(session.permissionRequestId || session.pendingPermissionId)]), at: timestamp(session.updatedAt) } : null,
  };
}

module.exports = { text, timestamp, hash, observeAttention };
