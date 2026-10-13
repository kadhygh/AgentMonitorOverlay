// AMO MCP tools that write but only touch the caller's own task (or its mail), so they run without asking the person.
// Shared by the tool definitions and the Codex server config (`tools.<name>.approval_mode = "approve"`).
// Mail never enters a conversation by itself (the person forwards it), so sending and reading it need no approval.
// Asking the person a question (decision_request) only puts it in front of them.
export const AUTO_APPROVED_WRITE_TOOLS = ["task_note_add", "handoff_submit", "mailbox_send", "mailbox_read", "decision_request", "checklist_check", "schedule_propose"] as const;

// Writes the person approves first. Codex's default ("auto") lets tools annotated as non-destructive run unasked
// (S5-05: canvas_group_create ran without a prompt), so these are set to "prompt" explicitly.
export const PROMPTED_WRITE_TOOLS = ["canvas_group_create", "canvas_depend", "canvas_place"] as const;
