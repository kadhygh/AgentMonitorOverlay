const { readJsonBody, sendJson } = require("../lib/http");

async function handleObsidianRoutes(req, res, url, context) {
  if (req.method === "POST" && url.pathname === "/api/events") {
    const payload = await readJsonBody(req);
    const session = context.upsertSessionFromEvent(payload);
    context.persistSnapshot();
    context.publishSessionChanged("event", session);
    return sendHandled(res, 200, { ok: true, session });
  }

  if (req.method === "POST" && url.pathname === "/api/replies") {
    const payload = await readJsonBody(req);
    const reply = context.conversationService.handleReply(payload);
    context.persistSnapshot();
    context.publishSessionChanged("reply", reply.session);
    return sendHandled(res, 200, reply);
  }

  if (req.method === "POST" && url.pathname === "/api/prompts") {
    const payload = await readJsonBody(req);
    const prompt = context.conversationService.handlePrompt(payload);
    context.persistSnapshot();
    context.publishSessionChanged("prompt", prompt.session);
    return sendHandled(res, 200, prompt);
  }

  if (req.method === "POST" && url.pathname === "/api/obsidian/annotations") {
    const payload = await readJsonBody(req);
    const result = context.obsidianBridge.handleObsidianAnnotations(payload);
    context.persistSnapshot();
    context.publishSessionChanged("obsidian-annotations", result.session);
    return sendHandled(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/obsidian/note-title") {
    const payload = await readJsonBody(req);
    const result = context.obsidianBridge.handleObsidianNoteTitle(payload);
    return sendHandled(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/obsidian/register-vault") {
    const payload = await readJsonBody(req);
    return sendHandled(res, 200, context.obsidianBridge.handleRegisterObsidianVault(payload));
  }

  if (req.method === "POST" && url.pathname === "/api/sync-back") {
    const payload = await readJsonBody(req);
    const result = context.obsidianBridge.handleSyncBack(payload);
    context.persistSnapshot();
    context.publishSessionChanged("sync-back", result.session);
    return sendHandled(res, 200, result);
  }

  return false;
}

function sendHandled(res, status, payload) {
  sendJson(res, status, payload);
  return true;
}

module.exports = {
  handleObsidianRoutes,
};
