// AMO MCP tools that write but only touch the caller's own task (or its mail), so they run without asking the person.
// Shared by the tool definitions and the Codex server config (`tools.<name>.approval_mode = "approve"`).
// Mail never enters a conversation by itself (the person forwards it), so sending and reading it need no approval.
// Asking the person a question (decision_request) only puts it in front of them.
export const AUTO_APPROVED_WRITE_TOOLS = ["task_note_add", "handoff_submit", "mailbox_send", "mailbox_read", "decision_request"] as const;
