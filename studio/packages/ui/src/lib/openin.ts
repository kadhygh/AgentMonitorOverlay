import type { Id, OpenInApp, OpenInApps, OpenInResult, TextFile } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";

// Files outside Studio (stage 12): open one in VS Code or Explorer, read one for a quick look. Paths are absolute, or
// relative to the project given as `workspaceId`.

export interface FileRef {
  path: string;
  workspaceId?: Id;
}

let apps: Promise<OpenInApps> | null = null;

/** Which editors this machine has (asked once per window). */
export function openInApps(link: HostLink): Promise<OpenInApps> {
  apps ??= call(link, "GET /api/open-in/apps").catch((err: unknown) => {
    apps = null;
    throw err;
  });
  return apps;
}

export function openIn(link: HostLink, file: FileRef, app: OpenInApp, line?: number, column?: number): Promise<OpenInResult> {
  return call(link, "POST /api/open-in", {}, { path: file.path, app, ...(file.workspaceId ? { workspaceId: file.workspaceId } : {}), ...(line ? { line } : {}), ...(column ? { column } : {}) });
}

/** VS Code at a line (1-based) when given. */
export const openInEditor = (link: HostLink, file: FileRef, line?: number, column?: number) => openIn(link, file, "vscode", line, column);
/** Explorer with the file selected (a folder opens). */
export const revealInExplorer = (link: HostLink, file: FileRef) => openIn(link, file, "explorer");

export function readTextFile(link: HostLink, file: FileRef): Promise<TextFile> {
  return call(link, "GET /api/fs/text", {}, undefined, { path: file.path, ...(file.workspaceId ? { workspaceId: file.workspaceId } : {}) });
}

/** A URL an <img> can load for an image file (the token rides in the query; the Host only serves image types). */
export function rawFileUrl(link: HostLink, file: FileRef): string {
  const q = new URLSearchParams({ path: file.path, token: link.token, ...(file.workspaceId ? { workspaceId: file.workspaceId } : {}) });
  return `${link.url}/api/fs/raw?${q.toString()}`;
}
