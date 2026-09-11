const { readJsonBody, sendJson } = require("../lib/http");
const { requireCardJson, decodeCardId } = require("../lib/card-http");
async function handleCardRoutes(req, res, url, context) {
  if (req.method === "POST" && url.pathname === "/api/cards/from-session") {
    requireCardJson(req);
    sendJson(res, 200, { card: await context.cardStore.fromSession(await readJsonBody(req, { maxBodyBytes: 32 * 1024 })) });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/card-groups") {
    sendJson(res, 200, await context.cardStore.listGroups());
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/card-groups/commands") {
    requireCardJson(req);
    sendJson(res, 200, await context.cardStore.executeGroups(await readJsonBody(req, { maxBodyBytes: 32 * 1024 })));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/api/cards") {
    sendJson(res, 200, await context.cardStore.list());
    return true;
  }
  if (req.method === "POST" && url.pathname === "/api/cards") {
    requireCardJson(req);
    sendJson(res, 200, { card: await context.cardStore.create(await readJsonBody(req, { maxBodyBytes: 2 * 1024 * 1024 })) });
    return true;
  }
  const detail = url.pathname.match(/^\/api\/cards\/([^/]+)$/u);
  if (req.method === "GET" && detail) {
    sendJson(res, 200, { card: await context.cardStore.get(decodeCardId(detail[1])) });
    return true;
  }
  const commands = url.pathname.match(/^\/api\/cards\/([^/]+)\/commands$/u);
  if (req.method === "POST" && commands) {
    requireCardJson(req);
    sendJson(res, 200, { card: await context.cardStore.execute(decodeCardId(commands[1]), await readJsonBody(req, { maxBodyBytes: 2 * 1024 * 1024 })) });
    return true;
  }
  return false;
}
module.exports = { handleCardRoutes };
