const { readJsonBody, sendJson } = require("../lib/http");
const { requireCardJson, decodeCardId } = require("../lib/card-http");

async function handleFocusPanelRoutes(req, res, url, context) {
  if (req.method === "GET" && url.pathname === "/api/focus-panel") {
    sendJson(res, 200, await context.cardStore.listFocus());
    return true;
  }
  const match = url.pathname.match(/^\/api\/focus-panel\/cards\/([^/]+)$/u);
  if (req.method === "POST" && match) {
    requireCardJson(req);
    const cardId = decodeCardId(match[1]);
    const payload = await readJsonBody(req, { maxBodyBytes: 32 * 1024 });
    sendJson(res, 200, { card: await context.cardStore.mutateFocus(cardId, payload) });
    return true;
  }
  return false;
}

module.exports = { handleFocusPanelRoutes };
