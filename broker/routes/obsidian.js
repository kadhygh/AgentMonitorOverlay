const { readJsonBody, sendJson } = require("../lib/http");

async function handleObsidianRoutes(req, res, url, context) {
  if (req.method === "POST" && url.pathname === "/api/events") {
    const payload = await readJsonBody(req);
    const claim = context.launchStore.claim(payload, { sessions: context.sessions });
    if (claim?.kind === "pending-owner" || claim?.kind === "foreign") {
      return sendHandled(res, 202, { ok: true, ignored: true, reason: claim.reason || "waiting_owner_session_start", launch: claim.launch });
    }
    publishReleasedSession(context, claim);
    const result = context.permissionGate.handleEvent(payload);
    context.transcriptMonitor.track(payload, result.session);
    if (result.provisional) {
      return sendHandled(res, 200, { ok: true, provisional: true, launch: claim?.launch || null, session: result.session });
    }
    const session = result.session;
    context.scheduleSnapshotPersist("event");
    context.publishSessionChanged("event", session);
    return sendHandled(res, 200, { ok: true, launch: claim?.launch || null, session });
  }

  if (req.method === "POST" && url.pathname === "/api/replies") {
    const payload = await readJsonBody(req);
    const claim = context.launchStore.claim(payload, { sessions: context.sessions });
    if (claim?.kind === "pending-owner" || claim?.kind === "foreign") {
      return sendHandled(res, 202, { ok: true, ignored: true, reason: claim.reason || "waiting_owner_session_start", launch: claim.launch });
    }
    publishReleasedSession(context, claim);
    const reply = context.conversationService.handleReply(payload);
    context.transcriptMonitor.track(payload, reply.session);
    context.scheduleSnapshotPersist("reply");
    context.publishSessionChanged("reply", reply.session);
    return sendHandled(res, 200, reply);
  }

  if (req.method === "POST" && url.pathname === "/api/prompts") {
    const payload = await readJsonBody(req);
    const claim = context.launchStore.claim(payload, { sessions: context.sessions });
    if (claim?.kind === "pending-owner" || claim?.kind === "foreign") {
      return sendHandled(res, 202, { ok: true, ignored: true, reason: claim.reason || "waiting_owner_session_start", launch: claim.launch });
    }
    publishReleasedSession(context, claim);
    const prompt = context.conversationService.handlePrompt(payload);
    context.transcriptMonitor.track(payload, prompt.session);
    context.scheduleSnapshotPersist("prompt");
    context.publishSessionChanged("prompt", prompt.session);
    return sendHandled(res, 200, prompt);
  }

  if (req.method === "POST" && url.pathname === "/api/obsidian/annotations") {
    const payload = await readJsonBody(req);
    const result = context.obsidianBridge.handleObsidianAnnotations(payload);
    await context.persistSnapshot("obsidian-annotations");
    context.publishSessionChanged("obsidian-annotations", result.session);
    return sendHandled(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/obsidian/return") {
    const payload = await readJsonBody(req);
    const result = context.obsidianBridge.handleObsidianReturn(payload);
    await context.persistSnapshot("obsidian-return");
    context.publishSessionChanged("obsidian-return", result.session);
    return sendHandled(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/obsidian/note-title") {
    const payload = await readJsonBody(req);
    const result = context.obsidianBridge.handleObsidianNoteTitle(payload);
    return sendHandled(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/obsidian/register-vault") {
    const payload = await readJsonBody(req);
    const result = await context.obsidianBridge.handleRegisterObsidianVault(payload);
    context.invalidateObsidianHealth(result.vaultRoot);
    const pluginRuntime = context.obsidianRuntimeStore.getRuntime({
      vaultId: result.vaultId,
      vaultRoot: result.vaultRoot,
    });
    return sendHandled(res, 200, { ...result, pluginRuntime });
  }

  if (req.method === "POST" && url.pathname === "/api/obsidian/runtime") {
    const payload = await readJsonBody(req);
    const runtime = context.obsidianRuntimeStore.heartbeat(payload);
    return sendHandled(res, 200, runtime);
  }

  if (req.method === "GET" && url.pathname === "/api/obsidian/runtime") {
    const runtime = context.obsidianRuntimeStore.getRuntime({
      vaultId: url.searchParams.get("vaultId"),
      vaultRoot: url.searchParams.get("vaultRoot"),
    });
    return sendHandled(res, 200, { ok: true, active: Boolean(runtime?.active), runtime });
  }

  if (req.method === "POST" && url.pathname === "/api/obsidian/open-results") {
    const payload = await readJsonBody(req);
    const result = context.obsidianRuntimeStore.recordOpenResult(payload);
    return sendHandled(res, 200, result);
  }

  const openResultMatch = url.pathname.match(/^\/api\/obsidian\/open-results\/([^/]+)$/);
  if (req.method === "GET" && openResultMatch) {
    const openRequestId = decodeURIComponent(openResultMatch[1]);
    const result = context.obsidianRuntimeStore.getOpenResult(openRequestId);
    return sendHandled(res, 200, result || { ok: true, pending: true, openRequestId });
  }

  if (req.method === "POST" && url.pathname === "/api/sync-back") {
    const payload = await readJsonBody(req);
    const result = context.obsidianBridge.handleSyncBack(payload);
    await context.persistSnapshot("sync-back");
    context.publishSessionChanged("sync-back", result.session);
    return sendHandled(res, 200, result);
  }

  return false;
}

function publishReleasedSession(context, claim) {
  if (!claim?.releasedSession) return;
  context.scheduleSnapshotPersist("managed-launch-released");
  context.publishSessionChanged("managed-launch-released", claim.releasedSession);
}

function sendHandled(res, status, payload) {
  sendJson(res, status, payload);
  return true;
}

module.exports = {
  handleObsidianRoutes,
};
