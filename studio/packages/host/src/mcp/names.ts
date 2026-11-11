// AMO MCP tools that write but only touch the caller's own task (or its mail), so they run without asking the person.
// Shared by the tool definitions and the Codex server config (`tools.<name>.approval_mode = "approve"`).
// Mail never enters a conversation by itself (the person forwards it), so sending and reading it need no approval.
// Asking the person a question (decision_request) only puts it in front of them.
// session_start (2026-10-22): the person chose to have a session start another in its own task without asking.
// review_open and view_open (查看包, 2026-10-23) only put something in front of the person.
// session_archive (2026-11-01, 问题 #6): only sessions the caller itself started, so putting them away is as free as starting them.
// session_send (2026-11-01): the same sessions; telling them more is as free as starting them.
// session_rename, task_rename (2026-11-11): a name, on the same sessions and tasks as session_archive and task_describe.
export const AUTO_APPROVED_WRITE_TOOLS = ["task_note_add", "session_rename", "task_rename", "handoff_submit", "mailbox_send", "mailbox_read", "decision_request", "checklist_check", "schedule_propose", "session_start", "session_send", "session_archive", "review_open", "view_open"] as const;

// Writes the person approves first. Codex's default ("auto") lets tools annotated as non-destructive run unasked
// (S5-05: canvas_group_create ran without a prompt), so these are set to "prompt" explicitly.
// mcp_server_save (MCP 设置, 2026-11-04): a server is a command run on this computer — never without the person's yes
// (and so never for DSH, which leaves these out).
export const PROMPTED_WRITE_TOOLS = ["canvas_group_create", "canvas_depend", "canvas_place", "mcp_server_save"] as const;
