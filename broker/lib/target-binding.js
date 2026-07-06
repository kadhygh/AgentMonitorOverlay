const path = require("path");
const { httpError } = require("./http");
const { normalizeInteger, normalizeText, normalizeTextArray } = require("./normalize");

function clearWindowIdentity(currentHint, existing) {
  const resetHint =
    currentHint.boundBy === "overlay-candidate-menu" || currentHint.boundBy === "overlay-target-menu"
      ? {
          titleToken: currentHint.titleToken || null,
          titleContains: Array.isArray(currentHint.titleContains) ? currentHint.titleContains : [],
          project: currentHint.project || path.basename(existing.cwd || "") || null,
          cwd: currentHint.cwd || existing.cwd || null,
          tool: currentHint.tool || existing.tool || null,
          pid: null,
          hwnd: null,
        }
      : {
          ...currentHint,
          pid: null,
          hwnd: null,
        };
  return normalizeWindowHint(resetHint);
}

function codexAppThreadUri(threadId) {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

function resolveSessionTargetBinding({ payload, existing, sessionId, tool, cwd, boundAt, windowHint }) {
  const explicitTarget = normalizeTargetBinding(payload?.targetBinding || payload?.target_binding, sessionId, boundAt);
  if (explicitTarget) {
    return explicitTarget;
  }

  if (existing?.targetBinding) {
    return existing.targetBinding;
  }

  const windowTarget = targetBindingFromWindowHint(windowHint, boundAt);
  if (windowTarget) {
    return windowTarget;
  }

  return defaultHookTargetBinding({ payload, sessionId, tool, cwd, boundAt });
}

function defaultHookTargetBinding({ payload, sessionId, tool, cwd, boundAt }) {
  if (!sessionId || !isHookPayload(payload)) {
    return null;
  }

  const normalizedTool = (normalizeText(tool) || "").toLowerCase();
  if (normalizedTool.includes("codex")) {
    return normalizeTargetBinding(
      {
        type: "codex-cli-session",
        label: "Codex CLI",
        sessionId,
        workspacePath: normalizeText(payload.workspacePath || payload.workspace_path || payload.cwd) || cwd || null,
        boundAt,
        boundBy: "hook-default-target",
      },
      sessionId,
      boundAt
    );
  }

  return null;
}

function isHookPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const source = (normalizeText(payload.source) || "").toLowerCase();
  if (source.includes("hook")) {
    return true;
  }

  const hookEventName = (normalizeText(payload.hookEventName || payload.hook_event_name) || "").toLowerCase();
  return [
    "stop",
    "userpromptsubmit",
    "permissionrequest",
    "pretooluse",
    "posttooluse",
    "posttoolusefailure",
    "notification",
  ].includes(hookEventName);
}

function normalizeTargetBinding(value, sessionId, boundAt) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const rawType = normalizeText(value.type || value.targetType || value.target_type);
  if (!rawType) {
    return null;
  }

  const type = rawType.toLowerCase().replace(/[\s_]+/g, "-");
  const now = boundAt || normalizeText(value.boundAt || value.bound_at) || new Date().toISOString();

  if (type === "codex-app" || type === "codex-app-thread") {
    const threadId = normalizeText(value.threadId || value.thread_id || value.sessionId || value.session_id) || sessionId;
    if (!threadId) {
      return null;
    }

    const uri = normalizeText(value.uri) || codexAppThreadUri(threadId);
    if (!uri.startsWith("codex://threads/")) {
      throw httpError(400, "invalid_codex_app_uri", "Codex App target URI must start with codex://threads/");
    }

    return {
      type: "codex-app-thread",
      label: normalizeText(value.label) || "Codex App",
      threadId,
      uri,
      boundAt: now,
      boundBy: normalizeText(value.boundBy || value.bound_by) || "overlay-target-menu",
    };
  }

  if (type === "codex-cli" || type === "codex-cli-session") {
    const targetSessionId = normalizeText(value.sessionId || value.session_id || value.threadId || value.thread_id) || sessionId;
    if (!targetSessionId) {
      return null;
    }

    return {
      type: "codex-cli-session",
      label: normalizeText(value.label) || "Codex CLI",
      sessionId: targetSessionId,
      workspacePath: normalizeText(value.workspacePath || value.workspace_path || value.cwd) || null,
      boundAt: now,
      boundBy: normalizeText(value.boundBy || value.bound_by) || "overlay-target-menu",
    };
  }

  if (type === "window" || type === "cli-window") {
    const hwnd = normalizeInteger(value.hwnd || value.hWnd || value.windowHandle || value.window_handle);
    const processId = normalizeInteger(value.processId || value.process_id || value.pid);
    if (hwnd === null && processId === null) {
      throw httpError(400, "missing_window_identity", "Window target must include hwnd or processId");
    }

    const processName = normalizeText(value.processName || value.process_name || value.process);
    const title = normalizeText(value.title || value.windowTitle || value.window_title);
    const label = normalizeText(value.label) || title || processName || "Window";
    return {
      type: "window",
      label,
      hwnd,
      processId,
      processName: processName || null,
      title: title || null,
      boundAt: now,
      boundBy: normalizeText(value.boundBy || value.bound_by) || "overlay-target-menu",
    };
  }

  throw httpError(400, "unsupported_target_type", `Target type '${rawType}' is not supported`);
}

function targetBindingFromWindowHint(windowHint, boundAt) {
  if (!windowHint || (windowHint.hwnd === null && windowHint.pid === null)) {
    return null;
  }

  return {
    type: "window",
    label: windowHint.boundLabel || windowHint.title || windowHint.process || "Window",
    hwnd: windowHint.hwnd ?? null,
    processId: windowHint.pid ?? null,
    processName: windowHint.process || null,
    title: windowHint.title || null,
    boundAt: boundAt || windowHint.boundAt || new Date().toISOString(),
    boundBy: windowHint.boundBy || "overlay-candidate-menu",
  };
}

function windowHintFromWindowTarget(existing, targetBinding) {
  const baseHint = existing.windowHint || {};
  return {
    process: targetBinding.processName || baseHint.process || null,
    title: targetBinding.title || baseHint.title || existing.title || null,
    titleToken: baseHint.titleToken || null,
    titleContains: Array.isArray(baseHint.titleContains) ? baseHint.titleContains : [],
    project: baseHint.project || path.basename(existing.cwd || "") || null,
    cwd: baseHint.cwd || existing.cwd || null,
    tool: baseHint.tool || existing.tool || null,
    pid: targetBinding.processId ?? null,
    hwnd: targetBinding.hwnd ?? null,
    boundAt: targetBinding.boundAt || new Date().toISOString(),
    boundBy: targetBinding.boundBy || "overlay-target-menu",
    boundLabel: targetBinding.label || targetBinding.title || targetBinding.processName || null,
  };
}

function normalizeWindowHint(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const processName = normalizeText(value.process || value.processName || value.process_name);
  const title = normalizeText(value.title || value.windowTitle || value.window_title);
  const titleToken = normalizeText(value.titleToken || value.title_token);
  const project = normalizeText(value.project);
  const cwd = normalizeText(value.cwd);
  const tool = normalizeText(value.tool);
  const titleContains = normalizeTextArray(
    value.titleContains || value.title_contains || value.titleIncludes || value.title_includes
  );
  const pid = normalizeInteger(value.pid || value.processId || value.process_id);
  const hwnd = normalizeInteger(value.hwnd || value.hWnd || value.windowHandle || value.window_handle);
  const boundAt = normalizeText(value.boundAt || value.bound_at);
  const boundBy = normalizeText(value.boundBy || value.bound_by);
  const boundLabel = normalizeText(value.boundLabel || value.bound_label || value.label);

  if (
    !processName &&
    !title &&
    !titleToken &&
    titleContains.length === 0 &&
    !project &&
    !cwd &&
    !tool &&
    pid === null &&
    hwnd === null &&
    !boundAt &&
    !boundBy &&
    !boundLabel
  ) {
    return null;
  }

  return {
    process: processName || null,
    title: title || null,
    titleToken: titleToken || null,
    titleContains,
    project: project || null,
    cwd: cwd || null,
    tool: tool || null,
    pid,
    hwnd,
    boundAt: boundAt || null,
    boundBy: boundBy || null,
    boundLabel: boundLabel || null,
  };
}

module.exports = {
  clearWindowIdentity,
  codexAppThreadUri,
  defaultHookTargetBinding,
  isHookPayload,
  normalizeTargetBinding,
  normalizeWindowHint,
  resolveSessionTargetBinding,
  targetBindingFromWindowHint,
  windowHintFromWindowTarget,
};
