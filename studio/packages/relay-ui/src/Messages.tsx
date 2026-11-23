import { useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Avatar, timeText, Who } from "./bits.js";
import { Markdown } from "./Markdown.js";
import { copyRef, openMenu, openStudio, RefsContext, studioWhere, type MenuItem } from "./RefChips.js";
import type { Session } from "./session.js";
import { RelayClientError, VERDICT_LABEL, type Message, type Question } from "./shared.js";

// The parts of a conversation both sessions and chats use: the message list (mine on the right, theirs on the left
// under their name, a session's state changes as a line in the middle) and the box to write in.

export const errorText = (err: unknown) => (err instanceof RelayClientError || err instanceof Error ? err.message : String(err));

/** A message, loaded and kept current; `null` while loading. */
export function useMessages(session: Session, threadId: string): { messages: Message[] | null; error: string | null } {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setMessages(null);
    setError(null);
    let alive = true;
    session.client
      .messages(threadId)
      .then((r) => alive && setMessages(r.messages))
      .catch((err) => alive && setError(errorText(err)));
    const off = session.onMessage((m) => {
      if (m.threadId !== threadId) return;
      setMessages((list) => (list && !list.some((x) => x.seq === m.seq) ? [...list, m] : list));
    });
    return () => {
      alive = false;
      off();
    };
  }, [session, threadId]);

  // Read while it is on screen and the window has focus.
  useEffect(() => {
    session.openThread = threadId;
    const read = () => document.hasFocus() && session.markRead(threadId);
    read();
    window.addEventListener("focus", read);
    return () => {
      window.removeEventListener("focus", read);
      if (session.openThread === threadId) session.openThread = null;
    };
  }, [session, threadId, messages?.length]);
  return { messages, error };
}

/** `refOf`: 复制引用 of a message (right click) — its words and what the toast calls it. */
export type MessageRefOf = (m: Message) => { text: string; what: string };

export function MessageList({ messages, error, me, questions, empty, after, refOf }: { messages: Message[] | null; error: string | null; me: string; questions: Question[]; empty: string; after?: ReactNode; refOf?: MessageRefOf }) {
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length]);
  return (
    <div className="messages" ref={scroller}>
      {error && <div className="notice error">{error}</div>}
      {!messages && !error && <div className="muted center">加载中…</div>}
      {messages?.length === 0 && <div className="muted center">{empty}</div>}
      {/* A reply answers the round of questions before it: the request's, or a follow-up's that asked more. */}
      {messages?.reduce<{ round: Question[]; out: ReactNode[] }>(
        (acc, m, i) => {
          if (m.questions?.length && m.kind !== "reply") acc.round = m.questions;
          acc.out.push(<MessageItem key={m.seq} m={m} prev={messages[i - 1]} me={me} questions={acc.round} refOf={refOf} />);
          return acc;
        },
        { round: questions, out: [] },
      ).out}
      {after}
    </div>
  );
}

/** @-ed names stand out (as bold) in the message. */
const boldMentions = (body: string, names: string[]) => names.reduce((s, n) => s.split(`@${n}`).join(`**@${n}**`), body);

/** A plain message right after one by the same person, within a few minutes: no header again. */
const CONTINUES_MS = 5 * 60_000;

/** A message's right-click menu: 复制引用, and 在 Studio 里打开 for my AI's (one on this computer). */
export function messageMenu(m: Message, me: string, refs: { device: string | null; toast: (t: string) => void } | null, refOf?: MessageRefOf): MenuItem[] {
  if (!refs) return [];
  const conv = m.via.kind === "ai" ? m.via.conv : null;
  const where = studioWhere(conv, m.author, me, refs.device);
  const r = refOf?.(m);
  return [
    r ? { label: "复制引用", hint: "贴进聊天或 AI 会话：人看到在哪，AI 认得 #编号 和会话", onClick: () => copyRef(r.text, r.what, refs.toast) } : null,
    where === "here" ? { label: "在 Studio 里打开", hint: "去这台电脑的 Studio 里，写这条的那个会话", onClick: () => void openStudio(conv!, refs.toast) } : null,
    where === "elsewhere" ? { label: "在另一台电脑上", disabled: true, hint: "写这条的 Studio 会话不在这台电脑上", onClick: () => undefined } : null,
  ];
}

function MessageItem({ m, prev, me, questions, refOf }: { m: Message; prev: Message | undefined; me: string; questions: Question[]; refOf?: MessageRefOf }) {
  const refs = useContext(RefsContext);
  if (m.kind === "event") {
    return (
      <div className="event" title={new Date(m.createdAt).toLocaleString()}>
        {m.author}
        {m.via.kind === "ai" ? " 的 AI" : ""} {m.body} · {timeText(m.createdAt)}
      </div>
    );
  }
  const byId = new Map(questions.map((q) => [q.id, q]));
  const mine = m.author === me;
  const continues = !!prev && prev.author === m.author && m.kind === "text" && prev.kind === "text" && m.via.kind === prev.via.kind && m.createdAt - prev.createdAt < CONTINUES_MS;
  const ai = m.via.kind === "ai";
  // Layout A (2026-11-23): everyone on the left, a picture and a name line first — an AI's words with the AI's mark,
  // mine with 「我」 and a tinted body.
  return (
    <article className={`msg ${mine ? "mine" : "theirs"} kind-${m.kind} ${continues ? "continues" : ""}`} data-seq={m.seq} onContextMenu={(e) => openMenu(e, messageMenu(m, me, refs, refOf))}>
      <div className="msg-av">{!continues && (ai ? <span className="avatar ai" title={`${m.author} 的 AI`}>AI</span> : <Avatar name={m.author} />)}</div>
      <div className="msg-col">
      <div className="msg-head">
        <b>
          <Who name={m.author} />
          {ai ? " 的 AI" : ""}
        </b>
        {mine && <span className="me-tag">我</span>}
        {m.via.kind === "ai" && <span className="tag ai">AI 代发{m.via.client ? ` · ${m.via.client}` : ""}</span>}
        {m.kind === "request" && <span className="tag">会话</span>}
        {m.kind === "text" && m.questions && m.questions.length > 0 && <span className="tag">追问</span>}
        {m.kind === "reply" && <span className="tag">回复</span>}
        <span className="tm" title={new Date(m.createdAt).toLocaleString()}>
          {timeText(m.createdAt)}
        </span>
      </div>
      <div className="msg-body">
        {m.body && <Markdown source={m.mentions?.length ? boldMentions(m.body, m.mentions) : m.body} />}
        {m.kind !== "reply" && m.questions && m.questions.length > 0 && (
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
        {m.kind === "reply" && m.answers && m.answers.length > 0 && (
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
        {m.kind === "reply" && m.verdict && <div className={`verdict v-${m.verdict}`}>结论：{VERDICT_LABEL[m.verdict]}</div>}
        {m.notes && m.notes.length > 0 && (
          <div className="notes-in">
            <div className="tag">附上的批注 · {m.notes.length}</div>
            {m.notes.map((n) => (
              <div key={n.noteId} className="nq">
                <span className="quote">
                  {n.file} v{n.version}：{n.quote}
                </span>
                {n.body}
              </div>
            ))}
          </div>
        )}
      </div>
      </div>
    </article>
  );
}

/**
 * The box under a conversation. `pass` hands a session to the other side with the message (继续追问); `extra` sits
 * before the send button (标记完成 and the like), `hint` at the left.
 */
export function Composer(props: { session: Session; threadId: string; placeholder: string; pass?: boolean; sendLabel?: string; extra?: ReactNode; hint?: ReactNode; onSent?: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(""), [props.threadId]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.session.client.send(props.threadId, { kind: "text", body, pass: props.pass || undefined });
      setText("");
      props.onSent?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };
  return (
    <div className="dock composer">
      <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={key} placeholder={props.placeholder} rows={2} />
      <div className="acts">
        <span className="why">{error ? <span className="error">{error}</span> : (props.hint ?? "Ctrl+Enter 发送 · 支持 Markdown")}</span>
        {props.extra}
        <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => void send()}>
          {props.sendLabel ?? "发送"}
        </button>
      </div>
    </div>
  );
}
