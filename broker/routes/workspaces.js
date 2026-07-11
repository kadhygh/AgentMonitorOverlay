const { readJsonBody, sendJson } = require("../lib/http");

async function handleWorkspaceRoutes(req, res, url, context) {
  if (req.method === "GET" && url.pathname === "/api/workspaces") {
    const workspaces = context.workspaceRegistry.list();
    return sendHandled(res, 200, { ok: true, count: workspaces.length, workspaces });
  }

  if (req.method === "GET" && url.pathname === "/api/launches") {
    const launches = context.launchStore.list();
    return sendHandled(res, 200, { ok: true, count: launches.length, launches });
  }

  if (req.method === "POST" && url.pathname === "/api/workspaces/inspect") {
    const payload = await readJsonBody(req);
    const inspection = context.inspectWorkspace(payload);
    context.workspaceRegistry.registerInspection(inspection);
    return sendHandled(res, 200, inspection);
  }

  if (req.method === "POST" && url.pathname === "/api/workspaces/enroll") {
    const payload = await readJsonBody(req);
    const enrollment = context.enrollWorkspace(payload, { baseUrl: context.baseUrl, recordDebugLog: context.recordDebugLog });
    context.workspaceRegistry.registerEnrollment(enrollment);
    return sendHandled(res, 200, enrollment);
  }

  if (req.method === "POST" && url.pathname === "/api/workspaces/forget") {
    const payload = await readJsonBody(req);
    const workspaceId = payload?.workspaceId || payload?.workspace_id;
    const workspace = context.workspaceRegistry.forget(workspaceId);
    return sendHandled(res, 200, { ok: true, workspaceId: workspace.workspaceId });
  }

  if (req.method === "POST" && url.pathname === "/api/workspaces/git-exclude") {
    const payload = await readJsonBody(req);
    return sendHandled(res, 200, context.updateWorkspaceGitExclude(payload, { recordDebugLog: context.recordDebugLog }));
  }

  if (req.method === "POST" && url.pathname === "/api/workspaces/launch") {
    const payload = await readJsonBody(req);
    const result = await context.launchWorkspace(payload, {
      sessions: context.sessions,
      launchStore: context.launchStore,
      recordDebugLog: context.recordDebugLog,
    });
    return sendHandled(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/workspaces/status") {
    const payload = await readJsonBody(req);
    return sendHandled(
      res,
      200,
      context.inspectWorkspaceMaintenance(payload, { baseUrl: context.baseUrl, recordDebugLog: context.recordDebugLog })
    );
  }

  if (req.method === "POST" && url.pathname === "/api/workspaces/clean-vault") {
    const payload = await readJsonBody(req);
    const result = context.cleanWorkspaceVault(payload, {
      baseUrl: context.baseUrl,
      sessions: context.sessions,
      publishSessionChanged: context.publishSessionChanged,
      recordDebugLog: context.recordDebugLog,
    });
    context.persistSnapshot();
    return sendHandled(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/workspaces/update-obsidian-plugin") {
    const payload = await readJsonBody(req);
    const result = context.updateWorkspaceObsidianPlugin(payload, {
      baseUrl: context.baseUrl,
      recordDebugLog: context.recordDebugLog,
    });
    context.persistSnapshot();
    context.publishSessionChanged("obsidian-plugin-update", null);
    return sendHandled(res, 200, result);
  }

  return false;
}

function sendHandled(res, status, payload) {
  sendJson(res, status, payload);
  return true;
}

module.exports = {
  handleWorkspaceRoutes,
};
