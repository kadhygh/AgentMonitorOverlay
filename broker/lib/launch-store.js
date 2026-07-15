const crypto = require("crypto");
const path = require("path");
const { AMO_SCHEMA_VERSION } = require("./amo-constants");
const { readJsonFile, writeJsonFile } = require("./filesystem");
const { normalizeText } = require("./normalize");

const RETAIN_LAUNCH_MS = 24 * 60 * 60 * 1000;
const ACTIVE_LAUNCH_STATES = new Set(["created", "spawning", "waiting_hook", "claimed", "connected"]);
const TERMINAL_LAUNCH_STATES = new Set(["failed", "offline"]);

function createLaunchStore({ dataFile, recordDebugLog = () => {} } = {}) {
  if (!dataFile) throw new Error("createLaunchStore requires dataFile");
  const launches = new Map();

  function load() {
    const snapshot = readJsonFile(dataFile, { launches: [] });
    let migrated = false;
    for (const launch of Array.isArray(snapshot?.launches) ? snapshot.launches : []) {
      if (!normalizeText(launch?.launchId)) continue;
      const normalized = normalizePersistedLaunch(launch);
      if (normalized !== launch) migrated = true;
      launches.set(normalized.launchId, normalized);
    }
    if (!prune() && migrated) persist();
  }

  function persist() {
    writeJsonFile(dataFile, { schemaVersion: AMO_SCHEMA_VERSION, launches: Array.from(launches.values()) });
  }

  function create({ workspaceId, workspacePath, adapterId, mode = "new", requestedSessionId = null, sourceCardSessionId = null }) {
    const launchId = `launch_${crypto.randomUUID()}`;
    const createdAt = new Date();
    const provider = adapterId === "claude-cli" ? "claude" : "codex";
    const titleToken = `[AMO:${provider}:${launchId.slice(7, 15)}]`;
    const launch = {
      launchId,
      workspaceId,
      workspacePath,
      adapterId,
      mode,
      requestedSessionId,
      sourceCardSessionId,
      titleToken,
      state: "created",
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString(),
      claimedSessionId: null,
      currentSessionId: null,
      bindingRevision: 0,
    };
    launches.set(launchId, launch);
    persist();
    recordDebugLog("broker", "launch.created", launch);
    return launch;
  }

  function update(launchId, patch) {
    const existing = launches.get(launchId);
    if (!existing) return null;
    const launch = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    launches.set(launchId, launch);
    persist();
    return launch;
  }

  function claim(payload, options = {}) {
    const launchId = normalizeText(payload?.launchId || payload?.launch_id || payload?.amoLaunchId || payload?.amo_launch_id);
    if (!launchId) return null;
    const launch = launches.get(launchId);
    if (!launch || (!ACTIVE_LAUNCH_STATES.has(launch.state) && launch.state !== "offline")) return null;

    const sessionId = eventSessionId(payload);
    const workspaceId = normalizeText(payload?.workspaceId || payload?.workspace_id || payload?.amoWorkspaceId || payload?.amo_workspace_id);
    const tool = normalizeText(payload?.tool)?.toLowerCase();
    const expectedTool = launch.adapterId === "claude-cli" ? "claude" : "codex";
    if (!sessionId || workspaceId !== launch.workspaceId || tool !== expectedTool) {
      recordDebugLog("broker", "launch.claim_rejected", { launchId, sessionId, workspaceId, tool });
      return null;
    }
    const previousSessionId = launch.currentSessionId || launch.claimedSessionId || null;
    if (
      launch.mode === "resume" &&
      !previousSessionId &&
      normalizeText(launch.requestedSessionId) &&
      sessionId !== launch.requestedSessionId
    ) {
      recordDebugLog("broker", "launch.resume_session_rejected", {
        launchId,
        sessionId,
        requestedSessionId: launch.requestedSessionId,
      });
      return null;
    }
    if (launch.state === "offline" && options.sessions?.get(sessionId)?.launchId !== launchId) {
      recordDebugLog("broker", "launch.offline_claim_rejected", { launchId, sessionId });
      return null;
    }
    const transferred = Boolean(previousSessionId && previousSessionId !== sessionId);
    clearSupersededTargetBinding(options.sessions, sessionId, !previousSessionId);
    const claimedAt = new Date().toISOString();
    const bindingRevision = transferred || !previousSessionId
      ? (Number.isInteger(launch.bindingRevision) ? launch.bindingRevision : 0) + 1
      : launch.bindingRevision || 1;
    const claimed = update(launchId, {
      state: "connected",
      claimedSessionId: sessionId,
      currentSessionId: sessionId,
      firstClaimedSessionId: launch.firstClaimedSessionId || sessionId,
      bindingRevision,
      claimedAt,
    });
    const releasedSession = transferred
      ? releasePreviousSession(options.sessions, previousSessionId, launchId, claimed.titleToken, bindingRevision)
      : null;
    payload.workspaceId = launch.workspaceId;
    payload.workspacePath = launch.workspacePath;
    payload.launchId = launch.launchId;
    payload.launchState = "connected";
    payload.launchRevision = bindingRevision;
    payload.windowHint = {
      ...(payload.windowHint || payload.window_hint || {}),
      title: `${launch.titleToken} ${launch.adapterId === "claude-cli" ? "Claude CLI" : "Codex CLI"} - ${path.basename(launch.workspacePath)}`,
      titleToken: launch.titleToken,
      titleContains: [launch.titleToken],
      project: path.basename(launch.workspacePath),
      cwd: launch.workspacePath,
      tool: expectedTool,
      boundBy: "managed-launch",
      boundLabel: `${launch.adapterId === "claude-cli" ? "Claude CLI" : "Codex CLI"} managed launch`,
    };
    recordDebugLog("broker", transferred ? "launch.session_transferred" : "launch.claimed", {
      launchId,
      sessionId,
      previousSessionId,
      workspaceId,
      bindingRevision,
    });
    return { launch: claimed, releasedSession };
  }

  function reconcileSessions(sessions) {
    if (!(sessions instanceof Map)) return [];
    const changed = [];
    for (const launch of launches.values()) {
      if (launch.state !== "connected") continue;
      const sessionId = launch.currentSessionId || launch.claimedSessionId;
      const session = sessions.get(sessionId);
      if (!session) continue;
      const next = attachLaunchToSession(session, launch);
      sessions.set(sessionId, next);
      changed.push(next);
    }
    return changed;
  }

  function list() {
    prune();
    return Array.from(launches.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function findActiveResume(sessionId) {
    return Array.from(launches.values()).find(
      (launch) =>
        launch.mode === "resume" &&
        launch.requestedSessionId === sessionId &&
        ["created", "spawning", "waiting_hook"].includes(launch.state)
    ) || null;
  }

  function supersedeActiveResume(sessionId, reason = "resume-retried") {
    const now = new Date().toISOString();
    const superseded = [];
    for (const launch of launches.values()) {
      if (
        launch.mode !== "resume" ||
        launch.requestedSessionId !== sessionId ||
        !["created", "spawning", "waiting_hook"].includes(launch.state)
      ) {
        continue;
      }
      superseded.push(update(launch.launchId, {
        state: "offline",
        offlineAt: now,
        offlineReason: normalizeText(reason) || "resume-retried",
      }));
    }
    return superseded.filter(Boolean);
  }

  function markSessionOffline(sessionId, sessions, options = {}) {
    if (!(sessions instanceof Map)) return null;
    const existing = sessions.get(sessionId);
    if (!existing?.launchId) return existing || null;

    const expectedLaunchId = normalizeText(options.launchId);
    if (expectedLaunchId && expectedLaunchId !== existing.launchId) return existing;

    const now = new Date().toISOString();
    const launch = launches.get(existing.launchId);
    if (launch) {
      const launchSessionId = launch.currentSessionId || launch.claimedSessionId || null;
      if (!launchSessionId || launchSessionId === sessionId) {
        update(existing.launchId, {
          state: "offline",
          offlineAt: now,
          offlineReason: normalizeText(options.reason) || "window-not-found",
        });
      }
    }

    const session = {
      ...existing,
      launchState: "offline",
      launchOfflineAt: now,
      updatedAt: now,
      windowHint: existing.windowHint
        ? { ...existing.windowHint, pid: null, hwnd: null }
        : existing.windowHint,
    };
    sessions.set(sessionId, session);
    recordDebugLog("broker", "launch.window_offline", {
      sessionId,
      launchId: existing.launchId,
      reason: normalizeText(options.reason) || "window-not-found",
    });
    return session;
  }

  function prune() {
    const cutoff = Date.now() - RETAIN_LAUNCH_MS;
    let changed = false;
    for (const [launchId, launch] of launches) {
      if (
        TERMINAL_LAUNCH_STATES.has(launch.state) &&
        Date.parse(launch.updatedAt || launch.createdAt) < cutoff
      ) {
        launches.delete(launchId);
        changed = true;
      }
    }
    if (changed) persist();
    return changed;
  }

  load();
  return {
    claim,
    create,
    findActiveResume,
    list,
    markSessionOffline,
    reconcileSessions,
    supersedeActiveResume,
    update,
  };
}

function releasePreviousSession(sessions, sessionId, launchId, titleToken, bindingRevision) {
  if (!(sessions instanceof Map)) return null;
  const existing = sessions.get(sessionId);
  if (!existing || existing.launchId !== launchId) return null;
  const managedHint = existing.windowHint?.boundBy === "managed-launch" && existing.windowHint?.titleToken === titleToken;
  const released = {
    ...existing,
    launchState: "offline",
    launchRevision: bindingRevision,
    windowHint: managedHint ? null : existing.windowHint || null,
    updatedAt: new Date().toISOString(),
  };
  sessions.set(sessionId, released);
  return released;
}

function attachLaunchToSession(session, launch) {
  const expectedTool = launch.adapterId === "claude-cli" ? "claude" : "codex";
  return {
    ...session,
    workspaceId: launch.workspaceId,
    workspacePath: launch.workspacePath,
    launchId: launch.launchId,
    launchState: launch.state,
    launchRevision: launch.bindingRevision || 1,
    targetBinding: isRedundantManagedWindowTarget(session.targetBinding) ? null : session.targetBinding || null,
    windowHint: {
      ...(session.windowHint || {}),
      title: `${launch.titleToken} ${launch.adapterId === "claude-cli" ? "Claude CLI" : "Codex CLI"} - ${path.basename(launch.workspacePath)}`,
      titleToken: launch.titleToken,
      titleContains: [launch.titleToken],
      project: path.basename(launch.workspacePath),
      cwd: launch.workspacePath,
      tool: expectedTool,
      pid: null,
      hwnd: null,
      boundBy: "managed-launch",
      boundLabel: `${launch.adapterId === "claude-cli" ? "Claude CLI" : "Codex CLI"} managed launch`,
    },
  };
}

function eventSessionId(payload) {
  return normalizeText(payload?.sessionId || payload?.session_id || payload?.threadId || payload?.thread_id);
}

function normalizePersistedLaunch(launch) {
  if (launch.state !== "expired" && !Object.prototype.hasOwnProperty.call(launch, "expiresAt")) {
    return launch;
  }

  const { expiresAt: _legacyExpiresAt, ...normalized } = launch;
  if (normalized.state === "expired") normalized.state = "waiting_hook";
  return normalized;
}

function clearSupersededTargetBinding(sessions, sessionId, firstClaim) {
  if (!(sessions instanceof Map)) return;
  const session = sessions.get(sessionId);
  if (!session) return;
  if (!firstClaim && !isRedundantManagedWindowTarget(session.targetBinding)) return;
  sessions.set(sessionId, { ...session, targetBinding: null });
}

function isRedundantManagedWindowTarget(targetBinding) {
  return targetBinding?.type === "window" && targetBinding?.boundBy === "managed-launch";
}

module.exports = { createLaunchStore };
