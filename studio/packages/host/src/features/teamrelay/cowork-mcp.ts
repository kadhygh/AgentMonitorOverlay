import { z } from "zod";
import { fail, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";
import { HostError } from "../../core/shared.js";
import { BOARD_AI_MAX_CARDS } from "@amo-studio/relay/light";
import { COWORK_BRIEF } from "./cowork-text.js";

/**
 * 协作's tools (2026-11-23, plans/cowork.md; cowork.ts), for a session the person brought into a 协作 on AMO 中转. None waits
 * for approval here: bringing the session in was the person's authority for it to speak there as their AI; the service
 * keeps an @ or a new 子会话 as a draft for the person while the 协作's 「AI 发起 @ 和提问」 is off, and the answer says so.
 */
export function coworkTools({ service, caller }: ToolContext): AmoTool[] {
  const c = service.teamRelay.cowork;
  const run = async (fn: (sessionId: string) => Promise<string>) => {
    if (!caller) return fail("这次调用没有 AMO 会话身份。");
    try {
      return { content: [{ type: "text" as const, text: await fn(caller.sessionId) }] };
    } catch (err) {
      if (err instanceof HostError) return fail(err.message);
      throw err;
    }
  };
  const coworkId = z.string().optional().describe("The 协作 (coworkId); may be left out when this session is in only one.");
  return [
    {
      name: "cowork_read",
      title: "读协作",
      description:
        `The 协作 (cowork on AMO 中转) this session was brought into: its goal, repository and branch, people and AIs (with their state and mark), open 子会话, 已定的事 (decisions), recent events, the files in its 群聊 and 子会话 (threadId and fileId for team_file_get), your drafts waiting for your person, then the messages of its 群聊 and 子会话 since you last read (each with #seq, for replyTo) — kept short: those that @ you or answer you whole, others cut to ${COWORK_BRIEF.clipChars} characters, about ${COWORK_BRIEF.readChars} characters from the newest back, older ones one line each (#seq · who · where · how it starts). threadId: one 子会话 instead (with its files): its opening question whole, the rest the same way within ${COWORK_BRIEF.sessionChars}. seq: one message whole (a cut or one-line one). before: the messages before that #seq, to page back (with threadId: in that 子会话). after: read from that #seq. A long discussion: read the goal, 已定的事 and the 白板 (cowork_board) first, and open messages only when you need them.`,
      inputSchema: {
        coworkId,
        threadId: z.string().optional(),
        after: z.number().int().optional(),
        seq: z.number().int().optional().describe("One message in full, by its #seq."),
        before: z.number().int().optional().describe("The messages before this #seq (page back)."),
      },
      readOnly: true,
      autoApprove: true,
      run: (args) => run((sid) => c.read(sid, args)),
    },
    {
      name: "cowork_post",
      title: "在协作里发言",
      description:
        "Say something in the 协作 as your person's AI: in its 群聊, or in a 子会话 (threadId) — a reply there, or 插话. replyTo: the #seq you answer (shown as 「回 X」). mentions: people to @ (account names); agentMentions: AIs to @ (their mark from cowork_read) — an @-ed AI is woken, nobody else is. While the 协作's 「AI 发起 @ 和提问」 is off, a message that @-s anyone is kept as a draft for your person to send or drop (the answer says so); without @ it goes at once.",
      inputSchema: { coworkId, threadId: z.string().optional(), body: z.string().describe("Markdown."), replyTo: z.number().int().optional(), mentions: z.array(z.string()).optional(), agentMentions: z.array(z.string()).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => run((sid) => c.post(sid, args)),
    },
    {
      name: "cowork_ask",
      title: "在协作里开子会话",
      description:
        "Ask a person in the 协作 to confirm one thing: a new 子会话 (everyone in the 协作 sees it and may join in; it shows as a card in the 群聊). Write the background and what to confirm in body; one question per point in questions. Replies in it come back into this conversation. While 「AI 发起 @ 和提问」 is off it is a draft until your person sends it. Then end your turn; do not go on in the unconfirmed direction.",
      inputSchema: { coworkId, to: z.string().describe("Their account name (cowork_read lists the people)."), title: z.string().describe("One line."), body: z.string(), questions: z.array(z.object({ text: z.string(), options: z.array(z.string()).optional() })).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => run((sid) => c.ask(sid, args)),
    },
    {
      name: "cowork_conclude",
      title: "给子会话定结论",
      description:
        "定下结论 of a 子会话 in the 协作: it closes, and the conclusion goes into the 协作's 已定的事 for everyone. Only its two sides may: the one who asked (a 子会话 you or your person started) and the one asked (a 子会话 asking your person). Conclude once the other side has agreed — write what was settled, in one or two sentences — not to close a question still being talked over.",
      inputSchema: { coworkId, threadId: z.string().describe("The 子会话 (from cowork_read)."), conclusion: z.string().describe("What was settled.") },
      readOnly: false,
      autoApprove: true,
      run: (args) => run((sid) => c.conclude(sid, args)),
    },
    {
      name: "cowork_board",
      title: "协作白板",
      description: `The 协作's 白板 (an infinite canvas several people and AIs change at once). Without ops: every card (id, kind, base version, place, text, marks such as 已过时, 有冲突, someone writing it). With ops, in order: {op:"add", item:{kind: note|ref|group|link|session, text, x, y, w, h, color, group, ref:{kind: file|commit|doc|url, path, commit, url, title}, from, to, session}}, {op:"set", id, base, fields:{x, y, w, h, color, text, group, stale, ref, from, to}}, {op:"delete", id}, {op:"restore", id}, {op:"undo", seq} (only your own). At most ${BOARD_AI_MAX_CARDS} cards per call. Give base (the version you read) when changing a card's text: a card someone is writing (locked) or rewrote since you read (stale) is not changed — read again, or put a new card beside it and link it. Never rewrite others' cards wholesale. A ref card for a file names the commit you read it at.`,
      inputSchema: { coworkId, ops: z.array(z.record(z.string(), z.unknown())).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => run((sid) => c.board(sid, args)),
    },
    {
      name: "cowork_note",
      title: "记协作事件",
      description:
        "Record an event in the 协作 (it wakes nobody; the others read it when they look): kind commit after you pushed — commit (its id) and files (the paths it changed: board cards citing an older commit of them are marked 已过时) — or kind note for anything else worth keeping. The real content still goes into the branch's documents.",
      inputSchema: { coworkId, kind: z.enum(["commit", "note"]), text: z.string(), commit: z.string().optional(), files: z.array(z.string()).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => run((sid) => c.note(sid, args)),
    },
  ];
}
