import { shell } from "./env.js";
import type { Session } from "./session.js";
import { usagePrompt } from "./shared.js";

// The usage text for agents as a file on this machine (%APPDATA%\AMO Relay\AMO中转用法.md, written by the desktop
// shell): 复制用法 and 复制任务提示词 then copy where it is, not the whole text. Rewritten whenever who I am, the team
// or its flow changes. In a browser, or with a shell from before it could, there is no file and the text is copied.

export async function writeUsageFile(session: Session): Promise<{ file: string; cli: string } | null> {
  if (!shell?.writeUsage) return null;
  const hookup = await shell.mcp().catch(() => null);
  const { members, settings } = session.snapshot;
  const text = usagePrompt({ me: session.me.name, role: session.me.role, members, cli: hookup?.cli, flow: settings.flow });
  try {
    return { file: await shell.writeUsage(text), cli: hookup?.cli ?? "" };
  } catch {
    return null;
  }
}
