const fs = require("node:fs");
const path = require("node:path");

const RETRYABLE_REPLACE_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

function createSnapshotWriter({
  dataFile,
  createSnapshot,
  recordDebugLog = () => {},
  debounceMs = 150,
  maxWaitMs = 1000,
  fileSystem = fs.promises,
} = {}) {
  if (!dataFile) throw new Error("createSnapshotWriter requires dataFile");
  if (typeof createSnapshot !== "function") throw new Error("createSnapshotWriter requires createSnapshot");

  let dirty = false;
  let debounceTimer = null;
  let maxWaitTimer = null;
  let inFlight = null;
  let firstDirtyAt = 0;
  let writeSequence = 0;
  let scheduledChanges = 0;
  let completedWrites = 0;
  let lastError = null;

  function schedule(reason = "mutation") {
    dirty = true;
    scheduledChanges += 1;
    if (!firstDirtyAt) firstDirtyAt = Date.now();

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void drain("debounce").catch(() => undefined);
    }, debounceMs);
    debounceTimer.unref?.();

    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => {
        maxWaitTimer = null;
        void drain("max-wait").catch(() => undefined);
      }, maxWaitMs);
      maxWaitTimer.unref?.();
    }

    recordDebugLog("broker", "snapshot.persist_scheduled", {
      reason,
      dirty,
      inFlight: Boolean(inFlight),
      scheduledChanges,
    });
  }

  async function flush(reason = "explicit") {
    if (!dirty && !inFlight) return status();
    clearTimers();
    await drain(reason);
    if (inFlight) await inFlight;
    if (dirty) await drain(`${reason}-followup`);
    return status();
  }

  function drain(reason) {
    if (inFlight) return inFlight;
    if (!dirty) return Promise.resolve(status());

    inFlight = runWrites(reason).finally(() => {
      inFlight = null;
      if (dirty && !lastError) {
        queueMicrotask(() => {
          void drain("dirty-followup").catch(() => undefined);
        });
      }
    });
    return inFlight;
  }

  async function runWrites(reason) {
    while (dirty) {
      dirty = false;
      clearTimers();
      const coalescedChanges = scheduledChanges;
      scheduledChanges = 0;
      const dirtyAgeMs = firstDirtyAt ? Date.now() - firstDirtyAt : 0;
      firstDirtyAt = 0;
      const startedAt = Date.now();

      try {
        const snapshot = createSnapshot();
        const text = `${JSON.stringify(snapshot, null, 2)}\n`;
        await writeTextFileAtomic(dataFile, text, {
          fileSystem,
          sequence: ++writeSequence,
        });
        completedWrites += 1;
        lastError = null;
        recordDebugLog("broker", "snapshot.persist_complete", {
          reason,
          durationMs: Date.now() - startedAt,
          dirtyAgeMs,
          bytes: Buffer.byteLength(text),
          sessionCount: Array.isArray(snapshot.sessions) ? snapshot.sessions.length : null,
          coalescedChanges,
          completedWrites,
        });
      } catch (error) {
        dirty = true;
        scheduledChanges += Math.max(1, coalescedChanges);
        if (!firstDirtyAt) firstDirtyAt = Date.now();
        lastError = error;
        recordDebugLog("broker", "snapshot.persist_error", {
          reason,
          durationMs: Date.now() - startedAt,
          code: error?.code || null,
          message: error?.message || String(error),
          coalescedChanges,
        });
        throw error;
      }
    }

    return status();
  }

  function status() {
    return {
      dirty,
      inFlight: Boolean(inFlight),
      scheduledChanges,
      completedWrites,
      lastError: lastError
        ? { code: lastError.code || null, message: lastError.message || String(lastError) }
        : null,
    };
  }

  function clearTimers() {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (maxWaitTimer) clearTimeout(maxWaitTimer);
    debounceTimer = null;
    maxWaitTimer = null;
  }

  return {
    flush,
    schedule,
    status,
  };
}

async function writeTextFileAtomic(filePath, content, { fileSystem = fs.promises, sequence = 0 } = {}) {
  await fileSystem.mkdir(path.dirname(filePath), { recursive: true });
  const tmpFile = `${filePath}.${process.pid}.${sequence}.tmp`;
  await fileSystem.writeFile(tmpFile, content, "utf8");
  try {
    await replaceFileAtomic(tmpFile, filePath, { fileSystem });
  } catch (error) {
    await fileSystem.rm(tmpFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function replaceFileAtomic(tmpFile, filePath, { fileSystem = fs.promises } = {}) {
  const attempts = process.platform === "win32" ? 6 : 1;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fileSystem.rename(tmpFile, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE_REPLACE_CODES.has(error?.code) || attempt === attempts - 1) break;
      await delay(20 * (attempt + 1));
    }
  }

  if (process.platform === "win32" && RETRYABLE_REPLACE_CODES.has(lastError?.code)) {
    await fileSystem.copyFile(tmpFile, filePath);
    await fileSystem.rm(tmpFile, { force: true });
    return;
  }

  throw lastError;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = {
  createSnapshotWriter,
  replaceFileAtomic,
  writeTextFileAtomic,
};
