const crypto = require("crypto");
const path = require("path");
const { AMO_SCHEMA_VERSION } = require("./amo-constants");
const { readJsonFile, writeJsonFile } = require("./filesystem");
const { normalizeInteger, normalizeText } = require("./normalize");
const { isManagedLaunchWindowTarget } = require("./target-binding");

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
    // 辅助护栏：事件 cwd 必须落在 launch.workspacePath 之内。codex 的记忆整理子会话
    // cwd 在 ~/.codex/memories（workspace 之外），在此直接拒绝，避免它干扰主会话绑定。
    // 未携带 cwd 的事件放行（保持向后兼容）；主护栏是下方的 sessionId 锁定。
    const eventCwd = normalizeText(payload?.cwd);
    if (eventCwd && launch.workspacePath && !isPathWithin(eventCwd, launch.workspacePath)) {
      recordDebugLog("broker", "launch.claim_cwd_outside_workspace", {
        launchId,
        sessionId,
        cwd: eventCwd,
        workspacePath: launch.workspacePath,
      });
      return { kind: "foreign", launch, sessionId, reason: "cwd_outside_workspace" };
    }
    const previousSessionId = launch.currentSessionId || launch.claimedSessionId || null;
    const eventName = normalizeText(
      payload?.event || payload?.eventName || payload?.hookEventName || payload?.hook_event_name || payload?.type
    )?.toLowerCase();
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
    if (!previousSessionId && launch.mode === "new" && eventName !== "sessionstart") {
      recordDebugLog("broker", "launch.owner_waiting_session_start", {
        launchId,
        sessionId,
        eventName: eventName || null,
      });
      return { kind: "pending-owner", launch, sessionId };
    }
    // 主护栏：一个 managed launch 锁定到首次 claim 的 sessionId。之后同一 launch 收到
    // 不同 sessionId 的事件（codex 记忆整理子会话、subagent 等继承 AMO_LAUNCH_ID 的
    // 派生会话）不再接管绑定，而是作为独立 card 走权限/review 流程；需要更换绑定时，
    // 必须显式重新 launch/resume，而不是被动地由子会话事件迁移。
    if (previousSessionId && previousSessionId !== sessionId) {
      const ownerSession = options.sessions instanceof Map ? options.sessions.get(previousSessionId) : null;
      payload.observedLaunchId = launchId;
      payload.launchRelation = "attached-child";
      payload.routeOwnerSessionId = previousSessionId;
      payload.workspaceId = launch.workspaceId;
      payload.workspacePath = launch.workspacePath;
      payload.launchId = null;
      payload.launchState = null;
      payload.launchRevision = null;
      payload.windowHint = ownerSession?.windowHint || null;
      payload.targetBinding = null;
      recordDebugLog("broker", "launch.child_attached", {
        launchId,
        sessionId,
        ownerSessionId: previousSessionId,
        hookPid: normalizeInteger(payload?.hookPid || payload?.hook_pid),
        hookParentPid: normalizeInteger(payload?.hookParentPid || payload?.hook_parent_pid),
      });
      return { kind: "attached-child", launch, sessionId, ownerSessionId: previousSessionId };
    }
    clearSupersededTargetBinding(options.sessions, sessionId, !previousSessionId);
    const claimedAt = new Date().toISOString();
    const bindingRevision = !previousSessionId
      ? (Number.isInteger(launch.bindingRevision) ? launch.bindingRevision : 0) + 1
      : launch.bindingRevision || 1;
    const claimed = update(launchId, {
      state: "connected",
      claimedSessionId: sessionId,
      currentSessionId: sessionId,
      firstClaimedSessionId: launch.firstClaimedSessionId || sessionId,
      ownerSessionId: launch.ownerSessionId || sessionId,
      cliHostPid: normalizeInteger(payload?.hookParentPid || payload?.hook_parent_pid) || launch.cliHostPid || null,
      bindingRevision,
      claimedAt,
    });
    payload.workspaceId = launch.workspaceId;
    payload.workspacePath = launch.workspacePath;
    payload.launchId = launch.launchId;
    payload.launchState = "connected";
    payload.launchRevision = bindingRevision;
    payload.launchRelation = "owner";
    payload.routeOwnerSessionId = null;
    payload.observedLaunchId = launch.launchId;
    payload.windowHint = {
      ...(payload.windowHint || payload.window_hint || {}),
      process: claimed.windowProcessName || null,
      title: `${launch.titleToken} ${launch.adapterId === "claude-cli" ? "Claude CLI" : "Codex CLI"} - ${path.basename(launch.workspacePath)}`,
      titleToken: launch.titleToken,
      titleContains: [launch.titleToken],
      project: path.basename(launch.workspacePath),
      cwd: launch.workspacePath,
      tool: expectedTool,
      pid: claimed.windowPid || null,
      hwnd: claimed.windowHwnd || null,
      boundAt: claimed.windowResolvedAt || null,
      boundBy: "managed-launch",
      boundLabel: `${launch.adapterId === "claude-cli" ? "Claude CLI" : "Codex CLI"} managed launch`,
    };
    recordDebugLog("broker", "launch.claimed", {
      launchId,
      sessionId,
      previousSessionId,
      workspaceId,
      bindingRevision,
    });
    return { kind: "owner", launch: claimed, releasedSession: null };
  }

  function reconcileSessions(sessions) {
    if (!(sessions instanceof Map)) return [];
    const changed = new Map();
    for (const [sessionId, session] of sessions) {
      if (!isManagedLaunchWindowTarget(session.targetBinding)) continue;
      const cleaned = { ...session, targetBinding: null };
      sessions.set(sessionId, cleaned);
      changed.set(sessionId, cleaned);
    }
    for (const launch of launches.values()) {
      if (launch.state !== "connected") continue;
      const sessionId = launch.ownerSessionId || launch.firstClaimedSessionId || launch.currentSessionId || launch.claimedSessionId;
      const session = sessions.get(sessionId);
      if (!session) continue;
      const next = attachLaunchToSession(session, launch);
      sessions.set(sessionId, next);
      changed.set(sessionId, next);
      for (const [candidateId, candidate] of sessions) {
        if (candidateId === sessionId || candidate.launchId !== launch.launchId) continue;
        const withinWorkspace = isPathWithin(candidate.cwd, launch.workspacePath);
        const detached = {
          ...candidate,
          launchId: null,
          launchState: null,
          launchRevision: null,
          targetBinding: null,
          windowHint: withinWorkspace ? next.windowHint : null,
          launchRelation: withinWorkspace ? "attached-child" : "foreign-leak",
          routeOwnerSessionId: withinWorkspace ? sessionId : null,
          observedLaunchId: launch.launchId,
        };
        sessions.set(candidateId, detached);
        changed.set(candidateId, detached);
      }
    }
    return Array.from(changed.values());
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
          windowHwnd: null,
          windowPid: null,
          windowProcessName: null,
          windowTitle: null,
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
      targetBinding: isManagedLaunchWindowTarget(existing.targetBinding) ? null : existing.targetBinding || null,
    };
    sessions.set(sessionId, session);
    recordDebugLog("broker", "launch.window_offline", {
      sessionId,
      launchId: existing.launchId,
      reason: normalizeText(options.reason) || "window-not-found",
    });
    return session;
  }

  function resolveSessionWindow(sessionId, sessions, options = {}) {
    if (!(sessions instanceof Map)) return null;
    const existing = sessions.get(sessionId);
    if (!existing?.launchId) return null;

    const expectedLaunchId = normalizeText(options.launchId);
    if (!expectedLaunchId || expectedLaunchId !== existing.launchId) return null;

    const launch = launches.get(existing.launchId);
    const launchSessionId = launch?.currentSessionId || launch?.claimedSessionId || null;
    if (!launch || launch.state !== "connected" || launchSessionId !== sessionId) return null;

    const hwnd = normalizeInteger(options.hwnd || options.windowHandle || options.window_handle);
    const pid = normalizeInteger(options.pid || options.processId || options.process_id);
    if (hwnd === null || pid === null) return null;

    const now = new Date().toISOString();
    const processName = normalizeText(options.processName || options.process_name || options.process);
    const title = normalizeText(options.title);
    const resolvedAt = launch.windowResolvedAt || now;
    const updatedLaunch = update(existing.launchId, {
      state: "connected",
      windowHwnd: hwnd,
      windowPid: pid,
      windowProcessName: processName || launch.windowProcessName || null,
      windowTitle: title || launch.windowTitle || null,
      windowResolvedAt: resolvedAt,
      windowLastSeenAt: now,
      offlineAt: null,
      offlineReason: null,
    });
    const baseHint = existing.windowHint || {};
    const session = {
      ...existing,
      launchState: "connected",
      launchWindowResolvedAt: resolvedAt,
      windowHint: {
        ...baseHint,
        process: processName || baseHint.process || null,
        pid,
        hwnd,
        boundAt: baseHint.boundAt || resolvedAt,
        boundBy: "managed-launch",
      },
    };
    sessions.set(sessionId, session);
    recordDebugLog("broker", "launch.window_resolved", {
      sessionId,
      launchId: existing.launchId,
      hwnd,
      pid,
      processName: processName || null,
      title: title || null,
    });
    return { launch: updatedLaunch, session };
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
    resolveSessionWindow,
    supersedeActiveResume,
    update,
  };
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
    launchRelation: "owner",
    routeOwnerSessionId: null,
    observedLaunchId: launch.launchId,
    claudeProviderId: launch.claudeProviderId || null,
    claudeModel: launch.claudeModel || null,
    targetBinding: isManagedLaunchWindowTarget(session.targetBinding) ? null : session.targetBinding || null,
    windowHint: {
      ...(session.windowHint || {}),
      title: `${launch.titleToken} ${launch.adapterId === "claude-cli" ? "Claude CLI" : "Codex CLI"} - ${path.basename(launch.workspacePath)}`,
      titleToken: launch.titleToken,
      titleContains: [launch.titleToken],
      project: path.basename(launch.workspacePath),
      cwd: launch.workspacePath,
      tool: expectedTool,
      process: launch.windowProcessName || null,
      pid: launch.windowPid || null,
      hwnd: launch.windowHwnd || null,
      boundAt: launch.windowResolvedAt || null,
      boundBy: "managed-launch",
      boundLabel: `${launch.adapterId === "claude-cli" ? "Claude CLI" : "Codex CLI"} managed launch`,
    },
    launchWindowResolvedAt: launch.windowResolvedAt || null,
  };
}

function eventSessionId(payload) {
  return normalizeText(payload?.sessionId || payload?.session_id || payload?.threadId || payload?.thread_id);
}

function isPathWithin(childPath, parentPath) {
  if (!childPath || !parentPath) return false;
  const normalize = (value) => String(value).replace(/[\\/]+$/u, "").toLowerCase();
  const child = normalize(childPath);
  const parent = normalize(parentPath);
  if (child === parent) return true;
  return child.startsWith(`${parent}\\`) || child.startsWith(`${parent}/`);
}

function normalizePersistedLaunch(launch) {
  const ownerSessionId = launch.ownerSessionId || launch.firstClaimedSessionId || launch.currentSessionId || launch.claimedSessionId || null;
  const { expiresAt: _legacyExpiresAt, ...normalized } = {
    ...launch,
    ownerSessionId,
    claimedSessionId: ownerSessionId,
    currentSessionId: ownerSessionId,
  };
  if (normalized.state === "expired") normalized.state = "waiting_hook";
  const changed =
    Object.prototype.hasOwnProperty.call(launch, "expiresAt") ||
    launch.ownerSessionId !== normalized.ownerSessionId ||
    launch.claimedSessionId !== normalized.claimedSessionId ||
    launch.currentSessionId !== normalized.currentSessionId ||
    launch.state !== normalized.state;
  return changed ? normalized : launch;
}

function clearSupersededTargetBinding(sessions, sessionId, firstClaim) {
  if (!(sessions instanceof Map)) return;
  const session = sessions.get(sessionId);
  if (!session) return;
  if (!firstClaim && !isManagedLaunchWindowTarget(session.targetBinding)) return;
  sessions.set(sessionId, { ...session, targetBinding: null });
}

module.exports = { createLaunchStore };
