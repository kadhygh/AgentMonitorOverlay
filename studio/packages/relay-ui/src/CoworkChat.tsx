import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { agentChip, agentRoute, agentWhat, atQuery, deliverySteps, matchTargets, mentionsIn, STATE_WORD, type MentionTarget } from "./coworkText.js";
import { Avatar, timeText, useDisplayName, useListed, usePeople, Who } from "./bits.js";
import { Markdown } from "./Markdown.js";
import { errorText, messageMenu } from "./Messages.js";
import { basisOf, LOOK_WORD, MATTER_CLS, matterChip, matterLabel, noticeOf, partyText, sideText, sinceState, type LookItem, type LookKind } from "./matterView.js";
import { copyRef, openMenu, openStudio, RefsContext, studioWhere, type MenuItem } from "./RefChips.js";
import { matterRef, messageRef } from "./refs.js";
import type { CoworkData, Session } from "./session.js";
import { canRewrite, RECEIPT_STATE_LABEL, receiptSummary, type CoworkAgent, type CoworkEvent, type CoworkListItem, type Matter, type Message, type Question } from "./shared.js";

// A 协作's conversation (2026-11-23, plans/cowork.md「人输入时看到的 agent 状态」, prototype A; 2026-11-25 the communication
// plan, plans/collab-framework.md「11-24」): its 群聊 or a 事项's messages — people and the AIs they brought in, a 事项 folded
// into a card where it was opened, the cowork's events as lines. Under a message of mine one line of receipts
// (「2 看过 · 1 处理了」, hover for each; nobody else's message shows them); mine I may withdraw or rewrite while nobody saw
// it, and replace (「被 #x 取代」) after; what is to me and not handled has 「处理了」 (「看过了」 for a 知会 in the 群聊); an
// AI's own judgement is marked 「我的判断」. New messages while I type or read further up do not move the list, a bar says
// how many came. The box to write in shows each AI's state in its @ list and, once one is @-ed, where it will go.

export interface CoworkCtx {
  session: Session;
  cowork: CoworkListItem;
  data: CoworkData;
  me: string;
  /** Its 事项 (an older service's 子会话 taken as 事项). */
  matters: Matter[];
  /** 要你看: what is mine to look at here. */
  looks: LookItem[];
  /** The messages in my 待我处理 (「处理了」 on them). */
  toHandle: Set<number>;
  /** Opens a 事项 (its window over the 群聊, its drawer on the board). */
  openMatter: (id: string) => void;
  /** Opens the board (on a 事项's card). */
  openBoard: (matter?: string) => void;
  /** A message of mine being replaced: the box sends the next one with `supersedes`. */
  replacing: { seq: number; threadId: string } | null;
  setReplacing: (r: { seq: number; threadId: string } | null) => void;
  toast: (t: string) => void;
}
export const CoworkContext = createContext<CoworkCtx | null>(null);
export const useCowork = (): CoworkCtx => {
  const c = useContext(CoworkContext);
  if (!c) throw new Error("useCowork outside a 协作");
  return c;
};

export const agentOf = (cowork: { agents: CoworkAgent[] }, mark: string | undefined | null) => (mark ? (cowork.agents.find((a) => a.mark === mark) ?? null) : null);

/** Mark messages 看过 / 处理了 for me (the service pushes the receipts and my 待我处理 back). */
export async function markMine(ctx: Pick<CoworkCtx, "session" | "cowork" | "toast">, mark: "seen" | "handled", seqs: number[], done?: string): Promise<void> {
  try {
    await ctx.session.client.markCowork(ctx.cowork.id, { mark, seqs });
    if (done) ctx.toast(done);
  } catch (err) {
    ctx.toast(errorText(err));
  }
}

/** The cowork's events shown in its 群聊 as lines (the rest are messages there already, or only in 已定的事). */
const EVENT_IN_CHAT = new Set<CoworkEvent["kind"]>(["commit", "note", "paused", "goal", "option", "ended", "reopened", "board"]);

function eventLine(e: CoworkEvent, show: (n: string) => string, agent: CoworkAgent | null): ReactNode {
  const who = agent ? agent.name : show(e.actor);
  if (e.kind === "commit")
    return (
      <>
        {who} 推了提交 {e.data?.commit && <code>{e.data.commit.slice(0, 7)}</code>}
        {e.data?.files?.length ? (
          <>
            ，改了{" "}
            {e.data.files.slice(0, 3).map((f) => (
              <code key={f}>{f}</code>
            ))}
            {e.data.files.length > 3 ? ` 等 ${e.data.files.length} 个文件` : ""}
          </>
        ) : null}
        {e.text ? `：${e.text}` : ""}
      </>
    );
  if (e.kind === "paused") return <b>{e.text || "AI 之间已经连续往来 30 条，等人看一下"}</b>;
  if (e.kind === "goal") return `${who} 改了目标说明`;
  return `${who}：${e.text}`;
}

const EVENT_MARK: Partial<Record<CoworkEvent["kind"], string>> = { commit: "↑", paused: "!", goal: "✎", note: "·", board: "▦" };

/** Three or more 白板 events in a row fold into one line: the run row i is in (its start, its first event's id). */
const BOARD_FOLD_MIN = 3;
function boardRun(rows: Array<{ e?: CoworkEvent }>, i: number): { start: number; first: number; events: CoworkEvent[] } | null {
  if (rows[i]?.e?.kind !== "board") return null;
  let a = i;
  while (a > 0 && rows[a - 1]!.e?.kind === "board") a--;
  let b = i;
  while (b + 1 < rows.length && rows[b + 1]!.e?.kind === "board") b++;
  if (b - a + 1 < BOARD_FOLD_MIN) return null;
  const events = rows.slice(a, b + 1).map((r) => r.e!);
  return { start: a, first: events[0]!.id, events };
}

/** @-ed names stand out in the message (people by name, AIs by 「X 的 AI · 会话名」). */
const boldAts = (body: string, names: string[]) => [...names].sort((a, b) => b.length - a.length).reduce((s, n) => s.split(`@${n}`).join(`**@${n}**`), body);

/**
 * The messages of one thread of the 协作 (its 群聊 — with the cowork's events between them — or a 子会话). Kept at the
 * bottom while I am there and not typing; otherwise still, with 「有 N 条新消息」.
 */
export function CoworkMessages(props: { threadId: string; messages: Message[] | null; error: string | null; questions?: Question[]; typing: boolean; empty: string; after?: ReactNode; withEvents?: boolean }) {
  const { cowork, data, me } = useCowork();
  const show = useDisplayName();
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastTop = useRef(0);
  const seen = useRef(0);
  const [fresh, setFresh] = useState(0);
  const list = props.messages ?? [];
  const bySeq = useMemo(() => new Map(list.map((m) => [m.seq, m])), [list]);

  // What happened in order: the thread's messages, and (群聊) the cowork's events by time.
  const rows = useMemo(() => {
    const out: Array<{ at: number; m?: Message; e?: CoworkEvent }> = list.map((m) => ({ at: m.createdAt, m }));
    if (props.withEvents) for (const e of data.events) if (EVENT_IN_CHAT.has(e.kind) && (!e.data?.threadId || e.data.threadId === props.threadId)) out.push({ at: e.at, e });
    // (an event made by a message — 「AI 之间已经连续往来 30 条」 — has its time: it comes after it)
    return out.sort((a, b) => a.at - b.at || (a.e ? 1 : 0) - (b.e ? 1 : 0) || (a.m?.seq ?? 0) - (b.m?.seq ?? 0));
  }, [list, data.events, props.withEvents, props.threadId]);

  const toBottom = () => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setFresh(0);
  };
  useLayoutEffect(() => {
    const n = rows.length;
    const added = n - seen.current;
    const first = seen.current === 0;
    seen.current = n;
    // (all of it in sight: nothing to tell)
    const fits = !!box.current && box.current.scrollHeight <= box.current.clientHeight + 1;
    if (first || fits || (added > 0 && atBottom.current && !props.typing)) toBottom();
    else if (added > 0) setFresh((f) => f + added);
  }, [rows.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Kept at the bottom while I am there and not typing, also when the list grows or its box shrinks with no new row
  // (a 子会话's card filling in, a draft, the tabs above the box): no scroll event says so, and it was left a bit up.
  const inner = useRef<HTMLDivElement>(null);
  const typing = useRef(props.typing);
  typing.current = props.typing;
  useEffect(() => {
    const el = box.current;
    if (!el || !inner.current) return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current && !typing.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    ro.observe(inner.current);
    return () => ro.disconnect();
  }, []);
  // Done typing, at the bottom: catch up.
  useEffect(() => {
    if (!props.typing && atBottom.current && fresh) toBottom();
  }, [props.typing]); // eslint-disable-line react-hooks/exhaustive-deps

  const round = useRef<Question[]>([]);
  round.current = props.questions ?? [];
  const [unfolded, setUnfolded] = useState<Set<number>>(() => new Set());
  return (
    <div className="cw-messages-wrap">
      <div
        className="messages cw-messages"
        ref={box}
        onScroll={(e) => {
          // Only my scrolling up leaves the bottom: a scroll event comes late, and the list may have grown since
          // (a card filling in) without my having moved.
          const el = e.currentTarget;
          const up = el.scrollTop < lastTop.current - 1;
          lastTop.current = el.scrollTop;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) atBottom.current = true;
          else if (up) atBottom.current = false;
          if (atBottom.current && fresh) setFresh(0);
        }}
      >
        <div className="cw-messages-inner" ref={inner}>
          {props.error && <div className="notice error">{props.error}</div>}
          {!props.messages && !props.error && <div className="muted center">加载中…</div>}
          {props.messages && !rows.length && <div className="muted center">{props.empty}</div>}
          {rows.map((r, i) => {
            if (r.e) {
              // A run of 白板 changes folds into one line (open it to see each), so the 群聊 stays a conversation.
              const run = boardRun(rows, i);
              if (run && !unfolded.has(run.first)) {
                if (run.start !== i) return null;
                const who = [...new Set(run.events.map((e) => agentOf(cowork, e.agent)?.name ?? show(e.actor)))];
                return (
                  <button key={`f${run.first}`} type="button" className="event cw-event kind-board cw-fold" onClick={() => setUnfolded((u) => new Set(u).add(run.first))} title="展开每一处">
                    <span className="cw-event-mark" aria-hidden="true">
                      ▦
                    </span>
                    板上 {run.events.length} 处改动（{who.slice(0, 3).join("、")}
                    {who.length > 3 ? " 等" : ""}）· 最近：{run.events.at(-1)!.text} · {timeText(run.events.at(-1)!.at)} · 展开
                  </button>
                );
              }
              const agent = agentOf(cowork, r.e.agent);
              return (
                <div key={`e${r.e.id}`} className={`event cw-event kind-${r.e.kind}`} title={new Date(r.e.at).toLocaleString()}>
                  <span className="cw-event-mark" aria-hidden="true">
                    {EVENT_MARK[r.e.kind] ?? "·"}
                  </span>
                  {eventLine(r.e, show, agent)} · {timeText(r.e.at)}
                  {run && run.start === i && (
                    <button type="button" className="link tiny" onClick={() => setUnfolded((u) => (u.delete(run.first), new Set(u)))}>
                      收起
                    </button>
                  )}
                </div>
              );
            }
            const m = r.m!;
            if (m.questions?.length && m.kind !== "reply") round.current = m.questions;
            if (m.kind === "event" && m.session) return <MatterCard key={m.seq} threadId={m.session} at={m.createdAt} by={m.author} />;
            if (m.kind === "event")
              return (
                <div key={m.seq} className="event" title={new Date(m.createdAt).toLocaleString()}>
                  {agentOf(cowork, m.via.kind === "ai" ? m.via.conv : null)?.name ?? show(m.author)} {m.body} · {timeText(m.createdAt)}
                </div>
              );
            const prev = rows[i - 1]?.m;
            return <CoworkMessage key={m.seq} m={m} prev={prev} replied={m.replyTo ? bySeq.get(m.replyTo) : undefined} me={me} questions={round.current} bySeq={bySeq} />;
          })}
          {props.after}
        </div>
      </div>
      {fresh > 0 && (
        <button type="button" className="cw-fresh" onClick={toBottom}>
          有 {fresh} 条新消息 ↓
        </button>
      )}
    </div>
  );
}

const CONTINUES_MS = 5 * 60_000;

function CoworkMessage({ m, prev, replied, me, questions, bySeq }: { m: Message; prev: Message | undefined; replied: Message | undefined; me: string; questions: Question[]; bySeq: Map<number, Message> }) {
  const ctx = useCowork();
  const { cowork, toHandle, setReplacing, session, toast } = ctx;
  const refs = useContext(RefsContext);
  const [editing, setEditing] = useState<string | null>(null);
  const show = useDisplayName();
  const ai = m.via.kind === "ai";
  const agent = ai ? agentOf(cowork, m.via.kind === "ai" ? m.via.conv : null) : null;
  const mine = m.author === me && !ai;
  const withdrawn = m.withdrawnAt !== undefined && m.withdrawnAt !== null;
  const receipts = m.receipts ?? [];
  // 撤回 and 原地改 while none of its recipients has seen it; after that, 发新的取代它 (the user 2026-11-24).
  const fresh = mine && !withdrawn && m.kind === "text" && canRewrite(receipts);
  const replaceable = mine && !withdrawn && m.kind === "text" && !fresh && m.supersededBy === undefined;
  const handle = toHandle.has(m.seq) && !mine;
  const notice = noticeOf(m);
  const inChat = m.threadId === cowork.id;
  const basis = ai ? basisOf(m, show) : null;
  const withdraw = async () => {
    try {
      session.patchMessage({ threadId: m.threadId, seq: m.seq, message: await session.client.withdrawCoworkMessage(cowork.id, m.seq) });
      toast("撤回了：还没有人看过");
    } catch (err) {
      toast(errorText(err));
    }
  };
  const rewrite = async (body: string) => {
    try {
      session.patchMessage({ threadId: m.threadId, seq: m.seq, message: await session.client.rewriteCoworkMessage(cowork.id, m.seq, { body }) });
      setEditing(null);
    } catch (err) {
      toast(errorText(err));
    }
  };
  // Right click: 复制引用 (#seq with the 协作), 在 Studio 里打开 for my AI's; mine: 撤回 / 改 / 发新的取代它.
  const menu = (): MenuItem[] => [
    ...messageMenu(m, me, refs, (x) => ({ text: messageRef(x.seq, { cowork }), what: `这条消息（#${x.seq}）` })),
    fresh ? { label: "改这条", hint: "还没有人看过：原地改，标「改过」", onClick: () => setEditing(m.body) } : null,
    fresh ? { label: "撤回", hint: "还没有人看过：撤回后只留「已撤回」", onClick: () => void withdraw() } : null,
    replaceable ? { label: "发新的取代它", hint: "已经有人看过：发一条新的，这条标「被 #新 取代」，看过它的 AI 会被提醒", onClick: () => setReplacing({ seq: m.seq, threadId: m.threadId }) } : null,
  ];
  const mineAi = m.via.kind === "ai" && !!studioWhere(m.via.conv, m.author, me, refs?.device ?? null);
  const continues = !!prev && prev.author === m.author && prev.kind === "text" && m.kind === "text" && prev.via.kind === m.via.kind && (prev.via.kind !== "ai" || m.via.kind !== "ai" || prev.via.conv === m.via.conv) && !m.replyTo && m.createdAt - prev.createdAt < CONTINUES_MS && !prev.withdrawnAt;
  const byId = new Map(questions.map((q) => [q.id, q]));
  const atNames = [...(m.mentions ?? []), ...(m.agentMentions ?? []).map((k) => agentOf(cowork, k)?.name ?? "")].filter(Boolean);
  const repliedWho = replied ? `${show(replied.author)}${replied.via.kind === "ai" ? " 的 AI" : ""}` : null;
  const by = m.supersededBy !== undefined ? bySeq.get(m.supersededBy) : undefined;
  if (withdrawn)
    return (
      <div id={`msg-${m.seq}`} data-seq={m.seq} className="event cw-withdrawn" title={new Date(m.withdrawnAt!).toLocaleString()}>
        {agent?.name ?? show(m.author)} 撤回了一条消息（#{m.seq}）· {timeText(m.withdrawnAt!)}
      </div>
    );
  return (
    <article id={`msg-${m.seq}`} data-seq={m.seq} className={`msg ${mine ? "mine" : "theirs"} kind-${m.kind} ${continues ? "continues" : ""} ${ai ? "by-ai" : ""} ${m.supersededBy !== undefined ? "superseded" : ""} ${handle ? "to-handle" : ""}`} onContextMenu={(e) => openMenu(e, menu())}>
      <div className="msg-av">{!continues && (ai ? <span className="avatar ai" title={agent?.name ?? `${m.author} 的 AI`}>AI</span> : <Avatar name={m.author} />)}</div>
      <div className="msg-col">
        <div className="msg-head">
          {mineAi ? (
            <button type="button" className="msg-name" title="我的 AI：在 Studio 里打开它的会话" onClick={(e) => openMenu(e, menu())}>
              <Who name={m.author} /> 的 AI
            </button>
          ) : (
            <b>
              <Who name={m.author} />
              {ai ? " 的 AI" : ""}
            </b>
          )}
          {agent && <span className="tag agent-label">{agent.role === "lead" ? "主控" : agent.role === "worker" ? `执行 · ${agent.label}` : agent.role === "unassigned" ? `未分角色 · ${agent.label}` : agent.label}</span>}
          {repliedWho && <span className="cw-reply-to">↳ 回 {repliedWho}</span>}
          {mine && <span className="me-tag">我</span>}
          {m.approvedBy && <span className="tag">{m.edited ? `${show(m.approvedBy)} 改过后发出` : `${show(m.approvedBy)} 确认后发出`}</span>}
          {m.kind === "request" && <span className="tag">{inChat ? "事项" : "开头"}</span>}
          {m.kind === "text" && !!m.questions?.length && <span className="tag">追问</span>}
          {m.kind === "reply" && <span className="tag">回答</span>}
          {notice && inChat && <span className="tag cw-notice-tag" title="知会：只要看过，不用回">知会 · 要{notice.map(show).join("、")}看过</span>}
          {basis?.kind === "inferred" && (
            <span className="tag cw-basis inferred" title={basis.text}>
              ! 我的判断
            </span>
          )}
          {basis?.kind === "confirmed" && (
            <span className="tag cw-basis confirmed" title={basis.text}>
              ✓ {basis.text}
            </span>
          )}
          {m.editedAt !== undefined && <span className="muted tiny">改过</span>}
          <span className="tm" title={new Date(m.createdAt).toLocaleString()}>
            #{m.seq} · {timeText(m.createdAt)}
          </span>
        </div>
        {replied && (
          <button type="button" className="msg-quote" title="跳到这条" onClick={() => jumpTo(replied.seq)}>
            {show(replied.author)}
            {replied.via.kind === "ai" ? " 的 AI" : ""}：{replied.body.replace(/\s+/g, " ").slice(0, 140)}
          </button>
        )}
        {m.supersededBy !== undefined && (
          <button type="button" className="cw-superseded" onClick={() => jumpTo(m.supersededBy!)} title="跳到取代它的那条">
            被 #{m.supersededBy} 取代{by ? `：${by.body.replace(/\s+/g, " ").slice(0, 60)}` : ""} ↓
          </button>
        )}
        <div className="msg-body">
          {editing !== null ? (
            <div className="cw-rewrite">
              <textarea value={editing} onChange={(e) => setEditing(e.target.value)} rows={3} aria-label="改这条" autoFocus />
              <div className="cw-edit-acts">
                <span className="muted tiny">还没有人看过，改了直接替换原文</span>
                <button type="button" className="small" onClick={() => setEditing(null)}>
                  取消
                </button>
                <button type="button" className="small primary" disabled={!editing.trim()} onClick={() => void rewrite(editing.trim())}>
                  改好了
                </button>
              </div>
            </div>
          ) : (
            m.body && <Markdown source={atNames.length ? boldAts(m.body, atNames) : m.body} />
          )}
          {m.kind !== "reply" && !!m.questions?.length && (
            <ol className="questions">
              {m.questions.map((q) => (
                <li key={q.id}>
                  {q.text}
                  {q.options && (
                    <div className="options">
                      {q.options.map((o) => (
                        <span key={o} className="opt">
                          {o}
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
          {m.kind === "reply" && !!m.answers?.length && (
            <ul className="answers">
              {m.answers.map((a) => (
                <li key={a.questionId}>
                  <div className="q">{byId.get(a.questionId)?.text ?? a.questionId}</div>
                  <div className="a">
                    {a.choice && <span className="opt on">{a.choice}</span>}
                    {a.text && <span>{a.text}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        {(mine || (m.author === me && ai)) && receipts.length > 0 && editing === null && <ReceiptLine m={m} />}
        {mine && !m.receipts && !!m.agentMentions?.length && <DeliveryTrail m={m} />}
        {(handle || (fresh && editing === null)) && (
          <div className="cw-msg-acts">
            {handle && (
              <button type="button" className="small primary" onClick={() => void markMine(ctx, inChat && notice?.includes(me) ? "seen" : "handled", [m.seq], inChat ? "记下了：看过了" : "记下了：处理了")}>
                {inChat ? "看过了" : "处理了"}
              </button>
            )}
            {fresh && editing === null && (
              <>
                <button type="button" className="link tiny" onClick={() => setEditing(m.body)} title="还没有人看过：原地改">
                  改
                </button>
                <button type="button" className="link tiny" onClick={() => void withdraw()} title="还没有人看过：撤回">
                  撤回
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

const jumpTo = (seq: number) => {
  const el = document.getElementById(`msg-${seq}`);
  el?.scrollIntoView({ block: "center" });
  el?.classList.add("flash");
  setTimeout(() => el?.classList.remove("flash"), 1600);
};

/**
 * Under a message of mine: its receipts in one line (「1 送到 · 2 看过 · 1 处理了」), each recipient on hover (the user
 * 2026-11-24: only on my own messages; nobody else's shows them).
 */
function ReceiptLine({ m }: { m: Message }) {
  const { cowork } = useCowork();
  const show = useDisplayName();
  const list = m.receipts ?? [];
  const sum = receiptSummary(list);
  const at = (r: (typeof list)[number]) => r.handledAt ?? r.seenAt ?? r.deliveredAt ?? r.queuedAt;
  return (
    <div className="cw-receipts" tabIndex={0} aria-label={`回执：${sum.text}`}>
      <span className="cw-rc-sum">
        {sum.handled === list.length ? "✓" : sum.queued === list.length ? "○" : "◐"} {sum.text}
      </span>
      <span className="cw-rc-pop" role="tooltip">
        {list.map((r) => (
          <span key={r.party} className={`cw-rc-row st-${r.state}`}>
            <b>{partyText(r.party, cowork.agents, show)}</b>
            <span>
              {RECEIPT_STATE_LABEL[r.state]}
              {r.byClose ? "（事项关了）" : ""} · {timeText(at(r))}
            </span>
          </span>
        ))}
      </span>
    </div>
  );
}

/** Under a message of mine that @-ed AIs, on a service from before receipts: where it went to each (排队中 → 已送达 → 已回复). */
function DeliveryTrail({ m }: { m: Message }) {
  const { cowork, data } = useCowork();
  const mine = data.deliveries.filter((d) => d.messageId === m.id);
  return (
    <div className="cw-trail" aria-label="这条的去向">
      {(m.agentMentions ?? []).map((mark) => {
        const d = mine.find((x) => x.agent === mark);
        const agent = agentOf(cowork, mark);
        const name = agent?.name ?? "AI";
        if (!d)
          return (
            <div key={mark} className="cw-trail-row">
              <span className="cw-trail-to">{name}</span>
              <span className="step">○ 去向还没来</span>
            </div>
          );
        if (d.state === "dropped")
          return (
            <div key={mark} className="cw-trail-row">
              <span className="cw-trail-to">{name}</span>
              <span className="step">○ 没送到：它离开了协作</span>
            </div>
          );
        const steps = deliverySteps(d);
        const now = steps.filter((s) => s.done).length - 1;
        return (
          <div key={mark} className="cw-trail-row" data-agent={mark}>
            {(m.agentMentions?.length ?? 0) > 1 && <span className="cw-trail-to">{name}</span>}
            {steps.map((s, i) => (
              <Fragment key={s.label}>
                {i > 0 && <span className="arrow">→</span>}
                <span className={`step ${s.done ? "done" : ""} ${i === now && d.state !== "replied" ? "now" : ""}`}>
                  {s.done ? (i === now && d.state === "queued" ? "◐" : "✓") : "○"} {s.label}
                  {s.done && i > 0 && s.at ? ` ${timeText(s.at)}` : ""}
                </span>
              </Fragment>
            ))}
            {d.state === "queued" && agent && agent.state !== "idle" && <span className="cw-trail-why">{agentRoute(agent)}</span>}
            {d.replySeq && (
              <button type="button" className="link tiny" onClick={() => jumpTo(d.replySeq!)}>
                看回复 ↓
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Why a 事项 is where it is, in a line: whom it waits on (and since when, with the word given), or what blocks it. */
export function matterWhy(m: Matter, agents: CoworkAgent[], show: (n: string) => string, me: string): string {
  const since = sinceState(m);
  if (m.conclusion) return `结论：${m.conclusion}`;
  if (m.blocker) return `卡在：${m.blocker}`;
  if (m.waitingOn.length) return `在等 ${m.waitingOn.map((p) => (p === `person:${me}` ? "你" : partyText(p, agents, show))).join("、")} · ${timeText(since.at)} 起${since.note ? ` · ${since.note}` : ""}`;
  return since.note ? `${since.note} · ${timeText(since.at)}` : `${timeText(since.at)} 起`;
}

/**
 * A 事项 folded into a card in the 群聊, where it was opened; it moves on in place (2026-11-25: 事项 N, its state, 负责方,
 * whom it waits on and why; 「等你确认」 / 「叫你来看」 when it is mine). A click opens it.
 */
export function MatterCard({ threadId, at, by }: { threadId: string; at: number; by: string }) {
  const { cowork, session, openMatter, me, toast, matters, looks } = useCowork();
  const show = useDisplayName();
  const m = matters.find((x) => x.id === threadId);
  const t = session.snapshot.threads.find((x) => x.id === threadId);
  if (!m)
    return (
      <div className="event">
        {show(by)} 开了一件事项 · {timeText(at)}
      </div>
    );
  const look = looks.find((l): l is Extract<LookItem, { kind: "matter" }> => l.kind === "matter" && l.matter.id === m.id)?.look as LookKind | undefined;
  return (
    <button type="button" className={`cw-subcard cw-mattercard st-${MATTER_CLS[m.status]} ${look ? `look-${look}` : ""}`} data-matter={m.id} data-session={m.id} onClick={() => openMatter(m.id)} onContextMenu={(e) => openMenu(e, [{ label: "复制引用", onClick: () => copyRef(matterRef(m, cowork.id), `${matterLabel(m)}「${m.title}」`, toast) }])} title="点开这件事项（右键复制引用）">
      <span className="cw-subcard-top">
        <span className="tag">{matterLabel(m)}</span>
        <span className="cw-subcard-title">{m.title}</span>
        {look && <span className={`cw-look ${look}`}>{LOOK_WORD[look]}</span>}
        <span className={`cw-state ${MATTER_CLS[m.status]}`}>{matterChip(m.status)}</span>
        {!!t?.unread && <span className="badge">{t.unread}</span>}
      </span>
      <span className="cw-subcard-sub">
        负责 {sideText(m, cowork.agents, show)} · {matterWhy(m, cowork.agents, show, me)}
      </span>
    </button>
  );
}

/**
 * The box under a 协作's 群聊 or 子会话. @ opens the list — people, then the AIs each with its state and what an @ does
 * now; an AI @-ed shows the line over the box saying where this goes. `onTyping` tells the list above to keep still.
 */
export function CoworkComposer(props: { threadId?: string; placeholder: string; onTyping?: (on: boolean) => void; extra?: ReactNode; tools?: ReactNode; disabled?: string | null; onSent?: () => void; draftKey?: string }) {
  const { cowork, session, me, toast, replacing, setReplacing } = useCowork();
  const people = usePeople();
  const listed = useListed(me);
  // 发新的取代它 (2026-11-24): this box sends the next one as the message it replaces.
  const replaces = replacing && replacing.threadId === (props.threadId ?? cowork.id) ? replacing.seq : null;
  const device = useContext(RefsContext)?.device ?? null;
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [pick, setPick] = useState(0);
  const [closed, setClosed] = useState(false);
  const [routeOff, setRouteOff] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => props.onTyping?.(!!text.trim()), [!!text.trim()]); // eslint-disable-line react-hooks/exhaustive-deps

  const targets = useMemo<Array<MentionTarget & { also?: string; agent?: CoworkAgent }>>(
    () => [
      ...cowork.members.filter((n) => n !== me && listed(n)).map((n) => ({ text: n, kind: "person" as const, id: n, also: people.get(n)?.nick })),
      ...cowork.agents.map((a) => ({ text: a.name, kind: "agent" as const, id: a.mark, also: a.label, agent: a })),
    ],
    [cowork.members, cowork.agents, me, people],
  );
  const q = closed ? null : atQuery(text, caret);
  const shown = q ? matchTargets(targets, q.query) : [];
  useEffect(() => setPick(0), [q?.query]);
  const ats = useMemo(() => mentionsIn(text, targets), [text, targets]);
  const routed = ats.agentMentions.map((k) => cowork.agents.find((a) => a.mark === k)).filter((a): a is CoworkAgent => !!a);
  const routeKey = routed.map((a) => `${a.mark}:${a.state}:${a.queued}`).join("|");

  const choose = (t: (typeof targets)[number]) => {
    if (!q) return;
    const next = `${text.slice(0, q.start)}@${t.text} ${text.slice(caret)}`;
    const at = q.start + t.text.length + 2;
    setText(next);
    setClosed(false);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
      setCaret(at);
    });
  };
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const r = await session.client.postCowork(cowork.id, { kind: "text", body, mentions: ats.mentions.length ? ats.mentions : undefined, agentMentions: ats.agentMentions.length ? ats.agentMentions : undefined, threadId: props.threadId, ...(replaces !== null ? { supersedes: replaces } : {}) });
      for (const d of r.deliveries ?? []) session.putDelivery(d);
      for (const e of r.events ?? []) session.putEvent(e);
      if (replaces !== null) {
        const n = ("superseded" in r && r.superseded ? r.superseded.seenByAgents.length : 0);
        toast(`#${replaces} 标成了「被 #${r.message?.seq ?? "新"} 取代」${n ? `，看过它的 ${n} 个 AI 会被提醒` : ""}`);
        setReplacing(null);
      }
      setText("");
      setRouteOff(null);
      props.onSent?.();
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const key = (e: KeyboardEvent) => {
    if (shown.length && q) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPick((p) => (p + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(shown[pick]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setClosed(true);
        return;
      }
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };
  const persons = shown.filter((t) => t.kind === "person");
  const agents = shown.filter((t) => t.kind === "agent");
  if (props.disabled) return <div className="dock composer cw-composer off muted">{props.disabled}</div>;
  return (
    <div className="cw-compose">
      {q && shown.length > 0 && (
        <div className="cw-atlist" role="listbox" aria-label="提及">
          <div className="cw-atlist-head">
            <span>提及</span>
            <span className="muted tiny">↑↓ 选 · Enter 确定 · 只有被 @ 的 AI 会被唤醒</span>
          </div>
          {persons.length > 0 && <div className="cw-atlist-sec">人</div>}
          {persons.map((t) => {
            const m = people.get(t.id);
            const i = shown.indexOf(t);
            return (
              <button key={t.id} type="button" role="option" aria-selected={i === pick} className="cw-at" onMouseDown={(e) => (e.preventDefault(), choose(t))} onMouseEnter={() => setPick(i)}>
                <Avatar name={t.id} small />
                <span className="cw-at-text">
                  <b>
                    <Who name={t.id} />
                  </b>
                  <span className="muted tiny">{m?.online ? "在线，会收到提醒" : "不在线，上线后看到"}</span>
                </span>
                <span className={`dot ${m?.online ? "on" : ""}`} />
              </button>
            );
          })}
          {agents.length > 0 && <div className="cw-atlist-sec">AI · 后面是它现在的状态，和 @ 它之后会怎样</div>}
          {agents.map((t) => {
            const a = t.agent!;
            const i = shown.indexOf(t);
            return (
              <button key={t.id} type="button" role="option" aria-selected={i === pick} className="cw-at" data-agent={a.mark} onMouseDown={(e) => (e.preventDefault(), choose(t))} onMouseEnter={() => setPick(i)}>
                <span className="avatar ai small">AI</span>
                <span className="cw-at-text">
                  <b>{a.name}</b>
                  <span className="muted tiny">{agentWhat(a)}</span>
                </span>
                <span className={`cw-chip st-${a.state}`}>{agentChip(a)}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className={`dock composer cw-composer ${(routed.length && routeOff !== routeKey) || replaces !== null ? "routed" : ""}`}>
        {replaces !== null && (
          <div className="cw-route cw-replacing" aria-label="取代">
            <span className="cw-route-k">取代</span>
            <span className="cw-route-v">
              发出后 #{replaces} 标成「被取代」，看过它的 AI 会被提醒
            </span>
            <button type="button" className="x" title="不取代了" onClick={() => setReplacing(null)}>
              ×
            </button>
          </div>
        )}
        {routed.length > 0 && routeOff !== routeKey && (
          <div className="cw-route" aria-label="去向">
            <span className="cw-route-k">去向</span>
            <span className="cw-route-v">
              {routed.map((a) =>
                // My own AI on this computer: a click goes to its session in Studio (2026-11-23).
                studioWhere(a.mark, a.owner, me, device) === "here" ? (
                  <button key={a.mark} type="button" className={`cw-route-ai st-${a.state}`} data-agent={a.mark} title="我的 AI：点一下在 Studio 里打开它的会话" onClick={() => void openStudio(a.mark, toast)}>
                    <b>{STATE_MARK_OF[a.state]}</b> {agentRoute(a)}
                    <span className="cw-route-go">在 Studio 里打开 ↗</span>
                  </button>
                ) : (
                  <span key={a.mark} className={`st-${a.state}`} data-agent={a.mark}>
                    <b>{STATE_MARK_OF[a.state]}</b> {agentRoute(a)}
                  </span>
                ),
              )}
            </span>
            <button type="button" className="x" title="知道了" onClick={() => setRouteOff(routeKey)}>
              ×
            </button>
          </div>
        )}
        <textarea
          ref={area}
          value={text}
          onChange={(e) => (setText(e.target.value), setCaret(e.target.selectionStart), setClosed(false))}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={key}
          placeholder={props.placeholder}
          rows={2}
          aria-label={props.placeholder}
        />
        <div className="acts">
          <button
            type="button"
            className="small ghost"
            onClick={() => {
              const at = area.current?.selectionStart ?? text.length;
              const next = `${text.slice(0, at)}${at && !/\s$/.test(text.slice(0, at)) ? " " : ""}@${text.slice(at)}`;
              setText(next);
              setClosed(false);
              const c = next.length - (text.length - at);
              requestAnimationFrame(() => (area.current?.focus(), area.current?.setSelectionRange(c, c), setCaret(c)));
            }}
          >
            @ 提及
          </button>
          {props.tools}
          <span className="why">{props.extra ?? `Ctrl+Enter 发送 · 只有被 @ 的 AI 会被唤醒${ats.mentions.length ? ` · 提醒 ${ats.mentions.length} 人` : ""}`}</span>
          <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => void send()}>
            发送
          </button>
        </div>
      </div>
    </div>
  );
}

const STATE_MARK_OF: Record<CoworkAgent["state"], string> = { idle: "✓", busy: "◐", owner: "!", offline: "○" };
export { STATE_WORD };
