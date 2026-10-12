// Schema migrations, applied in order inside one transaction each. Never edit a shipped migration; add a new one.

export const MIGRATIONS: readonly string[] = [
  // 1: initial schema
  `
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workspace', 'area')),
    workspace_id TEXT REFERENCES workspaces(id),
    column_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((scope_kind = 'workspace') = (workspace_id IS NOT NULL))
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    parent_id TEXT REFERENCES sessions(id),
    kind TEXT NOT NULL,
    runtime TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    writer TEXT NOT NULL,
    runtime_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE INDEX sessions_task ON sessions(task_id);
  CREATE UNIQUE INDEX sessions_runtime_ref ON sessions(runtime, runtime_ref) WHERE runtime_ref IS NOT NULL;

  -- Items are never deleted and seq is never reused; a row's body may be replaced (streaming finished, approval answered).
  CREATE TABLE items (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL,
    id TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  );

  -- Global host event log for the WS stream (resume with ?since=seq).
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE annotations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    item_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX annotations_session ON annotations(session_id);

  CREATE TABLE canvas_docs (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  // 2: small key/value settings (scratchpad and other per-install values)
  `
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
];
