const { execFile: defaultExecFile } = require("node:child_process");

function createObsidianProcessProbe({
  execFile = defaultExecFile,
  platform = process.platform,
  ttlMs = 7_500,
  timeoutMs = 650,
  now = () => Date.now(),
  recordDebugLog = () => {},
} = {}) {
  let cached = null;
  let pending = null;

  async function probe({ force = false } = {}) {
    const currentTime = now();
    if (!force && cached && currentTime - cached.checkedAtMs < ttlMs) {
      recordDebugLog("broker", "obsidian.process_probe.cache_hit", {
        state: cached.state,
        count: cached.count,
        ageMs: currentTime - cached.checkedAtMs,
      });
      return { ...cached, cached: true };
    }
    if (pending) {
      recordDebugLog("broker", "obsidian.process_probe.coalesced", {});
      return pending;
    }

    recordDebugLog("broker", "obsidian.process_probe.cache_miss", { timeoutMs });
    pending = runProbe().finally(() => {
      pending = null;
    });
    return pending;
  }

  async function runProbe() {
    const startedAt = now();
    let result;
    if (platform !== "win32") {
      result = processResult("unsupported", null, false, startedAt, now());
    } else {
      result = await new Promise((resolve) => {
        execFile(
          "tasklist.exe",
          ["/FI", "IMAGENAME eq Obsidian.exe", "/FO", "CSV", "/NH"],
          { encoding: "utf8", windowsHide: true, timeout: timeoutMs, killSignal: "SIGKILL" },
          (error, stdout = "") => {
            if (error) {
              const timedOut = Boolean(error.killed) || error.code === "ETIMEDOUT";
              resolve(processResult("unknown", null, timedOut, startedAt, now(), error));
              return;
            }
            const count = String(stdout)
              .split(/\r?\n/u)
              .filter((line) => /^"Obsidian\.exe"/iu.test(line.trim()))
              .length;
            resolve(processResult(count > 0 ? "running" : "not-running", count, false, startedAt, now()));
          },
        );
      });
    }
    cached = { ...result, checkedAtMs: now() };
    recordDebugLog("broker", result.timedOut ? "obsidian.process_probe.timeout" : "obsidian.process_probe.complete", {
      state: result.state,
      count: result.count,
      durationMs: result.durationMs,
      timeoutMs,
      code: result.errorCode,
    });
    return { ...cached, cached: false };
  }

  function invalidate() {
    cached = null;
  }

  function status() {
    return {
      cached: cached ? { ...cached } : null,
      pending: pending !== null,
      ttlMs,
      timeoutMs,
    };
  }

  return { invalidate, probe, status };
}

function processResult(state, count, timedOut, startedAt, completedAt, error = null) {
  return {
    state,
    count,
    timedOut,
    durationMs: Math.max(0, completedAt - startedAt),
    checkedAt: new Date(completedAt).toISOString(),
    errorCode: error?.code || null,
  };
}

const defaultProbe = createObsidianProcessProbe();

module.exports = {
  createObsidianProcessProbe,
  probeObsidianProcesses: defaultProbe.probe,
};
