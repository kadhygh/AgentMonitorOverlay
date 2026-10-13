import type { Id } from "./entities.js";

// Files named in a conversation (stage 12, S12-C): a reply's inline code and links, tool rows, file chips. The UI only
// turns a name into a link when the file exists, so it asks the Host which of the names do, in batches.

/** Most paths one `POST /api/fs/exists` checks. */
export const MAX_EXISTS_PATHS = 200;

export interface FsExistsRequest {
  /** As written: absolute, `file://…`, or relative to `cwd` (else to the project `workspaceId`). */
  paths: string[];
  workspaceId?: Id;
  /** An absolute folder relative paths start from (a tool call's working directory); default the project folder. */
  cwd?: string;
}

/** A path that exists: where it resolved to, and whether it is a folder. */
export interface ExistingPath {
  path: string;
  dir: boolean;
}

export interface FsExistsResult {
  /** Every asked path, as written: what it resolved to, or null when there is nothing there (or it cannot be told). */
  found: Record<string, ExistingPath | null>;
}
