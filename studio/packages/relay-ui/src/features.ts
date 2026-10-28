// The tightening (2026-10-28, plans/relay-tasks.md「收紧」): the relay is about one thing — someone's AI, stuck or
// wanting a teammate's eye on its plan, opens a session; the teammate answers, one round or several, and the AI goes
// on. People talk to each other in chats, they do not open sessions. Team tasks, transfers, 团队流程 / 流程速查 and
// 新会话 stay in the code but are not shown; localStorage amo-relay.full = "1" shows them (the full e2e uses it).

const FULL = "amo-relay.full";

/** Read at render: set it on the login screen and the home screen after it has it. */
export function fullUi(): boolean {
  try {
    return localStorage.getItem(FULL) === "1";
  } catch {
    return false;
  }
}
