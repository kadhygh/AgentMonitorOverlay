// The MCP server the models see: only the 协作 tools of plans/collab-agent-spec.md 第 3 节 (cowork_read / post / matter /
// ask / mark / retract / note / board, session_start / session_send with matter, amo_whoami), one endpoint per agent
// (/mcp/<key>) so every call knows who made it. Tool descriptions follow the spec's table; they are part of what is being
// checked. Executors get the same tools, and the server refuses what the spec says they may not do (and logs it).
//
// The driver gives hooks: onSessionStart (make an executor and start its first turn), onSessionSend, roleCard.

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { STATUSES } from "./collab.mjs";
import { listenInStudioRange } from "../../packages/testkit/dist/ports.js";

const list = (v) => (v == null ? [] : Array.isArray(v) ? v : String(v).split(/[,，、\s]+/).filter(Boolean));

export const TOOL_TEXT = {
  amo_whoami: "你的角色卡：你是谁（主控 / 执行）、在哪个协作、你这一方和对方是谁、你该做什么不该做什么，以及协作的规则（总的几条、收尾、闸门）。",
  cowork_read:
    "看协作。不带参数：你的角色、协作目标、已定的事、开着的事项（编号、状态、在等谁、卡在哪）、待你处理、群聊最近几条。带 threadId（「事项 3」或 3）：这件事项的字段和里面全部的来回。带 seq（「#7」）：一条消息全文。带 before（#seq）：往前翻群聊。读到的消息记成「看过」。",
  cowork_post:
    "在协作里说话。带 threadId（「事项 3」）：在这件事项里说（具体问题都在事项里谈）；不带：发到群聊（群聊只发进度和 @，不讨论具体问题）。replyTo：你回的那条 #seq（被回复的那条自动标成你处理了）。mentions：要 @ 的人（显示名，如「老李」）；agentMentions：要 @ 的 AI（显示名，如「老李的主控」或执行会话名）；被 @ 的才会被叫醒，不 @ 只是留给对方看。supersedes：这条取代的旧消息 #seq（旧的对方已经看过、不能撤回时用）。执行会话只能在自己那件事项里发、不能 @ 人。",
  cowork_matter:
    `事项：协作里一件要做或要谈的事，它的状态就是这件事的事实（做到哪、在等谁、卡在哪、结论）。action=open：开一件（title；owner 负责的主控，默认你；waiting 在等谁，显示名列表；body 第一条消息）——要对方做什么，就开一件、把 waiting 设成对方主控。action=update：matter（「事项 3」）加要改的字段：status（${STATUSES.filter((s) => s !== "关闭").join(" / ")}）、waiting、blocked（卡在哪，空字符串清掉）、commits（绑定的提交号）。「等对方」= 在等另一个 AI（waiting 写它）；「等人确认」只用在 cowork_ask 开的事项上，别的事项在等它就写 blocked「卡在 事项 N」。action=close：关掉，conclusion 写定了什么（进「已定的事」，事项里的消息都算处理了）。你负责的事项只有你改。cowork_conclude 是 close 的旧名。`,
  cowork_conclude: "cowork_matter action=close 的旧名：matter（或 threadId）和 conclusion。",
  cowork_ask:
    "要人拍板（闸门、口径）：开一件「等人确认」事项，在等那个人，并把 body 作为第一条消息发给他。to：人的显示名（一般是你自己的人）；title：「等{人}确认：{一句}」；body 只写变化（从什么改成什么）、一两个具体例子、不确认会怎样。about：相关的事项（可选）。开完就结束这一轮；人回复后你定结论、关掉它，再继续。",
  cowork_mark:
    "标记消息：state=done（处理了，默认）或 seen（看过）。seqs：#seq 列表；或 matter：事项编号（把它里面发给你的都标成处理了）。回复过的（cowork_post 带 replyTo）已经自动标了；看过、不用回但已经处理的用它标。",
  cowork_retract:
    "撤回或改写你自己的消息：seq；action=retract（撤回）或 edit（body 是新内容）。只在收件的人都还没看过时能做；有人看过了，就发新的一条（cowork_post 带 supersedes），旧的标成被取代，看过它的 AI 会收到提醒。",
  cowork_note: "记一个事件，不进任何事项、不叫醒任何人（要对方看到的事实用 cowork_post 贴进事项）：kind=commit（推送了：commit 提交号，files 改了的文件，text 一句说明）或 kind=note（text）。",
  cowork_board:
    "协作的白板（画布）。不带 ops：看板上的卡。ops：[{op:\"add\", item:{kind:\"note\"|\"ref\"|\"link\", text}}, {op:\"set\", id, fields:{text}}, {op:\"delete\", id}]，一次最多 10 张。事项卡自动在板上、跟着事项变，不用自己画状态。",
  session_start:
    "（主控用）派一个执行会话做一件事项：matter（「事项 3」，必须是你这一方负责的事项）、title（会话名，如「弹道实现」）、text（它收到的第一段话：做什么、在哪个分支、做完贴什么；它看不到别的事项，要用的数值、规则原文写进来）。它只进这一件事项，能在里面贴技术事实；它每一轮最后的回复会作为这件事项里的一条消息自动交回给你，并叫醒你。",
  session_send: "（主控用）给你开的执行会话补一句、改口：session（会话名）、text（同 session_start：要用的内容写全，不要只写事项号）。它正在一轮里时，排到这一轮结束后送到。",
};

// The v4 texts (before 11-25's derived status, basis and the three layers of cowork_read): run.mjs --tooltext v4.
const TOOL_TEXT_V4 = { ...TOOL_TEXT };
export function useToolTextV4() {
  Object.assign(TOOL_TEXT, TOOL_TEXT_V4);
}

// The tool texts as they were before the spec's 验收 changed them (run.mjs --tooltext v1, with a v1 spec).
const TOOL_TEXT_V1 = {
  cowork_matter: TOOL_TEXT.cowork_matter.replace("「等对方」= 在等另一个 AI（waiting 写它）；「等人确认」只用在 cowork_ask 开的事项上，别的事项在等它就写 blocked「卡在 事项 N」。", ""),
  cowork_note: "记一个事件，不叫醒任何人：kind=commit（推送了；commit 提交号，files 改了的文件，text 一句说明）或 kind=note（text）。",
};
export function useToolTextV1() {
  Object.assign(TOOL_TEXT, TOOL_TEXT_V1);
}

// v5 (11-25): status follows events, AIs answer each other with a basis, cowork_read in three layers.
Object.assign(TOOL_TEXT, {
  cowork_read:
    "看协作，分三层。不带参数：先是「待你处理」（@ 你的、回你的、在等你的事项、等你核对的、久没动静的），再是「概况」（你的角色、目标、已定的事、开着的事项一行一件：状态、在等谁、卡在哪、最近一个事件），最后是群聊最近几条。带 threadId（「事项 3」或 3）：这件事项的细节——字段、状态变化（每次是什么事件引起的）、里面全部的来回。带 seq（「#7」）：一条消息全文。带 before（#seq）：往前翻群聊。读到的消息记成「看过」。刚接手或刚压缩完，按这个顺序看：不带参数 → 要动的那几件事项带 threadId。",
  cowork_post:
    "在协作里说话。带 threadId（「事项 3」）：在这件事项里说（具体问题都在事项里谈）；不带：发到群聊（只发进度，进度不 @ 人）。replyTo：你回的那条 #seq（被回复的那条自动标成你处理了）。mentions：要 @ 的人（显示名，如「老李」）；agentMentions：要 @ 的 AI（显示名，如「小王的主控」或执行会话名）；被 @ 的才会被叫醒。事项里最后一条 @ 或回复指向对方的 AI、它还没回，这件事项就自动是「等对方」、在等它。basis：回答别的 AI 的问题（口径、边界、数值）时写来源——confirmed（已和人确认：basisRef 写在哪确认的，如「11-25 10:02 小王在会话里说的」「已定的事第 2 条」「#12」）或 inferred（我的判断，人没确认过）；没把握就写 inferred 或先去问人，不要写 confirmed。supersedes：这条取代的旧消息 #seq（旧的对方已经看过、不能撤回时用）。执行会话只能在自己那件事项里发；可以 @ AI（对方主控、对方的执行），不能 @ 人。",
  cowork_matter:
    `事项：协作里一件要做或要谈的事。状态跟着事件自动走：派了执行 / 它开始干 → 在做；事项里最后一条 @ 或回复指向对方的 AI、还没回 → 等对方（在等它）；cowork_ask → 等人确认，人回了 → 在做；执行贴了推上去的提交号 → 已推送；执行贴了通过的验证结果 → 待核对；在做很久没有事件 → 久没动静。你只补判断。action=open：开一件（title；owner 负责的主控，默认你；waiting 在等谁，显示名列表——要对方做什么就开一件、把 waiting 设成对方主控；body 第一条消息）。action=update：matter（「事项 3」）加字段：status=已验（你核对过：读了 diff、跑了或抽查了验证；待核对的你来核）；blocked（卡在哪，空字符串清掉）；commits（绑定的提交号）；title。别的 status（${STATUSES.filter((s) => !["关闭", "久没动静", "待核对"].includes(s)).join(" / ")}）和 waiting 也能手改，会盖过自动的、记成「手改」，下一个事件来了又按事件算——只在自动的不对时用。action=close：关掉，conclusion 写定了什么、谁定的（进「已定的事」；事项里的消息都算处理了，要对方接着做的先 @ 它）。你负责的事项只有你改。cowork_conclude 是 close 的旧名。`,
});

export async function startMcp({ collab, hooks, log, layered = true }) {
  const C = collab;

  function call(agentKey, tool, input, fn) {
    const a = C.agent(agentKey);
    const rec = { at: Date.now(), agent: agentKey, turn: a?.turn ?? null, tool, input, ok: true };
    C.s.calls.push(rec);
    try {
      const out = fn(a);
      C.save();
      return { content: [{ type: "text", text: out }] };
    } catch (err) {
      rec.ok = false;
      rec.error = err.message;
      if (err.violation) C.s.violations.push({ at: Date.now(), agent: agentKey, turn: a?.turn ?? null, tool, kind: err.violation, input, why: err.message });
      C.save();
      log?.(`refused ${agentKey} ${tool}: ${err.message}`);
      return { content: [{ type: "text", text: `被拒绝：${err.message}` }], isError: true };
    }
  }
  const refuse = (why, violation) => Object.assign(new Error(why), { violation });
  const noExec = (a, what, violation) => {
    if (a.role === "exec") throw refuse(`你是执行会话，不能${what}（这是主控的事）。拿不准的写进你这一轮最后的回复，交回给主控。`, violation);
  };
  const matterOr = (ref) => {
    const m = C.matter(ref);
    if (!m) throw new Error(`没有「${ref}」这件事项。开着的：${C.s.matters.filter((x) => x.status !== "关闭").map((x) => `事项 ${x.no}`).join("、") || "没有"}`);
    return m;
  };
  const whoList = (refs) =>
    list(refs).map((r) => {
      const k = C.resolveWho(r);
      if (!k) throw new Error(`不认识「${r}」。人：${Object.keys(C.s.people).join("、")}；AI：${Object.values(C.s.agents).map((x) => x.name).join("、")}`);
      return k;
    });
  const pendingText = (who) => {
    const p = C.pendingFor(who);
    if (!p.length) return "待你处理：没有。";
    return [`待你处理（${p.length}）：`, ...p.map((i) => "- " + describeItem(C, i, who))].join("\n");
  };

  function overview(a) {
    const s = C.s;
    const lines = [];
    if (a.role === "lead" && layered) lines.push("【一 · 待你处理】", pendingText(a.key), "", "【二 · 概况】");
    lines.push(`协作「${s.cowork.title}」（${s.cowork.ref}）· 你是 ${a.name}（${a.role === "lead" ? `${a.person} 这一方的主控` : `${C.nameOf(a.lead)} 派出的执行会话，只负责事项 ${a.matter}`}）`);
    lines.push(`目标：${s.cowork.goal}`);
    lines.push("已定的事：" + (s.cowork.decisions.length ? "\n" + s.cowork.decisions.map((d, i) => `${i + 1}. ${d.text}（${d.src}）`).join("\n") : "还没有"));
    if (a.role === "exec") {
      const m = C.matter(a.matter);
      lines.push("你的事项：" + C.matterLine(m));
      lines.push(...s.messages.filter((x) => x.where === m.no).map((x) => (C.seen(x, a.key), C.line(x, { max: 400 }))));
      return lines.join("\n");
    }
    const open = s.matters.filter((m) => m.status !== "关闭");
    lines.push("开着的事项：" + (open.length ? "\n" + open.map((m) => "- " + C.matterLine(m)).join("\n") : "没有"));
    const closed = s.matters.filter((m) => m.status === "关闭");
    if (closed.length) lines.push("关掉的事项：" + closed.map((m) => `事项 ${m.no}「${m.title}」`).join("、"));
    if (layered) lines.push("【三 · 事项细节】要看一件事项的来回和状态变化：cowork_read 带 threadId（「事项 N」）。", "");
    else lines.push(pendingText(a.key));
    const chat = s.messages.filter((m) => m.where === "chat").slice(-8);
    lines.push("群聊最近：" + (chat.length ? "\n" + chat.map((m) => (C.seen(m, a.key), C.line(m))).join("\n") : "还没有"));
    return lines.join("\n");
  }

  function build(agentKey) {
    const server = new McpServer({ name: "amo", version: "0.0.1" }, { instructions: "AMO 协作（模拟）。你的角色卡用 amo_whoami 看。" });
    const reg = (name, shape, fn) => server.registerTool(name, { description: TOOL_TEXT[name], inputSchema: shape }, async (args) => call(agentKey, name, args, (a) => fn(a, args ?? {})));
    const S = z.string().optional();
    const L = z.union([z.array(z.string()), z.string()]).optional();
    const N = z.union([z.number(), z.string()]).optional();

    reg("amo_whoami", {}, (a) => hooks.roleCard(a.key));

    reg("cowork_read", { threadId: N, seq: N, before: N }, (a, x) => {
      if (x.seq != null) {
        const m = C.msg(x.seq);
        if (!m) throw new Error(`没有 #${x.seq}`);
        if (a.role === "exec" && m.where !== a.matter) throw refuse(`你只看得到事项 ${a.matter} 里的消息。`, "read-other");
        C.seen(m, a.key);
        return `${C.line(m, { full: true })}\n（在 ${C.where(m)}）`;
      }
      if (x.threadId != null) {
        const m = matterOr(x.threadId);
        if (a.role === "exec" && m.no !== a.matter) throw refuse(`你只负责事项 ${a.matter}，看不了事项 ${m.no}。缺的内容写进你这一轮最后的回复，问主控。`, "read-other");
        const msgs = C.s.messages.filter((y) => y.where === m.no);
        for (const y of msgs) C.seen(y, a.key);
        return [C.matterLine(m), "状态变化：" + m.hist.map((h) => `${new Date(h.at).toTimeString().slice(0, 5)} ${h.from || "（开）"}→${h.to}（${h.cause ?? ""}${h.manual ? "，手改" : ""}，${C.nameOf(h.by)}）`).join("；"), "来回：", ...msgs.map((y) => C.line(y, { full: true }))].join("\n");
      }
      if (x.before != null) {
        if (a.role === "exec") throw refuse("你不看群聊。", "read-other");
        const b = Number(/(\d+)/.exec(String(x.before))?.[1] ?? 0);
        const chat = C.s.messages.filter((m) => m.where === "chat" && m.seq < b).slice(-15);
        for (const m of chat) C.seen(m, a.key);
        return chat.map((m) => C.line(m, { full: true })).join("\n") || "更早的没有了。";
      }
      return overview(a);
    });

    reg("cowork_post", { body: z.string(), threadId: N, replyTo: N, mentions: L, agentMentions: L, supersedes: N, ...(layered ? { basis: z.enum(["confirmed", "inferred"]).optional(), basisRef: S } : {}) }, (a, x) => {
      const mentions = whoList(x.mentions);
      const agentMentions = whoList(x.agentMentions);
      for (const k of agentMentions) if (C.isPerson(k)) throw new Error(`「${k}」是人，放在 mentions 里。`);
      for (const k of mentions) if (!C.isPerson(k)) throw new Error(`「${C.nameOf(k)}」是 AI，放在 agentMentions 里。`);
      let where = "chat";
      if (x.threadId != null && x.threadId !== "") where = matterOr(x.threadId).no;
      if (a.role === "exec") {
        if (where === "chat") throw refuse("你是执行会话，不在群聊发言。要说的贴进你的事项（threadId 写你的事项），或写进这一轮最后的回复交回给主控。", "chat");
        if (where !== a.matter) throw refuse(`你只负责事项 ${a.matter}，不能在事项 ${where} 里发言。`, "other-matter");
        if (mentions.length) throw refuse("你是执行会话，不 @ 人。要人知道的写进最后的回复，交给主控。", "at-person");
      }
      const m = where === "chat" ? null : C.matter(where);
      if (m?.status === "关闭") throw new Error(`事项 ${m.no} 已经关了。`);
      if (x.replyTo != null && !C.msg(x.replyTo)) throw new Error(`没有 #${x.replyTo}`);
      if (x.supersedes != null) {
        const old = C.msg(x.supersedes);
        if (!old) throw new Error(`没有 #${x.supersedes}`);
        if (old.from !== a.key) throw refuse("只能取代你自己的消息。", "other-message");
      }
      const person = a.role === "lead" ? a.person : C.agent(a.lead)?.person;
      const basis = x.basis ? { kind: x.basis, person, ref: x.basisRef ?? null } : null;
      const msg = C.post({ from: a.key, where, body: x.body, replyTo: x.replyTo != null ? Number(/(\d+)/.exec(String(x.replyTo))[1]) : null, mentions, agentMentions, supersedes: x.supersedes != null ? Number(/(\d+)/.exec(String(x.supersedes))[1]) : null, basis });
      const warn = where === "chat" && /事项\s*\d/.test(x.body) === false && x.body.length > 300 ? "\n提示：群聊只发进度和 @；具体问题放进事项里谈。" : "";
      return `已发 #${msg.seq}（${C.where(msg)}），送到：${msg.to.map((w) => C.nameOf(w)).join("、") || "没有人"}。${warn}`;
    });

    const matterTool = (a, x, action) => {
      noExec(a, action === "open" ? "开事项" : action === "close" ? "关事项、定结论" : "改事项的状态", action === "close" ? "conclude" : "status");
      if (action === "open") {
        if (!x.title) throw new Error("open 要 title。");
        const owner = x.owner ? whoList(x.owner)[0] : a.key;
        const waiting = whoList(x.waiting);
        if (x.status && !STATUSES.includes(x.status)) throw new Error(`status 只能是：${STATUSES.join(" / ")}`);
        const m = C.openMatter({ title: x.title, owner, waiting, by: a.key });
        if (x.status && x.status !== m.status) C.updateMatter(m, { status: x.status }, a.key);
        if (x.blocked) C.updateMatter(m, { blocked: x.blocked }, a.key);
        if (x.body) C.post({ from: a.key, where: m.no, body: x.body, agentMentions: [] });
        return `开了事项 ${m.no}「${m.title}」：${C.matterLine(m)}`;
      }
      const m = matterOr(x.matter ?? x.threadId);
      const theirs = C.agent(m.owner)?.side !== a.side;
      if (theirs) C.s.violations.push({ at: Date.now(), agent: a.key, turn: a.turn ?? null, tool: "cowork_matter", kind: "other-side-matter", input: x, why: `改了对方负责的事项 ${m.no}（没拒绝，记一笔）` });
      if (action === "close") {
        if (m.status === "关闭") throw new Error(`事项 ${m.no} 已经关了。`);
        C.closeMatter(m, x.conclusion ?? "", a.key);
        return `关了事项 ${m.no}。${x.conclusion ? "结论进了已定的事。" : "（没写结论）"}`;
      }
      const f = {};
      if (x.status) {
        if (!STATUSES.includes(x.status)) throw new Error(`status 只能是：${STATUSES.join(" / ")}`);
        if (x.status === "关闭") throw new Error("关掉用 action=close，并写 conclusion。");
        f.status = x.status;
      }
      if (x.waiting !== undefined) f.waiting = whoList(x.waiting);
      if (x.blocked !== undefined) f.blocked = x.blocked;
      if (x.commits !== undefined) f.commits = list(x.commits);
      if (x.title) f.title = x.title;
      if (!Object.keys(f).length) throw new Error("update 要至少一个字段：status、waiting、blocked、commits、title。");
      C.updateMatter(m, f, a.key);
      return `事项 ${m.no}：${C.matterLine(m)}`;
    };
    const matterShape = { action: z.enum(["open", "update", "close"]), matter: N, threadId: N, title: S, owner: S, waiting: L, status: S, blocked: S, commits: L, conclusion: S, body: S };
    reg("cowork_matter", matterShape, (a, x) => matterTool(a, x, x.action));
    reg("cowork_conclude", { matter: N, threadId: N, conclusion: z.string() }, (a, x) => matterTool(a, x, "close"));

    reg("cowork_ask", { to: z.string(), title: z.string(), body: z.string(), about: N }, (a, x) => {
      noExec(a, "向人提问", "ask");
      const to = whoList(x.to)[0];
      if (!C.isPerson(to)) throw new Error(`cowork_ask 是问人的；「${C.nameOf(to)}」是 AI。要 AI 做事，开事项（cowork_matter open）。`);
      const m = C.openMatter({ title: x.title, owner: a.key, waiting: [to], status: "等人确认", by: a.key, kind: "confirm", about: x.about != null ? C.matter(x.about)?.no ?? null : null });
      const msg = C.post({ from: a.key, where: m.no, body: x.body, to: [to] });
      return `开了事项 ${m.no}「${m.title}」（等人确认，在等 ${to}），#${msg.seq} 已送到 ${to}。现在结束这一轮，等他回复。`;
    });

    reg("cowork_mark", { seqs: L, matter: N, state: S }, (a, x) => {
      const state = x.state === "seen" ? "seen" : "done";
      const msgs = [];
      for (const s of list(x.seqs)) {
        const m = C.msg(s);
        if (!m) throw new Error(`没有 ${s}`);
        msgs.push(m);
      }
      if (x.matter != null) msgs.push(...C.s.messages.filter((m) => m.where === matterOr(x.matter).no));
      let n = 0;
      for (const m of msgs) if (m.rc[a.key]) (state === "done" ? C.done(m, a.key) : C.seen(m, a.key), n++);
      return `标了 ${n} 条「${state === "done" ? "处理了" : "看过"}」。${pendingText(a.key)}`;
    });

    reg("cowork_retract", { seq: z.union([z.number(), z.string()]), action: z.enum(["retract", "edit"]), body: S }, (a, x) => {
      const m = C.msg(x.seq);
      if (!m) throw new Error(`没有 #${x.seq}`);
      if (m.from !== a.key) throw refuse("只能撤回、改写你自己的消息。", "other-message");
      const seenBy = Object.entries(m.rc).filter(([, st]) => st.seen).map(([w]) => C.nameOf(w));
      if (seenBy.length) throw new Error(`${seenBy.join("、")} 已经看过 #${m.seq}，不能撤回或改。发新的一条，带 supersedes: ${m.seq}。`);
      if (x.action === "retract") m.retracted = true;
      else {
        if (!x.body) throw new Error("edit 要 body。");
        m.edits.push({ at: Date.now(), old: m.body });
        m.body = x.body;
      }
      C.save();
      return `#${m.seq} 已${x.action === "retract" ? "撤回" : "改写"}。`;
    });

    reg("cowork_note", { kind: z.enum(["commit", "note"]), text: z.string(), commit: S, files: L }, (a, x) => {
      C.s.notes.push({ at: Date.now(), by: a.key, kind: x.kind, text: x.text, commit: x.commit ?? null, files: list(x.files) });
      return "记下了（不叫醒任何人）。";
    });

    reg("cowork_board", { ops: z.array(z.record(z.string(), z.any())).optional() }, (a, x) => {
      const cards = () => [...C.s.matters.map((m) => `[事项卡] ${C.matterLine(m)}`), ...C.s.board.filter((b) => !b.deleted).map((b) => `[${b.kind} ${b.id}] ${b.text}`)].join("\n") || "板上还没有卡。";
      if (!x.ops?.length) return cards();
      if (a.role === "exec") throw refuse("执行会话只看板，不改板。", "board");
      for (const op of x.ops.slice(0, 10)) {
        if (op.op === "add") C.s.board.push({ id: `b${++C.s.boardId}`, kind: op.item?.kind ?? "note", text: String(op.item?.text ?? ""), by: a.key, at: Date.now() });
        else if (op.op === "set") {
          const b = C.s.board.find((y) => y.id === op.id);
          if (b && op.fields?.text != null) b.text = String(op.fields.text);
        } else if (op.op === "delete") {
          const b = C.s.board.find((y) => y.id === op.id);
          if (b) b.deleted = true;
        }
      }
      return cards();
    });

    reg("session_start", { text: z.string(), matter: N, title: S, model: S, report: z.boolean().optional() }, (a, x) => {
      noExec(a, "开会话", "session");
      if (x.matter == null) throw new Error("在协作里派活要带 matter（你这一方负责的事项编号，如「事项 3」）。没有合适的事项就先开一件。");
      const m = matterOr(x.matter);
      if (C.agent(m.owner)?.side !== a.side) throw new Error(`事项 ${m.no} 是 ${C.nameOf(m.owner)} 负责的，只能从你这一方的事项开执行会话。`);
      if (m.status === "关闭") throw new Error(`事项 ${m.no} 已经关了。`);
      const e = hooks.onSessionStart(a, m, x.title || `执行 ${m.no}`, x.text);
      return `开了执行会话「${e.name}」，只进事项 ${m.no}。它每一轮的结果会作为事项 ${m.no} 里的消息自动交回给你并叫醒你；等结果时直接结束这一轮。`;
    });
    reg("session_send", { session: z.string(), text: z.string() }, (a, x) => {
      noExec(a, "给别的会话发消息", "session");
      const k = C.resolveWho(x.session);
      const e = k && C.agent(k);
      if (!e || e.role !== "exec" || e.lead !== a.key) throw new Error(`「${x.session}」不是你开的执行会话。你开的：${Object.values(C.s.agents).filter((y) => y.lead === a.key).map((y) => y.name).join("、") || "没有"}`);
      hooks.onSessionSend(a, e, x.text);
      return `已交给「${e.name}」，${e.busy ? "它这一轮结束后送到" : "马上送到"}。`;
    });
    return server;
  }

  const httpServer = http.createServer(async (req, res) => {
    const m = /^\/mcp\/(\w+)/.exec(req.url ?? "");
    if (!m || !C.agent(m[1])) {
      res.writeHead(404).end();
      return;
    }
    const server = build(m[1]);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      let body = "";
      for await (const chunk of req) body += chunk;
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch (err) {
      log?.(`mcp error ${err.message}`);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  const port = await listenInStudioRange(httpServer);
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { httpServer.closeAllConnections?.(); httpServer.close(r); }) };
}

/** One 待你处理 line (spec 第 2 节): @ and replies in full, a 事项 as one line. */
export function describeItem(C, i, who) {
  if (i.kind === "matter") {
    const m = C.matter(i.matter);
    const h = [...m.hist].reverse().find((x) => (x.waiting ?? []).includes(who)) ?? m.hist.at(-1);
    const last = [...C.s.messages].reverse().find((x) => x.where === m.no && x.from !== who);
    return `事项 ${m.no}「${m.title}」· ${m.status} · 在等 你　${C.nameOf(h.by)} ${new Date(h.at).toTimeString().slice(0, 5)} 改成等你${m.blocked ? `，卡在 ${m.blocked}` : ""}${last ? `（#${last.seq}）` : ""}`;
  }
  if (i.kind === "verify") {
    const m = C.matter(i.matter);
    const h = [...m.hist].reverse().find((x) => x.to === "待核对") ?? m.hist.at(-1);
    return `事项 ${m.no}「${m.title}」· 待核对　${C.nameOf(h.by)} ${new Date(h.at).toTimeString().slice(0, 5)} 贴了通过的验证（提交 ${m.binds.commits.slice(-2).join(" ")}）：你核对后标已验，不对就写卡在哪`;
  }
  if (i.kind === "stale") {
    const m = C.matter(i.matter);
    return `事项 ${m.no}「${m.title}」· 久没动静　在做，${new Date(m.lastEventAt).toTimeString().slice(0, 5)} 之后没有事件：看看执行是不是卡住了`;
  }
  if (i.kind === "reminder") {
    const r = i.reminder;
    const nu = C.msg(r.newSeq);
    return `你看过的 #${r.oldSeq} 已被 #${r.newSeq} 取代（在 ${C.where(nu)}）：${C.line(nu, { full: true })}`;
  }
  const m = C.msg(i.seq);
  const who2 = C.isPerson(m.from) ? m.from : C.nameOf(m.from);
  if (i.full || m.kind === "report") {
    const why = i.atMe ? "@ 你" : m.kind === "report" ? "交回了结果" : "回你";
    return `#${m.seq} ${who2} ${why}（在 ${C.where(m)}）：${C.line(m, { full: true }).replace(/^#\d+ \S+ /, "")}`;
  }
  const mt = C.matter(i.matter ?? m.where);
  return `事项 ${mt.no}「${mt.title}」· ${mt.status} · 在等 ${mt.waiting.length ? mt.waiting.map((w) => C.nameOf(w)).join("、") : "—"}　#${m.seq} ${who2} ${new Date(m.at).toTimeString().slice(0, 5)} 发了新消息：${m.body.replace(/\s+/g, " ").slice(0, 60)}${m.body.length > 60 ? "…" : ""}`;
}
