const crypto = require("crypto");
const path = require("path");
const { AMO_SCHEMA_VERSION } = require("./amo-constants");
const { readJsonFile, writeJsonFile } = require("./filesystem");
const { normalizeText } = require("./normalize");

const ACTIVE_LAUNCH_TTL_MS = 2 * 60 * 1000;
const RETAIN_LAUNCH_MS = 24 * 60 * 60 * 1000;

function createLaunchStore({ dataFile, recordDebugLog = () => {} } = {}) {
  if (!dataFile) throw new Error("createLaunchStore requires dataFile");
  const launches = new Map();

  function load() {
    const snapshot = readJsonFile(dataFile, { launches: [] });
    for (const launch of Array.isArray(snapshot?.launches) ? snapshot.launches : []) {
      if (normalizeText(launch?.launchId)) launches.set(launch.launchId, launch);
    }
    prune();
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
      expiresAt: new Date(createdAt.getTime() + ACTIVE_LAUNCH_TTL_MS).toISOString(),
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
    if (!launch || !["spawning", "waiting_hook", "claimed", "connected"].includes(launch.state)) return null;
    if (Date.parse(launch.expiresAt) < Date.now() && !["claimed", "connected"].includes(launch.state)) {
      update(launchId, { state: "expired" });
      return null;
    }

    const sessionId = eventSessionId(payload);
    const workspaceId = normalizeText(payload?.workspaceId || payload?.workspace_id || payload?.amoWorkspaceId || payload?.amo_workspace_id);
    const tool = normalizeText(payload?.tool)?.toLowerCase();
    const expectedTool = launch.adapterId === "claude-cli" ? "claude" : "codex";
    if (!sessionId || workspaceId !== launch.workspaceId || tool !== expectedTool) {
      recordDebugLog("broker", "launch.claim_rejected", { launchId, sessionId, workspaceId, tool });
      return null;
    }
    const previousSessionId = launch.currentSessionId || launch.claimedSessionId || null;
    const transferred = Boolean(previousSessionId && previousSessionId !== sessionId);
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
        ["created", "spawning", "waiting_hook"].includes(launch.state) &&
        Date.parse(launch.expiresAt) >= Date.now()
    ) || null;
  }

  function prune() {
    const cutoff = Date.now() - RETAIN_LAUNCH_MS;
    let changed = false;
    for (const [launchId, launch] of launches) {
      if (Date.parse(launch.updatedAt || launch.createdAt) < cutoff) {
        launches.delete(launchId);
        changed = true;
      } else if (["created", "spawning", "waiting_hook"].includes(launch.state) && Date.parse(launch.expiresAt) < Date.now()) {
        launches.set(launchId, { ...launch, state: "expired", updatedAt: new Date().toISOString() });
        changed = true;
      }
    }
    if (changed) persist();
  }

  load();
  return { claim, create, findActiveResume, list, reconcileSessions, update };
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

module.exports = { ACTIVE_LAUNCH_TTL_MS, createLaunchStore };
