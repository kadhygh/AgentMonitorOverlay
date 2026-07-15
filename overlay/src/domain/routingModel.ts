import type {
  ActivationCandidate,
  AgentSession,
  ObsidianPluginHealth,
  TargetBinding,
  WindowActivationRequest,
} from "../types";

export type ToolDisplayId = "codex-cli" | "codex-app" | "claude-cli" | "other";

export function toolDisplayIdForSession(session: AgentSession): ToolDisplayId {
  const rawTool = String(session.tool || "").toLowerCase();
  const windowText = [
    session.windowHint?.process,
    session.windowHint?.title,
    session.windowHint?.boundLabel,
    session.title,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    rawTool.includes("codex-app") ||
    rawTool.includes("chatgpt") ||
    windowText.includes("codex app") ||
    windowText.includes("chatgpt")
  ) {
    return "codex-app";
  }
  if (rawTool.includes("codex")) {
    return "codex-cli";
  }
  if (rawTool.includes("claude")) {
    return "claude-cli";
  }
  return "other";
}

export function isCodexSession(session: AgentSession) {
  const rawTool = String(session.tool || "").toLowerCase();
  return rawTool.includes("codex") || toolDisplayIdForSession(session).startsWith("codex");
}

export function codexAppThreadUri(threadId: string) {
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

export function codexAppTargetForSession(session: AgentSession): TargetBinding {
  return {
    type: "codex-app-thread",
    label: "ChatGPT",
    threadId: session.sessionId,
    uri: codexAppThreadUri(session.sessionId),
  };
}

export function codexCliTargetForSession(session: AgentSession): TargetBinding {
  return {
    type: "codex-cli-session",
    label: "Codex CLI",
    sessionId: session.sessionId,
    workspacePath: workspacePathForSession(session),
  };
}

export function windowTargetForSession(session: AgentSession): TargetBinding | null {
  const hint = session.windowHint;
  if (!hint || (!hint.hwnd && !hint.pid)) {
    return null;
  }

  return {
    type: "window",
    label: hint.boundLabel ?? hint.title ?? hint.process ?? "Window",
    hwnd: hint.hwnd ?? null,
    processId: hint.pid ?? null,
    processName: hint.process ?? null,
    title: hint.title ?? null,
    boundAt: hint.boundAt ?? null,
    boundBy: hint.boundBy ?? null,
  };
}

export function targetBindingForSession(session: AgentSession): TargetBinding | null {
  return session.targetBinding ?? null;
}

export function activationTargetForSession(session: AgentSession): TargetBinding | null {
  return targetBindingForSession(session) ?? windowTargetForSession(session);
}

export function activationCandidateFromWindowTarget(target: TargetBinding | null): ActivationCandidate | null {
  if (!target || target.type !== "window" || (!target.hwnd && !target.processId)) {
    return null;
  }

  return {
    hwnd: target.hwnd ?? 0,
    processId: target.processId ?? 0,
    processName: target.processName ?? null,
    title: target.title ?? target.label ?? "Window",
    label: target.label ?? target.title ?? target.processName ?? "Window",
  };
}

export function activationCandidateKey(candidate: ActivationCandidate) {
  return `${candidate.hwnd}:${candidate.processId}`;
}

export function targetLabelForSession(session: AgentSession) {
  const target = targetBindingForSession(session);
  if (!target) return "Choose target";
  if (target.type === "codex-app-thread") return "ChatGPT";
  if (target.type === "codex-cli-session") return "Codex CLI";
  return target.label ?? target.title ?? target.processName ?? "Window";
}

export function shouldShowCodexCliResumeOption(
  session: AgentSession,
  candidates: ActivationCandidate[],
  allowWithCandidates: boolean,
) {
  return Boolean(workspacePathForSession(session)) && (allowWithCandidates || candidates.length === 0);
}

export function hasExplicitWindowTarget(target: TargetBinding | null) {
  return Boolean(target?.type === "window" && (target.hwnd || target.processId));
}

export function hasStrongWindowRoutingHint(session: AgentSession) {
  return Boolean(session.windowHint?.titleToken);
}

export function activationWindowRequest(
  session: AgentSession,
  activationTarget: TargetBinding | null,
  options: { includeWindowHintIdentity?: boolean } = {},
): WindowActivationRequest {
  const includeWindowHintIdentity = options.includeWindowHintIdentity !== false;
  const windowTarget = activationTarget?.type === "window" ? activationTarget : null;
  return {
    sessionId: session.sessionId,
    tool: session.tool,
    title: windowTarget?.title ?? session.windowHint?.title ?? session.title,
    processName: windowTarget?.processName ?? session.windowHint?.process ?? "",
    titleToken: session.windowHint?.titleToken ?? "",
    titleContains: session.windowHint?.titleContains ?? [],
    project: session.windowHint?.project ?? projectName(session.cwd),
    cwd: session.windowHint?.cwd ?? session.cwd,
    pid: windowTarget?.processId ?? (includeWindowHintIdentity ? session.windowHint?.pid ?? null : null),
    hwnd: windowTarget?.hwnd ?? (includeWindowHintIdentity ? session.windowHint?.hwnd ?? null : null),
  };
}

export function projectName(cwd: string) {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function joinWindowsPath(root: string | undefined, relativePath: string | undefined) {
  if (!root || !relativePath) {
    return null;
  }

  const normalizedRelative = relativePath.replace(/\//g, "\\").replace(/^\\+/, "");
  return `${root.replace(/[\\/]+$/, "")}\\${normalizedRelative}`;
}

export function notePathForOpen(session: AgentSession) {
  return (
    session.lastReplyNoteAbsolutePath ??
    joinWindowsPath(session.vaultRoot, session.lastReplyNote) ??
    joinWindowsPath(session.workspacePath, session.lastReplyNote)
  );
}

export function canvasPathForOpen(session: AgentSession) {
  return (
    session.canvasAbsolutePath ??
    joinWindowsPath(session.vaultRoot, session.canvasPath) ??
    joinWindowsPath(session.workspacePath, session.canvasPath)
  );
}

export function workspacePathForSession(session: AgentSession) {
  return session.workspacePath ?? session.windowHint?.cwd ?? session.cwd;
}

export function latestCanvasNotePathForFocus(session: AgentSession) {
  const candidates = [
    {
      path:
        session.pendingAnnotationSource?.notePath && session.vaultRoot
          ? joinWindowsPath(session.vaultRoot, session.pendingAnnotationSource.notePath)
          : session.pendingAnnotationSource?.notePath,
      at: session.pendingPromptCreatedAt,
    },
    {
      path:
        session.sentPromptNoteAbsolutePath ??
        joinWindowsPath(session.vaultRoot, session.sentPromptNote ?? undefined) ??
        joinWindowsPath(session.workspacePath, session.sentPromptNote ?? undefined),
      at: session.sentPromptRecordedAt,
    },
    {
      path:
        session.lastPromptNoteAbsolutePath ??
        joinWindowsPath(session.vaultRoot, session.lastPromptNote) ??
        joinWindowsPath(session.workspacePath, session.lastPromptNote),
      at: session.lastPromptAt,
    },
    {
      path: notePathForOpen(session),
      at: session.lastReplyAt,
    },
  ].filter((candidate): candidate is { path: string; at: string | null | undefined } => Boolean(candidate.path));

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort((a, b) => timestampValue(b.at) - timestampValue(a.at))[0].path;
}

function timestampValue(value?: string | null) {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function obsidianOpenUri(targetPath: string, vaultId?: string, vaultRoot?: string) {
  const params: Record<string, string> = {};
  const filePath = vaultRelativeFilePath(targetPath, vaultRoot);

  if (vaultId && filePath) {
    params.vault = vaultId;
    params.file = filePath;
  } else {
    params.path = targetPath;
  }

  params.paneType = "tab";
  return `obsidian://open?${uriQuery(params)}`;
}

export function obsidianAmoOpenUri(
  targetPath: string,
  target: "note" | "canvas",
  vaultId?: string,
  vaultRoot?: string,
  options?: { focusNotePath?: string | null },
) {
  const filePath = vaultRelativeFilePath(targetPath, vaultRoot);
  if (!filePath) {
    return obsidianOpenUri(targetPath, vaultId, vaultRoot);
  }

  const params: Record<string, string> = {
    path: targetPath,
    relativePath: filePath,
    kind: target,
  };
  if (options?.focusNotePath) {
    const focusNotePath = vaultRelativeFilePath(options.focusNotePath, vaultRoot) ?? options.focusNotePath;
    params.focusNotePath = focusNotePath;
  }
  return `obsidian://amo-open?${uriQuery(params)}`;
}

function uriQuery(params: Record<string, string>) {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

export function vaultRelativeFilePath(targetPath: string, vaultRoot: string | undefined) {
  if (!vaultRoot) {
    return null;
  }

  const normalizedRoot = normalizeWindowsPath(vaultRoot).replace(/\\+$/, "");
  const normalizedTarget = normalizeWindowsPath(targetPath);
  const rootPrefix = `${normalizedRoot}\\`;

  if (
    normalizedTarget.toLowerCase() !== normalizedRoot.toLowerCase() &&
    !normalizedTarget.toLowerCase().startsWith(rootPrefix.toLowerCase())
  ) {
    return null;
  }

  return normalizedTarget.slice(rootPrefix.length).replace(/\\/g, "/");
}

function normalizeWindowsPath(value: string) {
  return value.replace(/\//g, "\\");
}

export function shortPathLabel(value: string | undefined) {
  if (!value) {
    return "";
  }

  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/");
}

export function pluginHealthTitle(health: ObsidianPluginHealth) {
  const lines = [
    `${health.pluginId}: ${health.status}`,
    health.installedVersion ? `version ${health.installedVersion}` : "version missing",
    health.expectedVersion ? `expected ${health.expectedVersion}` : "",
    health.dataBridgeUrl ? `bridge ${health.dataBridgeUrl}` : "",
  ].filter(Boolean);

  if (health.issues && health.issues.length > 0) {
    lines.push(...health.issues);
  }

  return lines.join("\n");
}
