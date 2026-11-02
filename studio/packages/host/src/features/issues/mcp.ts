import { z } from "zod";
import { ISSUE_STATUSES } from "@amo-studio/relay/light";
import { fail, json, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";
import { HostError } from "../../core/shared.js";

/**
 * The AMO MCP tools of 问题页 (gathered in mcp/tools.ts): read the issues the person reported on the team server and
 * answer them as the person, marked as the AI's. All run without asking: the issues are the person's own, and how to
 * work them is said by the prompt template the person's 值守 item names (2026-10-31).
 */
export function issuesTools({ service, caller }: ToolContext): AmoTool[] {
  const t = service.issues;
  const run = async (fn: () => Promise<unknown>) => {
    try {
      return json(await fn());
    } catch (err) {
      if (err instanceof HostError) return fail(err.message);
      throw err;
    }
  };
  const status = z.enum(ISSUE_STATUSES);
  return [
    {
      name: "issue_list",
      title: "问题列表",
      description:
        "The issues the person reported on the team server's 问题页 (AMO's own problems): open ones by default (new, working, asking, fixed, stuck, discuss), all with all=true; newest change first. awaitsAi: the person wrote last, read it — except on discuss (去会话讨论), which the person took to a session: leave those alone. review (待审核) and rejected (打回) wait for a maintainer to let them through (someone else reported them): not listed by default; leave them alone too. release.requestedAt: the person clicked 发布打包 (a test build is wanted).",
      inputSchema: { all: z.boolean().optional() },
      readOnly: true,
      autoApprove: true,
      run: (args) => run(() => t.list(args.all === true)),
    },
    {
      name: "issue_get",
      title: "读问题",
      description: "One issue (#number) with its whole conversation. Each screenshot comes with path: a file on this computer you can open to look at it.",
      inputSchema: { number: z.number().int() },
      readOnly: true,
      autoApprove: true,
      run: (args) => run(() => t.get(args.number as number)),
    },
    {
      name: "issue_reply",
      title: "回复问题",
      description:
        "Write on an issue as the person's AI: body (Markdown — what you found, what you changed, what to try, or a question), images (full local paths of screenshots, at most 8), and status to change it with the same entry (asking 需要确认 when you need the person's word — you do not understand it, or it is big: say how you would go and what it touches, and you talk it over here round after round; fixed when merged into master; stuck when you cannot go on). discuss (去会话讨论) is set by the person only: they took it to a session; leave such issues alone. Your session id is kept on the issue.",
      inputSchema: { number: z.number().int(), body: z.string().optional(), status: status.optional(), images: z.array(z.string()).optional() },
      readOnly: false,
      autoApprove: true,
      // Who wrote is kept (2026-10-31): the person's answer goes back to this session (值守's check).
      run: (args) => run(() => t.reply(args.number as number, args as { body?: string; status?: string; images?: string[] }, caller?.sessionId)),
    },
    {
      name: "issue_update",
      title: "改问题",
      description: "Change an issue: status (working when you take it), worker (who works on it, e.g. \"Opus 5.5 · 任务「问题 #3」\"; \"\" to clear), title, fixedIn.",
      inputSchema: { number: z.number().int(), status: status.optional(), worker: z.string().optional(), title: z.string().optional(), fixedIn: z.string().optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => run(() => t.update(args.number as number, args as { status?: string; worker?: string; title?: string; fixedIn?: string }, caller?.sessionId)),
    },
    {
      name: "issue_released",
      title: "问题已发布",
      description: "After a test build went out: version (e.g. \"Studio 0.9.17\") and the numbers of the issues it fixes. They become 已发布 with that version, and 发布打包's request is cleared.",
      inputSchema: { version: z.string(), numbers: z.array(z.number().int()) },
      readOnly: false,
      autoApprove: true,
      run: (args) => run(() => t.released(args.version as string, args.numbers as number[])),
    },
  ];
}
