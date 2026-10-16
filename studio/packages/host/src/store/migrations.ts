// Schema migrations, applied in order inside one transaction each. Never edit a shipped migration; add a new one.
// A migration that rebuilds tables other tables point at runs with foreign keys off (checked again afterwards).

export type Migration = string | { sql: string; foreignKeysOff: true };

export const MIGRATIONS: readonly Migration[] = [
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
  // 3: collaboration (stage 5): task notes and handoffs, mail between sessions, decision requests
  `
  CREATE TABLE task_notes (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX task_notes_task ON task_notes(task_id, created_at);

  CREATE TABLE mail (
    id TEXT PRIMARY KEY,
    to_session TEXT,
    to_task TEXT,
    state TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX mail_to_session ON mail(to_session, created_at);
  CREATE INDEX mail_to_task ON mail(to_task, created_at);

  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    state TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX decisions_state ON decisions(state, created_at);
  `,
  // 4: task checklists from extension pack templates (stage 6)
  `
  CREATE TABLE checklist_items (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    position INTEGER NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX checklist_task ON checklist_items(task_id, position);
  `,
  // 5: scheduler proposals (stage 7)
  `
  CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    todo_id TEXT NOT NULL,
    state TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX proposals_state ON proposals(state, created_at);
  `,
  // 6: per-session model, reasoning effort and permissions (stage 9), as JSON
  `
  ALTER TABLE sessions ADD COLUMN options TEXT NOT NULL DEFAULT '{}';
  `,
  // 7: structure v2 (design/structure.md): topics, the common space as a built-in workspace, tasks with exactly one
  // workspace and at most one topic, sessions owned by a task or a topic. Tasks from the old cross-workspace area keep
  // a NULL workspace here; the Host resolves them at start-up, where it knows the common space's folder.
  {
    foreignKeysOff: true,
    sql: `
  ALTER TABLE workspaces ADD COLUMN builtin TEXT;

  CREATE TABLE topics (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    workspace_ids TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );

  CREATE TABLE tasks_v7 (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    workspace_id TEXT REFERENCES workspaces(id),
    topic_id TEXT REFERENCES topics(id),
    column_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );
  INSERT INTO tasks_v7 (id, title, workspace_id, topic_id, column_name, created_at, updated_at, archived_at)
    SELECT id, title, workspace_id, NULL, column_name, created_at, updated_at, NULL FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_v7 RENAME TO tasks;
  CREATE INDEX tasks_topic ON tasks(topic_id);

  CREATE TABLE sessions_v7 (
    id TEXT PRIMARY KEY,
    task_id TEXT REFERENCES tasks(id),
    topic_id TEXT REFERENCES topics(id),
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
    archived_at TEXT,
    options TEXT NOT NULL DEFAULT '{}',
    CHECK ((task_id IS NULL) <> (topic_id IS NULL))
  );
  INSERT INTO sessions_v7 (id, task_id, topic_id, parent_id, kind, runtime, profile_id, workspace_id, title, status, writer, runtime_ref, created_at, updated_at, archived_at, options)
    SELECT id, task_id, NULL, parent_id, kind, runtime, profile_id, workspace_id, title, status, writer, runtime_ref, created_at, updated_at, archived_at, options FROM sessions;
  DROP TABLE sessions;
  ALTER TABLE sessions_v7 RENAME TO sessions;
  CREATE INDEX sessions_task ON sessions(task_id);
  CREATE INDEX sessions_topic ON sessions(topic_id);
  CREATE UNIQUE INDEX sessions_runtime_ref ON sessions(runtime, runtime_ref) WHERE runtime_ref IS NOT NULL;

  CREATE TABLE decisions_v7 (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    task_id TEXT REFERENCES tasks(id),
    state TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  INSERT INTO decisions_v7 (id, session_id, task_id, state, body, created_at) SELECT id, session_id, task_id, state, body, created_at FROM decisions;
  DROP TABLE decisions;
  ALTER TABLE decisions_v7 RENAME TO decisions;
  CREATE INDEX decisions_state ON decisions(state, created_at);

  ALTER TABLE mail ADD COLUMN to_topic TEXT;
  CREATE INDEX mail_to_topic ON mail(to_topic, created_at);
  `,
  },
  // 8: Git Review line comments (stage 11, S11-D), per project; the comment itself is the JSON body.
  `
  CREATE TABLE review_comments (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    path TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX review_comments_workspace ON review_comments(workspace_id, created_at);
  `,
  // 9: file marks (stage 12, S12-D): a marked file or folder with a note; workspace_id NULL for 其他 (outside every
  // project). The mark itself is the JSON body.
  `
  CREATE TABLE file_marks (
    id TEXT PRIMARY KEY,
    workspace_id TEXT REFERENCES workspaces(id),
    path TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX file_marks_workspace ON file_marks(workspace_id, position);
  `,
  // 10: archived projects (2026-10-14): hidden from every list until restored; permanent deletion only once archived.
  `
  ALTER TABLE workspaces ADD COLUMN archived_at TEXT;
  `,
  // 11: a project's own note (2026-10-14): what it is, for the person and for agents (project_context).
  `
  ALTER TABLE workspaces ADD COLUMN description TEXT;
  `,
  // 12: a topic's own note (2026-10-15), like a project's: what it is about, for the person and for agents.
  `
  ALTER TABLE topics ADD COLUMN description TEXT;
  `,
  // 13: what wakes a Claude session by itself (2026-10-16, stage 15): its /loop and a usage limit. JSON, NULL = nothing.
  `
  ALTER TABLE sessions ADD COLUMN wake TEXT;
  `,
  // 14: a task's own description (2026-10-17, stage 16): on its canvas card and task page; NULL = none.
  `
  ALTER TABLE tasks ADD COLUMN description TEXT;
  `,
  // 15: 主控 (stage 16): the task the person marks as coordinating its topic; and the topics' own documents.
  `
  ALTER TABLE tasks ADD COLUMN lead INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE topic_docs (
    id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    body TEXT NOT NULL
  );
  CREATE INDEX topic_docs_topic ON topic_docs(topic_id, created_at);
  `,
];
