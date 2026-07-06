import type { AgentSession, ObsidianPluginHealth } from "../types";

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
