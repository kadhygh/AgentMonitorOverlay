// 复制引用 (2026-11-23, 中转迭代讨论 — the user: 「可以，按你的建议做」): the line a person copies in Studio or in the AMO 中转
// client and pastes into an AI's conversation, one format on both sides (the 中转 client's: relay-ui, done by 「协作·服务」):
//   Studio 会话「<会话名>」 studio:<设备号>:<会话id>（任务 <taskId>）     Studio's 「更多」 → 复制会话引用
//   任务「<任务名>」 <taskId>                                          Studio's task page → 复制任务编号
//   协作「<标题>」 cowork:<id>                                         the 中转 client's
//   子会话「<标题>」 thread:<id>（协作 cowork:<协作id>）
//   #<seq>（协作「<标题>」 cowork:<id>）
//   中转会话「<标题>」 thread:<id>
// An AI given one passes the prefixed id (or the whole line) to cowork_* / team_session: refId takes the bare id out.

/** A session's reference; `deviceId` is this computer's (its sessions' marks in a 协作 are `studio:<设备号>:<会话id>`). */
export function sessionRefText(name: string, deviceId: string, sessionId: string, taskId: string | null): string {
  return `Studio 会话「${oneLine(name) || "会话"}」 studio:${deviceId}:${sessionId}${taskId ? `（任务 ${taskId}）` : ""}`;
}

/** A task's reference. */
export function taskRefText(title: string, taskId: string): string {
  return `任务「${oneLine(title) || "任务"}」 ${taskId}`;
}

/**
 * The bare id in what an AI was given for a `kind`: `cowork:<id>` / `thread:<id>`, a whole pasted reference (the titles
 * in 「」 are left out, so a title naming 「thread:x」 is not taken), or the bare id itself.
 */
export function refId(value: string, kind: "cowork" | "thread"): string {
  const v = value.trim();
  const m = new RegExp(`(?:^|[\\s（(])${kind}:([A-Za-z0-9_-]+)`).exec(v.replace(/「[^」]*」/g, " "));
  return m ? m[1]! : v;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
