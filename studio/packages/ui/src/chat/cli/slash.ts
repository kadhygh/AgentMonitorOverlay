import { parseSlashCommand, type SlashCommand, type SlashCommandGroup } from "@amo-studio/protocol";

// The `/` menu of the composer (stage 12, S12-E), after DSH's ui-commands: typing `/` at the start opens it, the name
// typed so far filters it (prefix first, then the name containing it, then the letters in order, then the
// description), and the rows stay grouped: Studio's commands, the runtime's, skills, the person's own.

export const GROUP_ORDER: readonly SlashCommandGroup[] = ["studio", "runtime", "skill", "custom"];

/** The command name being typed: the text starts with "/" and the caret is still inside the name. */
export function slashAt(text: string, caret: number): { query: string; end: number } | null {
  const m = /^\/([^\s/]*)/.exec(text);
  if (!m) return null;
  const end = m[0].length;
  if (caret < 1 || caret > end) return null;
  return { query: m[1]!, end };
}

/** How well a command matches what was typed (lower is better), or null when it does not. */
export function matchScore(command: SlashCommand, query: string): number | null {
  const q = query.toLowerCase();
  if (!q) return 0;
  const names = [command.name, ...(command.aliases ?? [])].map((n) => n.toLowerCase());
  if (names.some((n) => n.startsWith(q))) return names[0]!.startsWith(q) ? 0 : 1;
  if (names.some((n) => n.includes(q))) return 2;
  if (names.some((n) => isSubsequence(q, n))) return 3;
  if (q.length >= 2 && command.description.toLowerCase().includes(q)) return 4;
  return null;
}

function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
}

/** The menu's groups for what was typed: each group's matches, best first, then in the runtime's order. */
export function slashGroups(commands: readonly SlashCommand[], query: string): Array<{ group: SlashCommandGroup; commands: SlashCommand[] }> {
  const scored = commands.flatMap((c, i) => {
    const score = matchScore(c, query);
    return score === null ? [] : [{ c, i, score }];
  });
  return GROUP_ORDER.map((group) => ({
    group,
    commands: scored
      .filter((x) => x.c.group === group)
      .sort((a, b) => a.score - b.score || a.i - b.i)
      .map((x) => x.c),
  })).filter((g) => g.commands.length > 0);
}

/**
 * The command a message runs, when it starts with one the menu knows (by name or alias; Studio's own win). Anything
 * else — `/usr/bin/x`, an unknown name — is an ordinary message.
 */
export function matchSlash(text: string, commands: readonly SlashCommand[]): { command: SlashCommand; args: string } | null {
  const parsed = parseSlashCommand(text);
  if (!parsed) return null;
  const name = parsed.name.toLowerCase();
  const ordered = GROUP_ORDER.flatMap((g) => commands.filter((c) => c.group === g));
  const command = ordered.find((c) => c.name.toLowerCase() === name) ?? ordered.find((c) => c.aliases?.some((a) => a.toLowerCase() === name));
  return command ? { command, args: parsed.args } : null;
}
