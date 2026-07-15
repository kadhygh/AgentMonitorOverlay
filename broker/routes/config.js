const { readJsonBody, sendJson } = require("../lib/http");

async function handleConfigRoutes(req, res, url, context) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendHandled(res, 200, {
      ok: true,
      service: "agent-monitor-broker",
      host: context.host,
      port: context.port,
      startedAt: context.startedAt.toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      sessionCount: context.sessions.size,
      storage: context.dataFile,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/cli-environments") {
    return sendHandled(res, 200, context.detectCliEnvironments());
  }

  if (req.method === "GET" && url.pathname === "/api/debug") {
    return sendHandled(res, 200, context.debugStatus(url.searchParams));
  }

  if (req.method === "POST" && url.pathname === "/api/debug") {
    const payload = await readJsonBody(req);
    return sendHandled(res, 200, context.updateDebugConfig(payload));
  }

  if (req.method === "POST" && url.pathname === "/api/debug/logs") {
    const payload = await readJsonBody(req);
    return sendHandled(res, 200, context.handleDebugLog(payload));
  }

  if (req.method === "POST" && url.pathname === "/api/debug/clear") {
    context.debugLogStore.clear();
    context.recordDebugLog("broker", "debug.clear", {}, { force: true });
    return sendHandled(res, 200, context.debugStatus());
  }

  return false;
}

function sendHandled(res, status, payload) {
  sendJson(res, status, payload);
  return true;
}

module.exports = {
  handleConfigRoutes,
};
