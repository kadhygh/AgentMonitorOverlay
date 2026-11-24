import { z } from "zod";
import { fail, type AmoTool, type ToolContext } from "../../mcp/tool-kit.js";
import { HostError } from "../../core/shared.js";
import { BOARD_AI_MAX_CARDS } from "@amo-studio/relay/light";
import { COWORK_BRIEF } from "./cowork-text.js";

/**
 * 协作's tools (2026-11-23, plans/cowork.md; cowork.ts), for a session the person brought into a 协作 on AMO 中转. None waits
 * for approval here: bringing the session in was the person's authority for it to speak there as their AI. Since 2026-11-24
 * (plans/collab-agent-spec.md §3, a service with 事项: /api/health `cowork` ≥ 2) the flow is 事项 and roles: what each tool is
 * for is written as the spec's 工具对照表; on an older service the same tools work the old way (子会话, drafts) and the new
 * ones say the service cannot yet.
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
  const coworkId = z.string().optional().describe("The 协作 (coworkId, or `cowork:<id>` as the person copied it); may be left out when this session is in only one.");
  const seq = z.union([z.number().int(), z.string()]);
  const thread = z.string().optional().describe("Where: 「事项 3」 (or its threadId, or a line copied from 中转); left out: the 群聊.");
  return [
    {
      name: "cowork_read",
      title: "读协作",
      description:
        `The 协作 (cowork on AMO 中转) this session was brought into. Without arguments, the whole picture: your role (主控 / 执行 / 未分角色), its goal, repository and branch, people and AIs (with their role, state and mark), the open 事项 with status, whom each waits on and where it is stuck, 已定的事, your 待你处理, recent events, the files (threadId and fileId for team_file_get), then the messages since you last read (each with #seq, for replyTo) — kept short: those that @ you or answer you whole, others cut to ${COWORK_BRIEF.clipChars} characters, about ${COWORK_BRIEF.readChars} characters from the newest back, older ones one line each. threadId (「事项 3」): one 事项's talk instead (with its files): its opening whole, the rest the same way within ${COWORK_BRIEF.sessionChars}. seq (「#7」): one message whole. before: the messages before that #seq, to page back (with threadId: in that 事项). after: read from that #seq. A long discussion: read the goal, 已定的事 and the 事项 first, and open messages only when you need them. An 执行 sees only the goal, 已定的事 and its own 事项. A reference pasted from the 中转 client: "cowork:<id>" is coworkId, "thread:<id>" threadId, "#<seq>（协作… cowork:<id>）" seq with that coworkId — only for a 协作 this session was brought into; for another, tell the person to bring this session in first (拉进协作).`,
      inputSchema: {
        coworkId,
        threadId: thread,
        after: z.number().int().optional(),
        seq: seq.optional().describe("One message in full, by its #seq."),
        before: seq.optional().describe("The messages before this #seq (page back)."),
      },
      readOnly: true,
      autoApprove: true,
      run: (args) => run((sid) => c.read(sid, args)),
    },
    {
      name: "cowork_post",
      title: "在协作里发言",
      description:
        "Say something in the 协作 as your person's AI. In a 事项 (threadId 「事项 3」): the talk about one thing — a reply, facts, a question to the other side's 主控. Without threadId: the 群聊, for progress and @ only (no discussion there). replyTo: the #seq you answer (it is marked 处理了 for you). handled: other #seqs (or true: everything to you in that thread) this message deals with, marked 处理了 too. mentions / agentMentions: whom to @ — people by name, AIs by name, 「X 的主控」 or mark; an @-ed AI is woken, nobody else is. supersedes: an earlier message of yours (#seq) that others already saw and this one replaces (it shows 「被 #x 取代」, the AIs that saw it get this one). basis: when you answer another AI for your person, where the answer comes from — confirmed (your person said so: in this conversation, or 已定的事 number `decision`) or inferred (your own judgement, your person has not confirmed it; the other side may take it to a person). notice: people to 知会 — asked to look, no answer wanted (they see it in 要你看). commits: the commits you pushed for this 事项 (it becomes 已推送); verify: {passed, how} after you checked it (passed → 待核对, failed → back to 在做). No new fact — only 「收到」「继续等」「同上」 — do not post: cowork_mark it instead (a reply wakes the other side). An 执行 posts only in its own 事项.",
      inputSchema: {
        coworkId,
        threadId: thread,
        body: z.string().describe("Markdown."),
        replyTo: seq.optional(),
        handled: z.union([z.literal(true), z.array(seq)]).optional(),
        mentions: z.array(z.string()).optional(),
        agentMentions: z.array(z.string()).optional(),
        supersedes: seq.optional(),
        basis: z.enum(["confirmed", "inferred"]).optional(),
        decision: z.number().int().positive().optional().describe("With basis confirmed: which of 已定的事 (from 1)."),
        notice: z.array(z.string()).optional(),
        commits: z.array(z.string()).optional(),
        verify: z.object({ passed: z.boolean(), how: z.string().optional() }).optional(),
      },
      readOnly: false,
      autoApprove: true,
      run: (args) => run((sid) => c.post(sid, args)),
    },
    {
      name: "cowork_matter",
      title: "开、改、关事项",
      description:
        "事项 are where the facts of the 协作 live: what each thing is, its status, whom it waits on, where it is stuck, what was settled (the board draws them; do not keep a status anywhere else). A 主控 (or 未分角色) only; an 执行 may not. action open: title, body (what it is and what is wanted), side (the person whose 主控 carries it: an AI opens 事项 on its own side only, the default), waitingOn (people or AIs: names, 「X 的主控」), kind (work / delegate / notice), dependsOn (「事项 2」…), blocker. To have the other side do something: open one on your side waiting on their 主控 (their 主控 opens its own 事项 for the work it carries). action update (matter 「事项 3」): a status follows the events by itself (an 执行 bound → 在做, an @ to the other side's AI → 等对方, commits pushed → 已推送, a passed verify → 待核对, cowork_ask → 等人确认); you add the judgement — verified once 待核对 checked, blocker, a conclusion — and set another status by hand only when the computed one is wrong (it shows 手改 until the next event): status — todo 待开始, doing 在做, waiting 等对方 (waiting on another AI: put it in waitingOn), pushed 已推送, verified 已验 (only after you checked: read the diff, the commit on the remote) — waitingOn, blocker (「卡在 事项 2」 when it waits on another 事项), dependsOn, bind / unbind {sessions, tasks, commits}, gate, note (why). 「等人确认」 is only for a 事项 cowork_ask opened. action close (matter, conclusion): it closes, its messages count as 处理了, the conclusion goes into 已定的事. A 事项 changed since you read it is refused: read it again.",
      inputSchema: {
        coworkId,
        action: z.enum(["open", "update", "close"]),
        matter: z.string().optional().describe("Which: 「事项 3」 (update, close)."),
        title: z.string().optional(),
        body: z.string().optional(),
        kind: z.enum(["work", "delegate", "notice"]).optional(),
        side: z.string().optional(),
        status: z.string().optional(),
        waitingOn: z.array(z.string()).optional(),
        blocker: z.string().nullable().optional(),
        dependsOn: z.array(z.string()).optional(),
        gate: z.enum(["red", "rules", "master", "others", "release"]).nullable().optional(),
        conclusion: z.string().optional(),
        note: z.string().optional(),
        bind: z.object({ sessions: z.array(z.string()).optional(), tasks: z.array(z.string()).optional(), commits: z.array(z.string()).optional() }).optional(),
        unbind: z.object({ sessions: z.array(z.string()).optional(), tasks: z.array(z.string()).optional(), commits: z.array(z.string()).optional() }).optional(),
      },
      readOnly: false,
      autoApprove: true,
      run: (args) => run((sid) => c.matter(sid, args)),
    },
    {
      name: "cowork_ask",
      title: "在协作里要人拍板",
      description:
        "Ask a person in the 协作 to decide one thing: a 「等人确认」 事项 waiting on them (everyone sees it; it shows as a card). Use it for the gates (判红的改动, 改已定的口径, 合并或推 master, 动别人的东西, 对外发布) — to your own person — and only for those: what your person said in this conversation is already their word. Title 「等{人}确认：{一句}」; body only the change (from what to what), one or two concrete examples, and what happens if they do not confirm; one question per point in questions. Their reply comes back into this conversation. Then end your turn; do not go on in the unconfirmed direction.",
      inputSchema: { coworkId, to: z.string().describe("Their account name (cowork_read lists the people)."), title: z.string().describe("One line."), body: z.string(), questions: z.array(z.object({ text: z.string(), options: z.array(z.string()).optional() })).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => run((sid) => c.ask(sid, args)),
    },
    {
      name: "cowork_conclude",
      title: "定结论",
      description:
        "The old name of cowork_matter close: the 事项 (threadId 「事项 3」) closes and its conclusion goes into the 协作's 已定的事. Conclude once the other side has agreed — what was settled, in one or two sentences — not to close something still being talked over. (On an older 中转 service: the 子会话's two sides only.)",
      inputSchema: { coworkId, threadId: z.string().describe("「事项 3」 or its threadId."), conclusion: z.string().describe("What was settled.") },
      readOnly: false,
      autoApprove: true,
      run: (args) => run((sid) => c.conclude(sid, args)),
    },
    {
      name: "cowork_mark",
      title: "标看过 / 处理了",
      description:
        "Mark messages to you 处理了 (default) or seen: seqs (#7, #9…), or matter 「事项 3」 for all of it (upTo: up to that #seq). Before you end a turn, mark what you dealt with and will not answer — 「收到」 needs no reply, a reply would wake the other side. What you answered with replyTo is marked already. Your 待你处理 (cowork_read) is what is left.",
      inputSchema: { coworkId, seqs: z.array(seq).optional(), matter: z.string().optional(), upTo: seq.optional(), mark: z.enum(["handled", "seen"]).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => run((sid) => c.mark(sid, args)),
    },
    {
      name: "cowork_retract",
      title: "撤回或改写消息",
      description: "A message of yours (seq) nobody has seen yet: without body it is withdrawn (a line 「已撤回」 stays), with body it is rewritten (shown 「改过」). Once someone saw it, it cannot: post a new one with supersedes.",
      inputSchema: { coworkId, seq, body: z.string().optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => run((sid) => c.retract(sid, args)),
    },
    {
      name: "cowork_board",
      title: "协作白板",
      description: `The 协作's 白板 (an infinite canvas several people and AIs change at once). Each 事项 has its card there already (drawn from the 事项: change the 事项, not the card). Without ops: every card (id, kind, base version, place, text, marks such as 已过时, 有冲突, someone writing it). With ops, in order: {op:"add", item:{kind: note|ref|group|link|session, text, x, y, w, h, color, group, ref:{kind: file|commit|doc|url, path, commit, url, title}, from, to, session}}, {op:"set", id, base, fields:{x, y, w, h, color, text, group, stale, ref, from, to}}, {op:"delete", id}, {op:"restore", id}, {op:"undo", seq} (only your own). At most ${BOARD_AI_MAX_CARDS} cards per call. Give base (the version you read) when changing a card's text: a card someone is writing (locked) or rewrote since you read (stale) is not changed — read again, or put a new card beside it and link it. Never rewrite others' cards wholesale. A ref card for a file names the commit you read it at. An 执行 does not change the board.`,
      inputSchema: { coworkId, ops: z.array(z.record(z.string(), z.unknown())).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => run((sid) => c.board(sid, args)),
    },
    {
      name: "cowork_note",
      title: "记协作事件",
      description:
        "Record an event in the 协作 (it wakes nobody and goes into no 事项; the others read it when they look): kind commit after you pushed — commit (its id) and files (the paths it changed: board cards citing an older commit of them are marked 已过时) — or kind note for anything else worth keeping. Facts the other side must see go into the 事项 with cowork_post.",
      inputSchema: { coworkId, kind: z.enum(["commit", "note"]), text: z.string(), commit: z.string().optional(), files: z.array(z.string()).optional() },
      readOnly: false,
      autoApprove: true,
      run: (args) => run((sid) => c.note(sid, args)),
    },
  ];
}
