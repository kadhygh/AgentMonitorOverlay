const { readJsonBody, sendJson } = require("../lib/http");
const { requireCardJson } = require("../lib/card-http");
async function handleTaskLaunchRoutes(req, res, url, context) {
  if (req.method === "GET" && url.pathname === "/api/task-launch-context") {
    sendJson(res, 200, await context.taskLauncher.getContext()); return true;
  }
  if (req.method === "POST" && url.pathname === "/api/task-launches") {
    requireCardJson(req);
    sendJson(res, 200, await context.taskLauncher.launch(await readJsonBody(req, { maxBodyBytes: 64 * 1024 }))); return true;
  }
  const match = /^\/api\/task-launches\/(card-[a-f0-9-]+)$/u.exec(url.pathname);
  const retryMatch = /^\/api\/task-launches\/(card-[a-f0-9-]+)\/retry$/u.exec(url.pathname);
  if (req.method === "POST" && retryMatch) {
    requireCardJson(req);
    sendJson(res, 200, await context.taskLauncher.retry(retryMatch[1], await readJsonBody(req, { maxBodyBytes: 16 * 1024 }))); return true;
  }
  if (req.method === "GET" && match) {
    sendJson(res, 200, await context.taskLauncher.receipt(match[1])); return true;
  }
  return false;
}
module.exports = { handleTaskLaunchRoutes };
