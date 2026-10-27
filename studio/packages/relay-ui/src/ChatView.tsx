import { useEffect, useRef, useState } from "react";
import { copyText } from "./env.js";
import { Composer, MessageList, errorText, useMessages } from "./Messages.js";
import type { Session } from "./session.js";
import { threadAsText, type ThreadView as Thread } from "./shared.js";

// A chat with someone: the plain one (always there) or a topic next to it, as tabs over the conversation; a new topic
// from there. 复制对话 copies just the one open. Topics can be archived (my list only; a new message brings one back).

export function ChatView(props: {
  session: Session;
  thread: Thread;
  /** The chats with the same person (the plain one and topics), for the tabs. */
  peers: Thread[];
  toast: (text: string) => void;
  onOpen: (threadId: string) => void;
  onChatWith: (name: string) => void;
  onNewTopic: (other: string, title: string) => Promise<void>;
  onArchive: (thread: Thread, archived: boolean) => void;
}) {
  const { session, thread, toast } = props;
  const me = session.me.name;
  const { messages, error } = useMessages(session, thread.id);
  const other = thread.members.find((n) => n !== me) ?? me;
  const online = session.snapshot.members.find((m) => m.name === other)?.online;

  const copyAll = async () => {
    if (!messages) return;
    await copyText(threadAsText(thread, messages));
    toast("已复制这个对话，可以贴给 AI");
  };

  return (
    <section className="view" aria-label={other}>
      <header className="page-head with-tabs">
        <div className="head-main">
          <div className="page-crumb">聊天</div>
          <h1 className="head-title">{other}</h1>
          <div className="head-meta">
            <span className={`conn-chip ${online ? "online" : ""}`}>
              <span className="conn-dot" />
              {online ? "在线" : "不在线"}
            </span>
            {thread.archived && <span className="chip">已归档</span>}
          </div>
        </div>
        <div className="head-actions">
          {thread.kind !== "direct" && (
            <button type="button" onClick={() => props.onArchive(thread, !thread.archived)} title={thread.archived ? "放回左边的列表" : "收起到「已归档」，只影响你自己；有新消息会回来"}>
              {thread.archived ? "放回列表" : "归档"}
            </button>
          )}
          <button type="button" onClick={() => void copyAll()} title="复制这个对话（只有当前这个话题），贴给 AI">
            复制对话
          </button>
        </div>
      </header>
      <TopicTabs thread={thread} peers={props.peers} other={other} onOpen={props.onOpen} onChatWith={props.onChatWith} onNewTopic={props.onNewTopic} />
      <MessageList messages={messages} error={error} me={me} questions={[]} empty={thread.kind === "topic" ? `新话题「${thread.title}」，说点什么吧。` : "还没有消息，说点什么吧。"} />
      <Composer session={session} threadId={thread.id} placeholder={thread.kind === "topic" ? `发给 ${other}，话题「${thread.title}」…` : `发给 ${other}…`} />
    </section>
  );
}

/** The plain chat first, then the topics in the order they were opened; ＋ 新话题 at the end. */
function TopicTabs(props: { thread: Thread; peers: Thread[]; other: string; onOpen: (id: string) => void; onChatWith: (name: string) => void; onNewTopic: (other: string, title: string) => Promise<void> }) {
  const direct = props.peers.find((t) => t.kind === "direct");
  const topics = props.peers.filter((t) => t.kind === "topic").sort((a, b) => a.createdAt - b.createdAt);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);

  // A block, not an arrow's value: scrollIntoView returns a promise in newer Chromium, which React would take for cleanup.
  useEffect(() => {
    void bar.current?.querySelector(".tab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [props.thread.id]);

  const start = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onNewTopic(props.other, title.trim());
      setAdding(false);
      setTitle("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => (setAdding(false), setTitle(""), setError(null));
  const badge = (t: Thread | undefined) => (t && t.unread > 0 && t.id !== props.thread.id ? <span className="badge">{t.unread}</span> : null);

  return (
    <div className="tabs" ref={bar} role="tablist">
      <button type="button" role="tab" className={`tab ${props.thread.kind === "direct" ? "on" : ""}`} aria-selected={props.thread.kind === "direct"} onClick={() => (direct ? props.onOpen(direct.id) : props.onChatWith(props.other))} title="和对方的普通聊天，一直都在">
        普通聊天
        {badge(direct)}
      </button>
      {topics.map((t) => (
        <button key={t.id} type="button" role="tab" className={`tab ${t.id === props.thread.id ? "on" : ""}`} aria-selected={t.id === props.thread.id} onClick={() => props.onOpen(t.id)} title={t.title}>
          <span className="tab-title">{t.title}</span>
          {t.archived && <span className="tag">已归档</span>}
          {badge(t)}
        </button>
      ))}
      {adding ? (
        <form
          className="tab-new"
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
        >
          <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Escape" && cancel()} placeholder="话题，比如：技能表结构" maxLength={200} autoFocus />
          <button type="submit" className="primary small" disabled={busy || !title.trim()}>
            开始
          </button>
          <button type="button" className="small" onClick={cancel}>
            取消
          </button>
          {error && <span className="error tiny">{error}</span>}
        </form>
      ) : (
        <button type="button" className="tab add" onClick={() => setAdding(true)} title={`和 ${props.other} 开一个新话题：每个话题单独记录，可以单独复制给 AI、单独归档`}>
          ＋ 新话题
        </button>
      )}
    </div>
  );
}
