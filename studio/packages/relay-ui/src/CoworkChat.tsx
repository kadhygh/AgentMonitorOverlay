import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { agentChip, agentRoute, agentWhat, atQuery, deliverySteps, matchTargets, mentionsIn, STATE_WORD, type MentionTarget } from "./coworkText.js";
import { Avatar, timeText, useDisplayName, usePeople, Who } from "./bits.js";
import { Markdown } from "./Markdown.js";
import { errorText } from "./Messages.js";
import type { CoworkData, Session } from "./session.js";
import type { CoworkAgent, CoworkDraft, CoworkEvent, CoworkListItem, CoworkSession, Message, Question } from "./shared.js";

// A 协作's conversation (2026-11-23, plans/cowork.md「人输入时看到的 agent 状态」, prototype A): its 群聊 or a 子会话 —
// people and the AIs they brought in, a 子会话 folded into a card where it was started, the cowork's events as lines,
// under each message of mine where it went to each AI @-ed (排队中 → 已送达 → 已回复), an AI's answer quoting what it
// answers (「↳ 回 美术小周」), my AIs' drafts only I see; new messages while I type or read further up do not move the
// list, a bar says how many came. The box to write in shows each AI's state in its @ list and, once one is @-ed, where
// the message will go.

export interface CoworkCtx {
  session: Session;
  cowork: CoworkListItem;
  data: CoworkData;
  me: string;
  /** Opens a 子会话's window. */
  openSub: (threadId: string) => void;
  /** Opens the 白板 (on a 子会话's card). */
  openBoard: (session?: string) => void;
  toast: (t: string) => void;
}
export const CoworkContext = createContext<CoworkCtx | null>(null);
export const useCowork = (): CoworkCtx => {
  const c = useContext(CoworkContext);
  if (!c) throw new Error("useCowork outside a 协作");
  return c;
};

export const agentOf = (cowork: { agents: CoworkAgent[] }, mark: string | undefined | null) => (mark ? (cowork.agents.find((a) => a.mark === mark) ?? null) : null);

/** A 子会话's state in words: 开着 / 等某人（等你, when it is me） / 已定. */
export function subState(s: CoworkSession, show: (n: string) => string, me?: string): { word: string; cls: string } {
  if (s.state === "done") return { word: "✓ 已定", cls: "done" };
  if (s.waitingOn) return { word: s.waitingOn === me ? "! 等你" : `! 等${show(s.waitingOn)}`, cls: "wait" };
  return { word: "◐ 开着", cls: "open" };
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
                    白板上 {run.events.length} 处改动（{who.slice(0, 3).join("、")}
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
            if (m.kind === "event" && m.session) return <SessionCard key={m.seq} threadId={m.session} at={m.createdAt} by={m.author} via={m.via} />;
            if (m.kind === "event")
              return (
                <div key={m.seq} className="event" title={new Date(m.createdAt).toLocaleString()}>
                  {agentOf(cowork, m.via.kind === "ai" ? m.via.conv : null)?.name ?? show(m.author)} {m.body} · {timeText(m.createdAt)}
                </div>
              );
            const prev = rows[i - 1]?.m;
            return <CoworkMessage key={m.seq} m={m} prev={prev} replied={m.replyTo ? bySeq.get(m.replyTo) : undefined} me={me} questions={round.current} />;
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

function CoworkMessage({ m, prev, replied, me, questions }: { m: Message; prev: Message | undefined; replied: Message | undefined; me: string; questions: Question[] }) {
  const { cowork } = useCowork();
  const show = useDisplayName();
  const ai = m.via.kind === "ai";
  const agent = ai ? agentOf(cowork, m.via.kind === "ai" ? m.via.conv : null) : null;
  const mine = m.author === me && !ai;
  const continues = !!prev && prev.author === m.author && prev.kind === "text" && m.kind === "text" && prev.via.kind === m.via.kind && (prev.via.kind !== "ai" || m.via.kind !== "ai" || prev.via.conv === m.via.conv) && !m.replyTo && m.createdAt - prev.createdAt < CONTINUES_MS;
  const byId = new Map(questions.map((q) => [q.id, q]));
  const atNames = [...(m.mentions ?? []), ...(m.agentMentions ?? []).map((k) => agentOf(cowork, k)?.name ?? "")].filter(Boolean);
  const repliedWho = replied ? `${show(replied.author)}${replied.via.kind === "ai" ? " 的 AI" : ""}` : null;
  return (
    <article id={`msg-${m.seq}`} className={`msg ${mine ? "mine" : "theirs"} kind-${m.kind} ${continues ? "continues" : ""} ${ai ? "by-ai" : ""}`}>
      <div className="msg-av">{!continues && (ai ? <span className="avatar ai" title={agent?.name ?? `${m.author} 的 AI`}>AI</span> : <Avatar name={m.author} />)}</div>
      <div className="msg-col">
        <div className="msg-head">
          <b>
            <Who name={m.author} />
            {ai ? " 的 AI" : ""}
          </b>
          {agent && <span className="tag agent-label">{agent.label}</span>}
          {repliedWho && <span className="cw-reply-to">↳ 回 {repliedWho}</span>}
          {mine && <span className="me-tag">我</span>}
          {m.approvedBy && <span className="tag">{m.edited ? `${show(m.approvedBy)} 改过后发出` : `${show(m.approvedBy)} 确认后发出`}</span>}
          {m.kind === "request" && <span className="tag">子会话</span>}
          {m.kind === "text" && !!m.questions?.length && <span className="tag">追问</span>}
          {m.kind === "reply" && <span className="tag">回答</span>}
          <span className="tm" title={new Date(m.createdAt).toLocaleString()}>
            {timeText(m.createdAt)}
          </span>
        </div>
        {replied && (
          <button type="button" className="msg-quote" title="跳到这条" onClick={() => document.getElementById(`msg-${replied.seq}`)?.scrollIntoView({ block: "center" })}>
            {show(replied.author)}
            {replied.via.kind === "ai" ? " 的 AI" : ""}：{replied.body.replace(/\s+/g, " ").slice(0, 140)}
          </button>
        )}
        <div className="msg-body">
          {m.body && <Markdown source={atNames.length ? boldAts(m.body, atNames) : m.body} />}
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
        {mine && !!m.agentMentions?.length && <DeliveryTrail m={m} />}
      </div>
    </article>
  );
}

/** Under a message of mine that @-ed AIs: where it went to each (排队中 → 已送达 → 已回复). */
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
              <button type="button" className="link tiny" onClick={() => document.getElementById(`msg-${d.replySeq}`)?.scrollIntoView({ block: "center" })}>
                看回复 ↓
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A 子会话 folded into a card in the 群聊, where it was started; it moves on in place. A click opens its window. */
export function SessionCard({ threadId, at, by, via }: { threadId: string; at: number; by: string; via: Message["via"] }) {
  const { cowork, session, openSub, me } = useCowork();
  const show = useDisplayName();
  const s = cowork.sessions.find((x) => x.id === threadId);
  const t = session.snapshot.threads.find((x) => x.id === threadId);
  if (!s)
    return (
      <div className="event">
        {show(by)} 发起了一个子会话 · {timeText(at)}
      </div>
    );
  const st = subState(s, show, me);
  const asker = s.agent ? (agentOf(cowork, s.agent)?.name ?? `${show(s.from)} 的 AI`) : show(s.from);
  return (
    <button type="button" className={`cw-subcard ${st.cls}`} data-session={s.id} onClick={() => openSub(s.id)} title="点开这个子会话（弹窗，可以同时开几个）">
      <span className="cw-subcard-top">
        <span className="tag">子会话</span>
        <span className="cw-subcard-title">{s.title}</span>
        <span className={`cw-state ${st.cls}`}>{st.word}</span>
        {!!t?.unread && <span className="badge">{t.unread}</span>}
      </span>
      <span className="cw-subcard-sub">
        {asker}
        {via.kind === "ai" ? "" : ""} → {show(s.to)} · {timeText(at)}
        {s.conclusion ? ` · 结论：${s.conclusion}` : ""}
      </span>
    </button>
  );
}

/** My AI's draft (only I see it): 发出 / 改一下再发 / 不发. */
export function DraftCard({ draft }: { draft: CoworkDraft }) {
  const { cowork, session, toast } = useCowork();
  const show = useDisplayName();
  const agent = agentOf(cowork, draft.agent);
  const body = draft.kind === "ask" ? (draft.ask?.body ?? "") : (draft.post?.body ?? "");
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(body);
  const [busy, setBusy] = useState(false);
  const decide = async (action: "send" | "drop", edit?: string) => {
    setBusy(true);
    try {
      const d = await session.client.decideCoworkDraft(cowork.id, draft.id, { action, edit: edit != null ? { body: edit } : undefined });
      session.putDraft(d);
      toast(action === "drop" ? "草稿不发了" : "已发出");
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const ats = [...(draft.post?.mentions ?? []).map(show), ...(draft.post?.agentMentions ?? []).map((k) => agentOf(cowork, k)?.name ?? "AI")];
  return (
    <div className="cw-draft" data-draft={draft.id}>
      <div className="cw-draft-head">
        <span className="tag">AI 草稿</span>
        <b>{agent?.name ?? "我的 AI"}</b>
        <span className="muted tiny">{draft.kind === "ask" ? `想发起子会话「${draft.ask?.title ?? ""}」→ ${show(draft.ask?.to ?? "")}` : ats.length ? `想发给 @${ats.join("、@")}` : "想发一条"} · 只有你看得到 · {timeText(draft.createdAt)}</span>
      </div>
      {editing ? <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} aria-label="改草稿" /> : <div className="msg-body">{body ? <Markdown source={body} /> : <span className="muted">（没有正文）</span>}</div>}
      <div className="cw-draft-foot">
        <span className="muted tiny">这个协作关着「AI 发起 @ 和提问」，你确认了才发出。</span>
        <span className="grow" />
        {editing ? (
          <>
            <button type="button" className="small" onClick={() => (setEditing(false), setText(body))}>
              取消
            </button>
            <button type="button" className="small primary" disabled={busy || !text.trim()} onClick={() => void decide("send", text.trim())}>
              改好了，发出
            </button>
          </>
        ) : (
          <>
            <button type="button" className="small primary" disabled={busy} onClick={() => void decide("send")}>
              发出
            </button>
            <button type="button" className="small" disabled={busy} onClick={() => setEditing(true)}>
              改一下再发
            </button>
            <button type="button" className="small ghost" disabled={busy} onClick={() => void decide("drop")}>
              不发
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The box under a 协作's 群聊 or 子会话. @ opens the list — people, then the AIs each with its state and what an @ does
 * now; an AI @-ed shows the line over the box saying where this goes. `onTyping` tells the list above to keep still.
 */
export function CoworkComposer(props: { threadId?: string; placeholder: string; onTyping?: (on: boolean) => void; extra?: ReactNode; tools?: ReactNode; disabled?: string | null; onSent?: () => void; draftKey?: string }) {
  const { cowork, session, me, toast } = useCowork();
  const people = usePeople();
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
      ...cowork.members.filter((n) => n !== me).map((n) => ({ text: n, kind: "person" as const, id: n, also: people.get(n)?.nick })),
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
      const r = await session.client.postCowork(cowork.id, { kind: "text", body, mentions: ats.mentions.length ? ats.mentions : undefined, agentMentions: ats.agentMentions.length ? ats.agentMentions : undefined, threadId: props.threadId });
      for (const d of r.deliveries ?? []) session.putDelivery(d);
      for (const e of r.events ?? []) session.putEvent(e);
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
      <div className={`dock composer cw-composer ${routed.length && routeOff !== routeKey ? "routed" : ""}`}>
        {routed.length > 0 && routeOff !== routeKey && (
          <div className="cw-route" aria-label="去向">
            <span className="cw-route-k">去向</span>
            <span className="cw-route-v">
              {routed.map((a) => (
                <span key={a.mark} className={`st-${a.state}`}>
                  <b>{STATE_MARK_OF[a.state]}</b> {agentRoute(a)}
                </span>
              ))}
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
