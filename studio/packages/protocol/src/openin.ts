import type { Id } from "./entities.js";

// Files outside Studio (stage 12, S12-0): open one in an editor or the file manager, and read one for a quick look.
// Paths are absolute, or relative to a project when `workspaceId` is given.

/** Where a file opens: VS Code (at a line), the file manager with it selected, or its default program. */
export type OpenInApp = "vscode" | "explorer" | "default";

export interface OpenInApps {
  /** VS Code was found on this machine (registry App Paths, its usual install folders, or `code` on PATH). */
  vscode: boolean;
}

export interface OpenInRequest {
  path: string;
  workspaceId?: Id;
  app: OpenInApp;
  /** 1-based; VS Code only. */
  line?: number;
  column?: number;
}

export interface OpenInResult {
  app: OpenInApp;
  /** The absolute path that was opened. */
  path: string;
  /** Test runs record the launch instead of starting a program. */
  dryRun: boolean;
}

/** Largest file a quick look reads. */
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;

/** A file read for a quick look. `text` is absent when the file is binary or too large. */
export interface TextFile {
  /** The absolute path. */
  path: string;
  size: number;
  modifiedAt: string;
  text?: string;
  binary?: boolean;
  tooLarge?: boolean;
}

/** Image types `GET /api/fs/raw` serves (for previews), by lowercase extension. */
export const PREVIEW_IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
