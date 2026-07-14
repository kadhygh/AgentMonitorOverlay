const { readJsonBody, sendJson } = require("../lib/http");

async function handleSessionRoutes(req, res, url, context) {
  if (req.method === "GET" && url.pathname === "/api/sessions") {
    return sendHandled(res, 200, {
      count: context.sessions.size,
      sessions: context.listSessions(),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/dismiss-all") {
    const payload = await readJsonBody(req, { allowEmpty: true });
    const result = context.dismissAllSessions(payload || {});
    context.persistSnapshot();
    context.publishSessionChanged("dismiss-all", null);
    return sendHandled(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/session-events") {
    context.openSessionEventStream(req, res);
    return true;
  }

  const windowBindingMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/window-binding$/);
  if (req.method === "POST" && windowBindingMatch) {
    const sessionId = decodeURIComponent(windowBindingMatch[1]);
    const payload = await readJsonBody(req);
    const result = context.bindSessionWindow(sessionId, payload);
    context.persistSnapshot();
    context.publishSessionChanged("window-bind", result.session);
    return sendHandled(res, 200, result);
  }

  const clearWindowBindingMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/window-binding\/clear$/);
  if (req.method === "POST" && clearWindowBindingMatch) {
    const sessionId = decodeURIComponent(clearWindowBindingMatch[1]);
    const result = context.clearSessionWindowBinding(sessionId);
    context.persistSnapshot();
    context.publishSessionChanged("window-unbind", result.session);
    return sendHandled(res, 200, result);
  }

  const targetBindingMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/target-binding$/);
  if (req.method === "POST" && targetBindingMatch) {
    const sessionId = decodeURIComponent(targetBindingMatch[1]);
    const payload = await readJsonBody(req);
    const result = context.bindSessionTarget(sessionId, payload);
    context.persistSnapshot();
    context.publishSessionChanged("target-bind", result.session);
    return sendHandled(res, 200, result);
  }

  const clearTargetBindingMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/target-binding\/clear$/);
  if (req.method === "POST" && clearTargetBindingMatch) {
    const sessionId = decodeURIComponent(clearTargetBindingMatch[1]);
    const result = context.clearSessionTargetBinding(sessionId);
    context.persistSnapshot();
    context.publishSessionChanged("target-unbind", result.session);
    return sendHandled(res, 200, result);
  }

  const taskTitleMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/task-title$/);
  if (req.method === "POST" && taskTitleMatch) {
    const sessionId = decodeURIComponent(taskTitleMatch[1]);
    const payload = await readJsonBody(req, { allowEmpty: true });
    const result = context.updateSessionTaskTitle(sessionId, payload || {});
    context.persistSnapshot();
    context.publishSessionChanged("task-title", result.session);
    return sendHandled(res, 200, result);
  }

  const reviewMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/reviewed$/);
  if (req.method === "POST" && reviewMatch) {
    const sessionId = decodeURIComponent(reviewMatch[1]);
    const payload = await readJsonBody(req, { allowEmpty: true });
    const result = context.markSessionReviewed(sessionId, payload || {});
    context.persistSnapshot();
    context.publishSessionChanged("reviewed", result.session);
    return sendHandled(res, 200, result);
  }

  const attentionClearMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/attention-cleared$/);
  if (req.method === "POST" && attentionClearMatch) {
    const sessionId = decodeURIComponent(attentionClearMatch[1]);
    const payload = await readJsonBody(req, { allowEmpty: true });
    const result = context.clearSessionAttention(sessionId, payload || {});
    context.persistSnapshot();
    context.publishSessionChanged("attention-cleared", result.session);
    return sendHandled(res, 200, result);
  }

  const dismissMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/dismiss$/);
  if (req.method === "POST" && dismissMatch) {
    const sessionId = decodeURIComponent(dismissMatch[1]);
    const payload = await readJsonBody(req, { allowEmpty: true });
    const result = context.dismissSession(sessionId, payload || {});
    context.persistSnapshot();
    context.publishSessionChanged("dismiss", result.session);
    return sendHandled(res, 200, result);
  }

  const archiveMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/archive$/);
  if (req.method === "POST" && archiveMatch) {
    const sessionId = decodeURIComponent(archiveMatch[1]);
    const payload = await readJsonBody(req, { allowEmpty: true });
    const result = context.archiveSession(sessionId, payload || {});
    context.persistSnapshot();
    context.publishSessionChanged("archive", result.session);
    return sendHandled(res, 200, result);
  }

  const heartbeatMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/heartbeat$/);
  if (req.method === "POST" && heartbeatMatch) {
    const sessionId = decodeURIComponent(heartbeatMatch[1]);
    const payload = await readJsonBody(req, { allowEmpty: true });
    const session = context.updateHeartbeat(sessionId, payload || {});
    context.persistSnapshot();
    context.publishSessionChanged("heartbeat", session);
    return sendHandled(res, 200, { ok: true, session });
  }

  const resumeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/resume$/);

  const managedOfflineMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/managed-launch\/offline$/);
  if (req.method === "POST" && managedOfflineMatch) {
    const sessionId = decodeURIComponent(managedOfflineMatch[1]);
    const payload = await readJsonBody(req, { allowEmpty: true });
    const session = context.launchStore.markSessionOffline(sessionId, context.sessions, payload || {});
    if (!session) {
      const error = new Error(`Session not found for managed launch update: ${sessionId}`);
      error.statusCode = 404;
      error.code = "session_not_found";
      throw error;
    }
    context.persistSnapshot();
    context.publishSessionChanged("managed-launch-offline", session);
    return sendHandled(res, 200, { ok: true, session });
  }

  if (req.method === "POST" && resumeMatch) {
    const sessionId = decodeURIComponent(resumeMatch[1]);
    const payload = await readJsonBody(req, { allowEmpty: true });
    const existing = context.sessions.get(sessionId);
    if (!existing) {
      const error = new Error(`Session not found for resume: ${sessionId}`);
      error.statusCode = 404;
      error.code = "session_not_found";
      throw error;
    }

    const activeResume = context.launchStore.findActiveResume(sessionId);
    if (activeResume) {
      return sendHandled(res, 200, { ok: true, duplicate: true, launch: activeResume, session: existing });
    }

    const rawTool = String(existing.tool || "").toLowerCase();
    const adapterId = rawTool.includes("claude") ? "claude-cli" : rawTool.includes("codex") ? "codex-cli" : null;
    if (!adapterId) {
      const error = new Error(`Session tool cannot be resumed as a managed CLI: ${existing.tool || "unknown"}`);
      error.statusCode = 400;
      error.code = "unsupported_resume_tool";
      throw error;
    }
    const workspacePath = existing.workspacePath || existing.cwd;
    const result = await context.launchWorkspace(
      {
        workspacePath,
        adapterId,
        sessionId,
        sourceCardSessionId: sessionId,
        shellPreference: payload?.shellPreference,
      },
      { launchStore: context.launchStore, recordDebugLog: context.recordDebugLog }
    );
    const now = new Date().toISOString();
    const session = {
      ...existing,
      launchId: result.launch?.launchId || null,
      launchState: result.launch?.state || "waiting_hook",
      launchRevision: (existing.launchRevision || 0) + 1,
      windowHint: result.windowHint || null,
      targetBinding: null,
      lastEvent: "ManagedLaunchResume",
      updatedAt: now,
    };
    context.sessions.set(sessionId, session);
    context.persistSnapshot();
    context.publishSessionChanged("managed-launch-resume", session);
    return sendHandled(res, 200, { ...result, session });
  }

  return false;
}

function sendHandled(res, status, payload) {
  sendJson(res, status, payload);
  return true;
}

module.exports = {
  handleSessionRoutes,
};
