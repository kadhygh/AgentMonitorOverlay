import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Avatar, preview, timeText, useDisplayName, Who } from "./bits.js";
import { Dialog, Field } from "./Dialog.js";
import { copyText } from "./env.js";
import { MessageList, errorText, useMessages } from "./Messages.js";
import { useSession, type Session } from "./session.js";
import { threadAsText, type Member, type ThreadView as Thread } from "./shared.js";

// Chats (2026-10-27): on the left, one entry per person — under it the plain chat, the topics, and the groups they are
// in (a group shows under each of its people); a topic starts there too. A chat @-ing someone who is not in it brings
// them in, and a direct chat or topic becomes a group with its history (asked first). 成员 lists every group.

const isChat = (t: Thread) => t.kind === "direct" || t.kind === "topic" || t.kind === "group";

/** The left column of 聊天: people, each with their chats and groups. */
export function ChatTree(props: {
  session: Session;
  openId: string | null;
  onOpen: (id: string) => void;
  onChatWith: (name: string) => void;
  onNewTopic: (other: string, title: string) => Promise<void>;
  onArchive: (t: Thread, archived: boolean) => void;
}) {
  const { threads, members } = useSession(props.session);
  const me = props.session.me.name;
  const chats = threads.filter((t) => isChat(t));
  const live = chats.filter((t) => !t.archived);
  const archived = chats.filter((t) => t.archived);
  const others = members.filter((m) => m.name !== me);
  // People with recent chats first.
  const lastAt = (name: string) => Math.max(0, ...live.filter((t) => t.members.includes(name)).map((t) => t.updatedAt));
  const people = [...others].sort((a, b) => lastAt(b.name) - lastAt(a.name));
  const [open, setOpen] = useState<Set<string>>(() => new Set(people.filter((p) => lastAt(p.name) > 0).map((p) => p.name)));
  const [adding, setAdding] = useState<string | null>(null);
  const [archOpen, setArchOpen] = useState(false);
  const current = threads.find((t) => t.id === props.openId);
  // The open chat's people stay unfolded.
  useEffect(() => {
    if (current) setOpen((s) => new Set([...s, ...current.members.filter((n) => n !== me)]));
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (name: string) => setOpen((s) => (s.has(name) ? new Set([...s].filter((x) => x !== name)) : new Set([...s, name])));
  return (
    <>
      <div className="nav-label">
        聊天<span className="count">{others.length}</span>
        <span className="rule" />
      </div>
      {people.map((p) => {
        const mine = live.filter((t) => t.members.includes(p.name));
        const direct = mine.find((t) => t.kind === "direct");
        const topics = mine.filter((t) => t.kind === "topic").sort((a, b) => a.createdAt - b.createdAt);
        const groups = mine.filter((t) => t.kind === "group");
        const unread = mine.reduce((n, t) => n + t.unread, 0);
        const unfolded = open.has(p.name);
        return (
          <div key={p.name} className="person-node">
            <button type="button" className="nav-row person-head-row" onClick={() => toggle(p.name)} aria-expanded={unfolded}>
              <span className="name">
                <span className="fold">{unfolded ? "▾" : "▸"}</span>
                <Avatar name={p.name} small />
                <span className="ellipsis">
                  <Who name={p.name} />
                </span>
              </span>
              {unread > 0 && !unfolded && <span className="badge">{unread}</span>}
              <span className={`dot ${p.online ? "on" : ""}`} title={p.online ? "在线" : "不在线"} />
            </button>
            {unfolded && (
              <div className="person-kids">
                <ChatRow label="普通聊天" thread={direct} current={!!direct && direct.id === props.openId} onClick={() => (direct ? props.onOpen(direct.id) : props.onChatWith(p.name))} />
                {topics.map((t) => (
                  <ChatRow key={t.id} label={t.title} tag="话题" thread={t} current={t.id === props.openId} onClick={() => props.onOpen(t.id)} onArchive={() => props.onArchive(t, true)} />
                ))}
                {adding === p.name ? (
                  <NewTopic other={p.name} onDone={() => setAdding(null)} onNewTopic={props.onNewTopic} />
                ) : (
                  <button type="button" className="kid-add" onClick={() => setAdding(p.name)}>
                    ＋ 新话题
                  </button>
                )}
                {groups.length > 0 && <div className="kid-label">群聊 · {groups.length}</div>}
                {groups.map((t) => (
                  <ChatRow key={t.id} label={t.title} tag={`${t.members.length} 人`} thread={t} current={t.id === props.openId} onClick={() => props.onOpen(t.id)} onArchive={() => props.onArchive(t, true)} group />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {!others.length && <div className="nav-empty">还没有其他人。把服务器的地址发给同事，让他们注册。</div>}
      {archived.length > 0 && (
        <>
          <button type="button" className="nav-fold" onClick={() => setArchOpen(!archOpen)}>
            {archOpen ? "▾" : "▸"} 已归档 {archived.length}
          </button>
          {archOpen &&
            archived.map((t) => (
              <ChatRow key={t.id} label={t.title || "普通聊天"} tag={t.kind === "group" ? "群聊" : "话题"} thread={t} current={t.id === props.openId} onClick={() => props.onOpen(t.id)} onArchive={() => props.onArchive(t, false)} archived />
            ))}
        </>
      )}
    </>
  );
}

function ChatRow(props: { label: string; tag?: string; thread?: Thread; current: boolean; onClick: () => void; onArchive?: () => void; group?: boolean; archived?: boolean }) {
  const t = props.thread;
  return (
    <div className="srow-wrap">
      <button type="button" className={`srow kid ${t?.unread ? "unread" : ""}`} aria-current={props.current ? "true" : undefined} onClick={props.onClick}>
        <div className="srow-top">
          {props.group && <span className="group-mark">群</span>}
          <span className="srow-title">{props.label}</span>
          {props.tag && <span className="tag">{props.tag}</span>}
          {t && t.unread > 0 && <span className="badge">{t.unread}</span>}
          {t && <span className="srow-time">{timeText(t.updatedAt)}</span>}
        </div>
        {t?.last && (
          <div className="srow-meta">
            <span className="t">{preview(t.last)}</span>
          </div>
        )}
      </button>
      {props.onArchive && (
        <button type="button" className="small srow-archive" title={props.archived ? "放回列表" : "归档：从列表收起，只影响你自己；有新消息会回来"} onClick={props.onArchive}>
          {props.archived ? "放回" : "归档"}
        </button>
      )}
    </div>
  );
}

function NewTopic({ other, onDone, onNewTopic }: { other: string; onDone: () => void; onNewTopic: (other: string, title: string) => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await onNewTopic(other, title.trim());
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <form
      className="kid-new"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onDone()} placeholder="话题，比如：技能表结构" autoFocus />
      <button type="submit" className="small primary" disabled={busy || !title.trim()}>
        开始
      </button>
      {error && <span className="error tiny">{error}</span>}
    </form>
  );
}

/** Every group I am in, for 成员. */
export function GroupRows({ session, onOpen }: { session: Session; onOpen: (id: string) => void }) {
  const { threads } = useSession(session);
  const groups = threads.filter((t) => t.kind === "group").sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <>
      <div className="nav-label">
        群聊<span className="count">{groups.length}</span>
        <span className="rule" />
      </div>
      {groups.map((t) => (
        <ChatRow key={t.id} label={t.title} tag={`${t.members.length} 人`} thread={t} current={false} onClick={() => onOpen(t.id)} group archived={t.archived} />
      ))}
      {!groups.length && <div className="nav-empty">还没有群聊。在聊天里 @ 别人，就会把这个对话变成群聊。</div>}
    </>
  );
}

/** A chat: the plain one with someone, a topic, or a group. */
export function ChatView({ session, thread, toast, onArchive }: { session: Session; thread: Thread; toast: (text: string) => void; onArchive: (thread: Thread, archived: boolean) => void }) {
  const me = session.me.name;
  const { members } = useSession(session);
  const show = useDisplayName();
  const { messages, error } = useMessages(session, thread.id);
  const other = thread.members.find((n) => n !== me) ?? me;
  const online = members.find((m) => m.name === other)?.online;
  const [dialog, setDialog] = useState<"add" | "rename" | null>(null);
  const group = thread.kind === "group";

  const copyAll = async () => {
    if (!messages) return;
    await copyText(threadAsText(thread, messages));
    toast("已复制这个对话，可以贴给 AI");
  };
  const leave = async () => {
    try {
      await session.client.leave(thread.id);
      toast(`已退出「${thread.title}」`);
    } catch (err) {
      toast(errorText(err));
    }
  };

  return (
    <section className="view" aria-label={group ? thread.title : other}>
      <header className="page-head">
        <div className="head-main">
          <div className="page-crumb">{group ? "群聊" : thread.kind === "topic" ? <>和 <Who name={other} /> 的话题</> : "普通聊天"}</div>
          <h1 className="head-title">{group || thread.kind === "topic" ? thread.title : <Who name={other} />}</h1>
          <div className="head-meta">
            {group ? (
              <span className="faces">
                {thread.members.map((n) => (
                  <span key={n} className="face" title={show(n)}>
                    <Avatar name={n} small />
                  </span>
                ))}
                <span className="muted tiny">{thread.members.length} 人</span>
              </span>
            ) : (
              <span className={`conn-chip ${online ? "online" : ""}`}>
                <span className="conn-dot" />
                {online ? "在线" : "不在线"}
              </span>
            )}
            {thread.archived && <span className="chip">已归档</span>}
          </div>
        </div>
        <div className="head-actions">
          <button type="button" onClick={() => setDialog("add")} title={group ? "拉更多人进群" : "拉人进来，这个对话会变成群聊（他们能看到之前的内容）"}>
            ＋ 拉人
          </button>
          {thread.kind !== "direct" && (
            <button type="button" onClick={() => setDialog("rename")}>
              改名
            </button>
          )}
          {thread.kind !== "direct" && (
            <button type="button" onClick={() => onArchive(thread, !thread.archived)} title={thread.archived ? "放回左边的列表" : "收起到「已归档」，只影响你自己；有新消息会回来"}>
              {thread.archived ? "放回列表" : "归档"}
            </button>
          )}
          {group && (
            <button type="button" onClick={() => void leave()}>
              退出群聊
            </button>
          )}
          <button type="button" onClick={() => void copyAll()} title="复制这个对话，贴给 AI">
            复制对话
          </button>
        </div>
      </header>
      <MessageList messages={messages} error={error} me={me} questions={[]} empty={group ? "群聊里还没有消息。" : thread.kind === "topic" ? `新话题「${thread.title}」，说点什么吧。` : "还没有消息，说点什么吧。"} />
      <MentionComposer session={session} thread={thread} people={members.filter((m) => m.name !== me)} toast={toast} />
      {dialog === "add" && <AddPeopleDialog session={session} thread={thread} onClose={() => setDialog(null)} toast={toast} />}
      {dialog === "rename" && <RenameDialog session={session} thread={thread} onClose={() => setDialog(null)} toast={toast} />}
    </section>
  );
}

/** The box with @: typing @ offers people; @-ing someone not in the chat asks to bring them in first. */
function MentionComposer({ session, thread, people, toast }: { session: Session; thread: Thread; people: Member[]; toast: (t: string) => void }) {
  const show = useDisplayName();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<{ from: number; query: string } | null>(null);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setText(""), [thread.id]);

  const mentioned = useMemo(() => people.filter((p) => text.includes(`@${p.name}`)).map((p) => p.name), [text, people]);
  const outside = mentioned.filter((n) => !thread.members.includes(n));
  const choices = pick ? people.filter((p) => !pick.query || p.name.includes(pick.query) || p.nick.includes(pick.query)).slice(0, 8) : [];

  const onChange = (value: string, caret: number) => {
    setText(value);
    const at = value.lastIndexOf("@", caret - 1);
    const word = at >= 0 ? value.slice(at + 1, caret) : "";
    setPick(at >= 0 && (at === 0 || /\s/.test(value[at - 1]!)) && !/\s/.test(word) ? { from: at, query: word } : null);
  };
  const choose = (name: string) => {
    if (!pick) return;
    const caret = box.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, pick.from)}@${name} ${text.slice(caret)}`;
    setText(next);
    setPick(null);
    box.current?.focus();
  };
  const send = async (bringIn: string[] = []) => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (bringIn.length) await session.client.addMembers(thread.id, bringIn);
      await session.client.send(thread.id, { kind: "text", body, mentions: mentioned.length ? mentioned : undefined });
      setText("");
      setConfirm(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const trySend = () => (outside.length ? setConfirm(outside) : void send());
  const key = (e: KeyboardEvent) => {
    if (pick && choices.length && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      return choose(choices[0]!.name);
    }
    if (e.key === "Escape") setPick(null);
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      trySend();
    }
  };
  return (
    <div className="dock composer mention-box">
      {pick && choices.length > 0 && (
        <div className="mention-pop" role="listbox">
          {choices.map((p) => (
            <button key={p.name} type="button" role="option" onMouseDown={(e) => e.preventDefault()} onClick={() => choose(p.name)}>
              <Avatar name={p.name} small />
              <Who name={p.name} />
              {!thread.members.includes(p.name) && <span className="muted tiny">不在这里，发出时会问你要不要拉进来</span>}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={box}
        value={text}
        onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
        onKeyDown={key}
        placeholder={thread.kind === "group" ? `发到「${thread.title}」…（@ 某人会提醒他）` : `发给 ${show(thread.members.find((n) => n !== session.me.name) ?? "")}…（@ 别人会把他拉进来，变成群聊）`}
        rows={2}
      />
      <div className="acts">
        <span className="why">{error ? <span className="error">{error}</span> : mentioned.length ? `会提醒 ${mentioned.map(show).join("、")}` : "Ctrl+Enter 发送 · 支持 Markdown · 输入 @ 提到某人"}</span>
        <button type="button" className="primary" disabled={busy || !text.trim()} onClick={trySend}>
          发送
        </button>
      </div>
      {confirm && (
        <Dialog
          title={thread.kind === "group" ? "拉人进群" : "变成群聊"}
          onClose={() => setConfirm(null)}
          foot={
            <>
              <button type="button" onClick={() => setConfirm(null)}>
                取消
              </button>
              <button type="button" className="primary" disabled={busy} onClick={() => void send(confirm)}>
                拉进来并发送
              </button>
            </>
          }
        >
          <p className="lead-p">
            {confirm.map(show).join("、")} 还不在这个对话里。
            {thread.kind === "group" ? "拉进群后，他们能看到群里之前的消息。" : "拉进来后，这个对话会变成群聊，他们能看到之前的内容；你们俩以后的普通聊天会另开一个。"}
          </p>
        </Dialog>
      )}
    </div>
  );
}

function AddPeopleDialog({ session, thread, onClose, toast }: { session: Session; thread: Thread; onClose: () => void; toast: (t: string) => void }) {
  const { members } = useSession(session);
  const show = useDisplayName();
  const outside = members.filter((m) => !thread.members.includes(m.name));
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await session.client.addMembers(thread.id, chosen);
      onClose();
      toast(`已拉 ${chosen.map(show).join("、")} 进来`);
    } catch (err) {
      toast(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={thread.kind === "group" ? "拉人进群" : "拉人，变成群聊"}
      sub={thread.kind === "group" ? "他们能看到群里之前的消息" : "这个对话会变成群聊，新的人能看到之前的内容"}
      onClose={onClose}
      foot={
        <>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy || !chosen.length} onClick={() => void go()}>
            拉进来
          </button>
        </>
      }
    >
      {outside.length ? (
        <div className="pick">
          {outside.map((m) => (
            <button key={m.name} type="button" className={chosen.includes(m.name) ? "on" : ""} aria-pressed={chosen.includes(m.name)} onClick={() => setChosen((c) => (c.includes(m.name) ? c.filter((x) => x !== m.name) : [...c, m.name]))}>
              <Avatar name={m.name} small />
              <Who name={m.name} />
            </button>
          ))}
        </div>
      ) : (
        <div className="muted">大家都在这里了。</div>
      )}
    </Dialog>
  );
}

function RenameDialog({ session, thread, onClose, toast }: { session: Session; thread: Thread; onClose: () => void; toast: (t: string) => void }) {
  const [title, setTitle] = useState(thread.title);
  const go = async () => {
    try {
      await session.client.rename(thread.id, title.trim());
      onClose();
    } catch (err) {
      toast(errorText(err));
    }
  };
  return (
    <Dialog
      title={thread.kind === "group" ? "群聊改名" : "话题改名"}
      onClose={onClose}
      foot={
        <>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={!title.trim()} onClick={() => void go()}>
            保存
          </button>
        </>
      }
    >
      <Field label="名字">
        <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void go()} autoFocus />
      </Field>
    </Dialog>
  );
}
