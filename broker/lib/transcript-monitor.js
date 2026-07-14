const fs = require("fs");
const path = require("path");

const DEFAULT_POLL_INTERVAL_MS = 250;
const READ_CHUNK_BYTES = 256 * 1024;
const MAX_PENDING_LINE_BYTES = 4 * 1024 * 1024;
const TURN_ABORTED_TOKEN = Buffer.from('"turn_aborted"', "utf8");

function createTranscriptMonitor({
  onTurnAborted,
  recordDebugLog = () => {},
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  if (typeof onTurnAborted !== "function") {
    throw new Error("createTranscriptMonitor requires onTurnAborted");
  }

  const trackedBySession = new Map();
  let polling = false;
  let disposed = false;

  const timer = setInterval(() => {
    void pollNow();
  }, normalizePollInterval(pollIntervalMs));
  timer.unref?.();

  function track(payload = {}, session = null) {
    if (disposed) return false;

    const tool = normalizeText(payload.tool) || normalizeText(session?.tool);
    if (!tool || !tool.toLowerCase().includes("codex")) return false;

    const sessionId = normalizeText(payload.sessionId || payload.session_id) || normalizeText(session?.sessionId);
    const transcriptPath = normalizeText(payload.transcriptPath || payload.transcript_path) || normalizeText(session?.transcriptPath);
    if (!sessionId || !isSupportedTranscriptPath(transcriptPath)) return false;

    const absolutePath = path.resolve(transcriptPath);
    const activeTurnId = normalizeText(payload.turnId || payload.turn_id) || normalizeText(session?.activeTurnId);
    const existing = trackedBySession.get(sessionId);
    if (existing && samePath(existing.transcriptPath, absolutePath)) {
      existing.activeTurnId = activeTurnId || existing.activeTurnId || null;
      return true;
    }

    const offset = currentFileSize(absolutePath);
    trackedBySession.set(sessionId, {
      sessionId,
      transcriptPath: absolutePath,
      activeTurnId: activeTurnId || null,
      offset,
      pending: Buffer.alloc(0),
      discardUntilNewline: false,
      seenAbortKeys: new Set(),
    });
    recordDebugLog("broker", "transcript_monitor.tracked", {
      sessionId,
      transcriptPath: absolutePath,
      activeTurnId: activeTurnId || null,
      offset,
    });
    return true;
  }

  async function pollNow() {
    if (disposed || polling) return;
    polling = true;
    try {
      for (const entry of trackedBySession.values()) {
        await pollEntry(entry);
      }
    } finally {
      polling = false;
    }
  }

  async function pollEntry(entry) {
    let stat;
    try {
      stat = await fs.promises.stat(entry.transcriptPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        recordDebugLog("broker", "transcript_monitor.stat_failed", {
          sessionId: entry.sessionId,
          transcriptPath: entry.transcriptPath,
          message: error?.message || String(error),
        });
      }
      return;
    }

    if (!stat.isFile()) return;
    if (stat.size < entry.offset) {
      entry.offset = 0;
      entry.pending = Buffer.alloc(0);
      entry.discardUntilNewline = false;
    }
    if (stat.size === entry.offset) return;

    let handle;
    try {
      handle = await fs.promises.open(entry.transcriptPath, "r");
      while (entry.offset < stat.size) {
        const length = Math.min(READ_CHUNK_BYTES, stat.size - entry.offset);
        const chunk = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(chunk, 0, length, entry.offset);
        if (bytesRead <= 0) break;
        entry.offset += bytesRead;
        await consumeChunk(entry, chunk.subarray(0, bytesRead));
      }
    } catch (error) {
      recordDebugLog("broker", "transcript_monitor.read_failed", {
        sessionId: entry.sessionId,
        transcriptPath: entry.transcriptPath,
        message: error?.message || String(error),
      });
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function consumeChunk(entry, chunk) {
    let data = entry.pending.length > 0 ? Buffer.concat([entry.pending, chunk]) : chunk;
    entry.pending = Buffer.alloc(0);
    let start = 0;

    while (start < data.length) {
      const newline = data.indexOf(0x0a, start);
      if (newline < 0) break;

      if (!entry.discardUntilNewline) {
        await processLine(entry, data.subarray(start, newline));
      }
      entry.discardUntilNewline = false;
      start = newline + 1;
    }

    const remainder = data.subarray(start);
    if (entry.discardUntilNewline) return;
    if (remainder.length > MAX_PENDING_LINE_BYTES && !remainder.includes(TURN_ABORTED_TOKEN)) {
      entry.discardUntilNewline = true;
      recordDebugLog("broker", "transcript_monitor.long_line_skipped", {
        sessionId: entry.sessionId,
        transcriptPath: entry.transcriptPath,
        bytes: remainder.length,
      });
      return;
    }
    entry.pending = Buffer.from(remainder);
  }

  async function processLine(entry, lineBuffer) {
    if (!lineBuffer.includes(TURN_ABORTED_TOKEN)) return;

    let row;
    try {
      row = JSON.parse(lineBuffer.toString("utf8").trim());
    } catch {
      return;
    }
    if (row?.type !== "event_msg" || row?.payload?.type !== "turn_aborted") return;

    const turnId = normalizeText(row.payload.turn_id);
    const observedAt = normalizeTimestamp(row.timestamp);
    const abortKey = `${turnId || "unknown-turn"}:${observedAt || "unknown-time"}`;
    if (entry.seenAbortKeys.has(abortKey)) return;
    entry.seenAbortKeys.add(abortKey);
    trimSeenKeys(entry.seenAbortKeys);

    recordDebugLog("broker", "transcript_monitor.turn_aborted", {
      sessionId: entry.sessionId,
      turnId: turnId || null,
      reason: normalizeText(row.payload.reason) || "interrupted",
      transcriptPath: entry.transcriptPath,
      observedAt,
    });
    await onTurnAborted({
      sessionId: entry.sessionId,
      turnId: turnId || null,
      reason: normalizeText(row.payload.reason) || "interrupted",
      transcriptPath: entry.transcriptPath,
      observedAt,
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    trackedBySession.clear();
  }

  return {
    dispose,
    pollNow,
    status: () => ({ tracked: trackedBySession.size, polling }),
    track,
  };
}

function currentFileSize(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

function isSupportedTranscriptPath(value) {
  return Boolean(value && path.isAbsolute(value) && path.extname(value).toLowerCase() === ".jsonl");
}

function normalizePollInterval(value) {
  return Number.isFinite(value) && value >= 25 ? value : DEFAULT_POLL_INTERVAL_MS;
}

function normalizeText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeTimestamp(value) {
  const text = normalizeText(value);
  if (!text) return new Date().toISOString();
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function trimSeenKeys(keys) {
  while (keys.size > 100) {
    keys.delete(keys.values().next().value);
  }
}

module.exports = {
  createTranscriptMonitor,
};
