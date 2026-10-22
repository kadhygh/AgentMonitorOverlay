// AMO MCP tools that write but only touch the caller's own task (or its mail), so they run without asking the person.
// Shared by the tool definitions and the Codex server config (`tools.<name>.approval_mode = "approve"`).
// Mail never enters a conversation by itself (the person forwards it), so sending and reading it need no approval.
// Asking the person a question (decision_request) only puts it in front of them.
// session_start (2026-10-22): the person chose to have a session start another in its own task without asking.
// review_open and view_open (查看包, 2026-10-23) only put something in front of the person.
export const AUTO_APPROVED_WRITE_TOOLS = ["task_note_add", "handoff_submit", "mailbox_send", "mailbox_read", "decision_request", "checklist_check", "schedule_propose", "session_start", "review_open", "view_open"] as const;

// Writes the person approves first. Codex's default ("auto") lets tools annotated as non-destructive run unasked
// (S5-05: canvas_group_create ran without a prompt), so these are set to "prompt" explicitly.
export const PROMPTED_WRITE_TOOLS = ["canvas_group_create", "canvas_depend", "canvas_place"] as const;
