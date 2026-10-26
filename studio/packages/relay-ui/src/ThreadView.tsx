import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { copyText } from "./env.js";
import { Markdown } from "./Markdown.js";
import type { Session } from "./session.js";
import { RelayClientError, VERDICT_LABEL, threadAsText, type Answer, type Message, type Question, type ThreadView as Thread, type Verdict } from "./shared.js";
import { RequestStatus, Avatar, timeText } from "./bits.js";

// One conversation: a direct chat, or a request with its replies. The person asked answers the questions one by one
// (an option and/or their own words), adds a note and a verdict; anyone in it can write a plain message.

const errorText = (err: unknown) => (err instanceof RelayClientError || err instanceof Error ? err.message : String(err));

export function ThreadView({ session, thread, toast }: { session: Session; thread: Thread; toast: (text: string) => void }) {
  const me = session.me.name;
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const request = thread.request;
  const canReply = !!request && request.to === me;

  useEffect(() => {
    setMessages(null);
    setError(null);
    setReplying(false);
    let alive = true;
    session.client
      .messages(thread.id)
      .then((r) => alive && setMessages(r.messages))
      .catch((err) => alive && setError(errorText(err)));
    const off = session.onMessage((m) => {
      if (m.threadId !== thread.id) return;
      setMessages((list) => (list && !list.some((x) => x.seq === m.seq) ? [...list, m] : list));
    });
    return () => {
      alive = false;
      off();
    };
  }, [session, thread.id]);

  // Read while it is on screen and the window has focus.
  useEffect(() => {
    session.openThread = thread.id;
    const read = () => document.hasFocus() && session.markRead(thread.id);
    read();
    window.addEventListener("focus", read);
    return () => {
      window.removeEventListener("focus", read);
      if (session.openThread === thread.id) session.openThread = null;
    };
  }, [session, thread.id, thread.lastSeq]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length]);

  const requestMessage = messages?.find((m) => m.kind === "request");
  const questions = requestMessage?.questions ?? [];
  const answered = request?.status === "answered";
  const showForm = canReply && (!answered || replying);
  const other = thread.members.find((n) => n !== me) ?? me;
  const online = session.snapshot.members.find((m) => m.name === other)?.online;

  const copyAll = async () => {
    if (!messages) return;
    await copyText(threadAsText(thread, messages));
    toast(request ? "已复制，可以直接贴给 AI" : "已复制对话");
  };

  return (
    <section className="thread">
      <header className="thread-head">
        <div className="thread-title">
          {request ? (
            <>
              <h2>{thread.title}</h2>
              <div className="muted small">
                {request.from} → {request.to} · <RequestStatus thread={thread} me={me} />
              </div>
            </>
          ) : (
            <>
              <h2>{other}</h2>
              <div className="muted small">{online ? <span className="online-dot">在线</span> : "不在线"} · 私聊</div>
            </>
          )}
        </div>
        <div className="thread-actions">
          <button type="button" onClick={() => void copyAll()} title="复制整个对话（含逐条回答），贴给 AI">
            {request ? "复制给 AI" : "复制对话"}
          </button>
        </div>
      </header>

      <div className="messages" ref={scroller}>
        {error && <div className="notice error">{error}</div>}
        {!messages && !error && <div className="muted center">加载中…</div>}
        {messages?.length === 0 && <div className="muted center">还没有消息，说点什么吧。</div>}
        {messages?.map((m) => <MessageItem key={m.seq} m={m} me={me} questions={questions} />)}
      </div>

      {showForm && requestMessage && (
        <ReplyForm
          session={session}
          threadId={thread.id}
          questions={questions}
          again={answered}
          onDone={() => (setReplying(false), toast("回复已发出"))}
          onCancel={answered ? () => setReplying(false) : undefined}
        />
      )}
      {canReply && answered && !replying && (
        <div className="reply-again">
          <button type="button" onClick={() => setReplying(true)}>
            再回复一次（逐条回答 / 改结论）
          </button>
        </div>
      )}
      <Composer session={session} threadId={thread.id} placeholder={request ? (canReply ? "追问或补充…（也可以用上面的表单逐条回答）" : "追问或补充…") : `发给 ${other}…`} />
    </section>
  );
}

function MessageItem({ m, me, questions }: { m: Message; me: string; questions: Question[] }) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  return (
    <article className={`msg ${m.author === me ? "mine" : ""} kind-${m.kind}`}>
      <div className="msg-head">
        <Avatar name={m.author} />
        <b>{m.author}</b>
        {m.via.kind === "ai" && <span className="tag ai">AI 代发{m.via.client ? ` · ${m.via.client}` : ""}</span>}
        {m.kind === "request" && <span className="tag">请求</span>}
        {m.kind === "reply" && <span className="tag reply">回复</span>}
        <span className="muted tiny" title={new Date(m.createdAt).toLocaleString()}>
          {timeText(m.createdAt)}
        </span>
      </div>
      <div className="msg-body">
        {m.body && <Markdown source={m.body} />}
        {m.kind === "request" && m.questions && m.questions.length > 0 && (
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
      </div>
    </article>
  );
}

function ReplyForm(props: { session: Session; threadId: string; questions: Question[]; again: boolean; onDone: () => void; onCancel?: () => void }) {
  const { session, threadId, questions } = props;
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answers = useMemo<Answer[]>(
    () =>
      questions
        .map((q) => ({ questionId: q.id, choice: choice[q.id] || undefined, text: texts[q.id]?.trim() || undefined }))
        .filter((a) => a.choice || a.text),
    [questions, choice, texts],
  );
  const empty = !answers.length && !note.trim() && !verdict;

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await session.client.send(threadId, { kind: "reply", answers, body: note.trim(), verdict: verdict ?? undefined });
      props.onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="reply-form">
      <div className="reply-form-head">
        <b>{props.again ? "再回复一次" : "回复这个请求"}</b>
        <span className="muted tiny">逐条回答，最后给个结论；不需要的可以空着</span>
      </div>
      {questions.map((q, i) => (
        <div key={q.id} className="rq">
          <div className="rq-text">
            <span className="rq-n">{i + 1}</span>
            {q.text}
          </div>
          {q.options && (
            <div className="options">
              {q.options.map((o) => (
                <button key={o} type="button" className={`opt ${choice[q.id] === o ? "on" : ""}`} onClick={() => setChoice((c) => ({ ...c, [q.id]: c[q.id] === o ? "" : o }))}>
                  {o}
                </button>
              ))}
            </div>
          )}
          <input value={texts[q.id] ?? ""} onChange={(e) => setTexts((t) => ({ ...t, [q.id]: e.target.value }))} placeholder={q.options ? "补充说明，或写自己的答案" : "你的回答"} />
        </div>
      ))}
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="补充说明（支持 Markdown）" rows={2} />
      <div className="reply-form-foot">
        <div className="verdicts">
          {(Object.keys(VERDICT_LABEL) as Verdict[]).map((v) => (
            <button key={v} type="button" className={`vbtn v-${v} ${verdict === v ? "on" : ""}`} onClick={() => setVerdict(verdict === v ? null : v)}>
              {VERDICT_LABEL[v]}
            </button>
          ))}
        </div>
        <div className="grow" />
        {error && <span className="error tiny">{error}</span>}
        {props.onCancel && (
          <button type="button" onClick={props.onCancel}>
            取消
          </button>
        )}
        <button type="button" className="primary" disabled={busy || empty} onClick={() => void send()}>
          发送回复
        </button>
      </div>
    </div>
  );
}

function Composer({ session, threadId, placeholder }: { session: Session; threadId: string; placeholder: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(""), [threadId]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await session.client.send(threadId, { kind: "text", body });
      setText("");
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
    <div className="composer">
      <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={key} placeholder={placeholder} rows={3} />
      <div className="composer-foot">
        {error ? <span className="error tiny">{error}</span> : <span className="muted tiny">Ctrl+Enter 发送 · 支持 Markdown</span>}
        <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => void send()}>
          发送
        </button>
      </div>
    </div>
  );
}
