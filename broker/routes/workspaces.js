const { readJsonBody, sendJson } = require("../lib/http");

async function handleWorkspaceRoutes(req, res, url, context) {
  if (req.method === "POST" && url.pathname === "/api/workspaces/inspect") {
    const payload = await readJsonBody(req);
    return sendHandled(res, 200, context.inspectWorkspace(payload));
  }

  if (req.method === "POST" && url.pathname === "/api/workspaces/enroll") {
    const payload = await readJsonBody(req);
    return sendHandled(res, 200, context.enrollWorkspace(payload, { baseUrl: context.baseUrl, recordDebugLog: context.recordDebugLog }));
  }

  if (req.method === "POST" && url.pathname === "/api/workspaces/git-exclude") {
    const payload = await readJsonBody(req);
    return sendHandled(res, 200, context.updateWorkspaceGitExclude(payload, { recordDebugLog: context.recordDebugLog }));
  }

  if (req.method === "POST" && url.pathname === "/api/workspaces/launch") {
    const payload = await readJsonBody(req);
    const result = await context.launchWorkspace(payload, { sessions: context.sessions, recordDebugLog: context.recordDebugLog });
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
