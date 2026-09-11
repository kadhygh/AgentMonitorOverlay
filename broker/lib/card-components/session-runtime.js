const { canonicalFrameworkId } = require("../session-frameworks");
const { text } = require("../session-frameworks/common");

function matchingSession(session, sessionRef) {
  return session && session.sessionId === sessionRef.sessionId
    && canonicalFrameworkId(session.tool) === sessionRef.frameworkId ? session : null;
}

function workspacePath(session) {
  return text(session?.workspacePath || session?.windowHint?.cwd || session?.cwd, 8192);
}

function projectSessionRuntime(session, sessionRef, componentId) {
  const runtime = matchingSession(session, sessionRef);
  return {
    componentId,
    sessionRef: { frameworkId: sessionRef.frameworkId, sessionId: sessionRef.sessionId },
    presence: !runtime ? "detached" : runtime.archivedAt ? "archived" : "live",
    execution: text(runtime?.state, 100) || "unknown",
    workspaceId: text(runtime?.workspaceId) || null,
    workspacePath: workspacePath(runtime),
  };
}

function hasWindowIdentity(target) {
  return [target?.hwnd, target?.pid, target?.processId]
    .some((value) => Number.isSafeInteger(value) && value > 0);
}

function inheritedOwnerRoute(session) {
  return session.launchRelation === "attached-child" || session.launchRelation === "foreign-leak"
    || Boolean(session.routeOwnerSessionId && session.routeOwnerSessionId !== session.sessionId);
}

function projectConversationRuntime(session, sessionRef, componentId, sessionComponentId) {
  const runtime = matchingSession(session, sessionRef);
  const result = {
    componentId,
    sessionComponentId,
    surface: "unbound",
    bindingKind: "unbound",
    availability: "unknown",
    capabilities: { activate: false, resume: false },
  };
  if (!runtime) return result;

  const framework = canonicalFrameworkId(runtime.tool);
  const supported = framework !== "unknown";
  const commandsAllowed = supported && !runtime.archivedAt;
  const appTool = text(runtime.tool).trim().toLowerCase() === "codex-app";
  const target = runtime.targetBinding;
  const hint = runtime.windowHint;
  const sharedOwnerRoute = inheritedOwnerRoute(runtime);
  const explicitTarget = target && target.boundBy !== "managed-launch" ? target : null;

  // Explicit App routing owns this conversation even if stale CLI launch data remains.
  // Session activity and a CLI launch are not evidence that the App window is online.
  if (explicitTarget?.type === "codex-app-thread") {
    result.surface = "app";
    result.bindingKind = "codex-app-thread";
    result.capabilities.activate = commandsAllowed && framework === "codex"
      && Boolean(text(explicitTarget.threadId));
    return result;
  }

  if (appTool) {
    result.surface = "app";
    if (explicitTarget?.type === "window") {
      result.bindingKind = "window";
      result.capabilities.activate = commandsAllowed && hasWindowIdentity(explicitTarget);
    }
    return result;
  }

  result.capabilities.resume = commandsAllowed && Boolean(workspacePath(runtime));
  if (explicitTarget?.type === "window") {
    result.surface = "cli";
    result.bindingKind = "window";
    result.capabilities.activate = commandsAllowed && hasWindowIdentity(explicitTarget);
    return result;
  }

  if (explicitTarget?.type === "codex-cli-session") {
    result.surface = "cli";
    result.bindingKind = "codex-cli-session";
    // Never turn an inconsistent binding into a command against another Session.
    if (framework !== "codex" || explicitTarget.sessionId !== runtime.sessionId) {
      result.capabilities = { activate: false, resume: false };
      return result;
    }
  } else if (explicitTarget) {
    // Unknown bindings are retained as descriptive data, never executable routes.
    result.bindingKind = text(explicitTarget.type, 100) || "unbound";
    result.capabilities = { activate: false, resume: false };
    return result;
  }

  const managed = !sharedOwnerRoute && Boolean(runtime.launchId
    || hint?.boundBy === "managed-launch" || target?.boundBy === "managed-launch");
  if (managed) {
    result.surface = "cli";
    if (!explicitTarget) result.bindingKind = "managed-launch";
    const identity = hasWindowIdentity(hint) || hasWindowIdentity(target);
    const terminal = runtime.launchState === "offline" || runtime.launchState === "failed";
    result.availability = terminal ? "offline"
      : runtime.launchState === "connected" && identity ? "online" : "unknown";
    result.capabilities.activate = commandsAllowed && !terminal
      && (identity || Boolean(text(hint?.titleToken)));
    return result;
  }

  if (!sharedOwnerRoute && hasWindowIdentity(hint)) {
    result.surface = "cli";
    if (!explicitTarget) result.bindingKind = "window";
    result.capabilities.activate = commandsAllowed;
    return result;
  }

  // The existing Codex CLI handler supports choosing a target with no current binding.
  // This capability permits the chooser, not a claim that any window is online.
  result.capabilities.activate = commandsAllowed && framework === "codex" && !sharedOwnerRoute;
  return result;
}

module.exports = { projectSessionRuntime, projectConversationRuntime };
