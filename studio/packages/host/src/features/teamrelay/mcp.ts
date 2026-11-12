import { z } from "zod";
import { fail, json, writeAsync, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";
import type { TeamSend } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import { sizeText } from "@amo-studio/relay/light";

/** A picture team_file_get also hands over as an image (as relay_file_download): the kinds models read, small ones. */
const INLINE_IMAGE = /^image\/(png|jpeg|gif|webp)$/;
const INLINE_IMAGE_BYTES = 1024 * 1024;

const questionsSchema = z
  .array(z.object({ text: z.string(), options: z.array(z.string()).optional() }))
  .optional()
  .describe("Questions to answer one by one, each with options to pick from (they can still write their own).");

/**
 * The AMO MCP tools of 会话里用中转 (gathered in mcp/tools.ts). All run without the runtime's approval: what goes to a
 * person waits for the person in Studio itself (team_ask, team_followup; or goes at once when they turned that off),
 * the rest only reads or closes.
 */
export function teamRelayTools({ service, caller }: ToolContext): AmoTool[] {
  const t = service.teamRelay;
  const read = async (run: () => Promise<unknown>) => {
    try {
      const out = await run();
      return typeof out === "string" ? { content: [{ type: "text" as const, text: out }] } : json(out);
    } catch (err) {
      if (err instanceof HostError) return fail(err.message);
      throw err;
    }
  };
  /** What the agent is told after team_ask / team_followup: waiting for the person, sent, or why it did not go. */
  const answer = (send: TeamSend) => {
    if (send.state === "failed") throw new HostError("runtime_error", `没发给 ${send.to}：${send.error ?? "发送失败"}`);
    if (send.state === "sent") return { sendId: send.id, threadId: send.threadId, note: `已发给 ${send.to}${send.error ? `（${send.error}）` : ""}。现在结束这一轮，不要接着按没确认的方向做；对方的回复会自动回到这个对话。` };
    return { sendId: send.id, note: `等人在 Studio 里确认后发给 ${send.to}。现在结束这一轮，不要接着按没确认的方向做；对方的回复会自动回到这个对话。` };
  };
  return [
    {
      name: "team_members",
      title: "团队成员",
      description: "The people on the team (AMO 中转) you can ask through team_ask: name, nickname, what they do (role), online.",
      inputSchema: {},
      readOnly: true,
      autoApprove: true,
      run: () => read(() => t.members()),
    },
    {
      name: "team_ask",
      title: "找人确认",
      description:
        "Ask someone on the team (AMO 中转) to confirm something — an implementation choice, an interface, how much work, whether a plan holds — as the person you work for, marked as their AI's. The person usually confirms it in Studio before it goes (the answer says whether it went or waits). Then end your turn; do not go on in the unconfirmed direction. Their reply comes back into this conversation by itself. They cannot see this computer or this conversation: write the background, the plan and what to confirm in body (Markdown); one question per point in questions; files: full local paths to take along (at most 5, 20 MB each).",
      inputSchema: { to: z.string().describe("Their name (team_members)."), title: z.string().describe("One line: what to confirm."), body: z.string(), questions: questionsSchema, files: z.array(z.string()).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => writeAsync(caller, async (c) => answer(await t.requestAsk(c.sessionId, args))),
    },
    {
      name: "team_followup",
      title: "追问",
      description: "Ask again in a 中转 session you sent (its threadId came with the reply): body, and questions for a new round to answer one by one. The person usually confirms it in Studio first; the answer comes back into this conversation by itself.",
      inputSchema: { threadId: z.string(), body: z.string(), questions: questionsSchema },
      readOnly: false,
      autoApprove: true,
      run: (args) => writeAsync(caller, async (c) => answer(await t.requestFollowup(c.sessionId, args))),
    },
    {
      name: "team_done",
      title: "收尾",
      description: "Settled: close a 中转 session you sent, with a last word (note) if you like — e.g. what you will do now. Then go on with what was agreed.",
      inputSchema: { threadId: z.string(), note: z.string().optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => writeAsync(caller, async (c) => ({ ...(await t.done(c.sessionId, args)), note: "已标记完成。" })),
    },
    {
      name: "team_session",
      title: "读中转会话",
      description: "A 中转 session in full: the request, every answer, verdicts, notes, and the files in it (fileId for team_file_get). Replies come into this conversation by themselves; use this to look back.",
      inputSchema: { threadId: z.string() },
      readOnly: true,
      autoApprove: true,
      run: (args) => read(() => t.read(args.threadId)),
    },
    {
      // 2026-11-13 (the user: Studio 里的 team_* 那条路也要能拿到附件): the files a reply lists, onto this computer.
      name: "team_file_get",
      title: "取中转会话里的文件",
      description: "Save a file of a 中转 session you sent (a picture, a document the other side sent; its fileId is listed under 「会话里的文件」 in the reply and in team_session) on this computer, in Studio's data folder, and get its full path to open with your own tools. A picture up to 1 MB also comes as an image. Only files of your own 中转 sessions; at most 20 MB.",
      inputSchema: { threadId: z.string(), fileId: z.string() },
      readOnly: true,
      autoApprove: true,
      run: async (args) => {
        if (!caller) return fail("这次调用没有 AMO 会话身份。");
        try {
          const got = await t.fileGet(caller.sessionId, args);
          const f = got.file;
          const type = f.type.split(";")[0]!.trim();
          const head = `${got.reused ? "已经取过这个文件（内容一致，没有重新下载）" : "已取下"}：${f.name} v${f.version} · ${type} · ${sizeText(f.size)} · ${f.by} 上传\n${got.path}`;
          if (INLINE_IMAGE.test(type) && f.size <= INLINE_IMAGE_BYTES) return { content: [{ type: "text" as const, text: `${head}\n\n图片在下面。` }, { type: "image" as const, data: Buffer.from(got.data).toString("base64"), mimeType: type }] };
          return { content: [{ type: "text" as const, text: `${head}\n\n用你的读文件工具打开这个路径。` }] };
        } catch (err) {
          if (err instanceof HostError) return fail(err.message);
          throw err;
        }
      },
    },
    {
      name: "team_sessions",
      title: "我的中转会话",
      description: "The 中转 sessions this conversation sent, and where each stands.",
      inputSchema: {},
      readOnly: true,
      autoApprove: true,
      run: () => (caller ? read(async () => t.sessionLines(caller.sessionId)) : fail("这次调用没有 AMO 会话身份。")),
    },
  ];
}
