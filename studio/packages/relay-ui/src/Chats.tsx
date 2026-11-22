import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Avatar, preview, timeText, useDisplayName, Who } from "./bits.js";
import { Dialog, Field } from "./Dialog.js";
import { copyText } from "./env.js";
import { ListRow, ListSection } from "./Layout.js";
import { MessageList, errorText, useMessages } from "./Messages.js";
import { useSession, type Session } from "./session.js";
import { threadAsText, type Member, type ThreadView as Thread } from "./shared.js";

// Chats (2026-10-27; layout A's list, 2026-11-23, plans/cowork.md 第 8 条): on the left the groups, then one row per
// person — their plain chat — with the topics with them under it; a topic starts from the chat's head (＋ 新话题). A chat
// @-ing someone who is not in it brings them in, and a direct chat or topic becomes a group with its history (asked
// first). A person's page in 成员 lists the groups you share.

const isChat = (t: Thread) => t.kind === "direct" || t.kind === "topic" || t.kind === "group";

/** The list column's rows for 聊天: 群聊, then 私聊 (a person, their topics under them), then what I archived. */
export function ChatList(props: { session: Session; openId: string | null; query: string; onOpen: (id: string) => void; onChatWith: (name: string) => void; onArchive: (t: Thread, archived: boolean) => void }) {
  const { threads, members } = useSession(props.session);
  const show = useDisplayName();
  const me = props.session.me.name;
  const q = props.query.trim().toLowerCase();
  const hit = (...words: string[]) => !q || words.some((w) => w.toLowerCase().includes(q));
  const chats = threads.filter((t) => isChat(t));
  const live = chats.filter((t) => !t.archived);
  const archived = chats.filter((t) => t.archived && hit(t.title));
  const others = members.filter((m) => m.name !== me);
  const groups = live.filter((t) => t.kind === "group" && hit(t.title, ...t.members.map(show))).sort((a, b) => b.updatedAt - a.updatedAt);
  // People with recent chats first.
  const withPerson = (name: string) => live.filter((t) => t.kind !== "group" && t.members.includes(name));
  const lastAt = (name: string) => Math.max(0, ...withPerson(name).map((t) => t.updatedAt));
  const people = others.filter((p) => hit(p.name, p.nick, ...withPerson(p.name).map((t) => t.title))).sort((a, b) => lastAt(b.name) - lastAt(a.name));
  const [archOpen, setArchOpen] = useState(false);

  const archive = (t: Thread, back = false) => (
    <button type="button" className="small" title={back ? "放回列表" : "归档：从列表收起，只影响你自己；有新消息会回来"} onClick={() => props.onArchive(t, back)}>
      {back ? "放回" : "归档"}
    </button>
  );
  const groupMark = <span className="avatar sq group">群</span>;
  return (
    <>
      {groups.length > 0 && <ListSection title="群聊" count={groups.length} />}
      {groups.map((t) => (
        <ListRow
          key={t.id}
          className="chat-row group"
          avatar={groupMark}
          title={t.title}
          time={timeText(t.updatedAt)}
          sub={t.last ? `${show(t.last.author)}：${preview(t.last)}` : `${t.members.length} 人`}
          badge={t.unread}
          unread={t.unread > 0}
          current={t.id === props.openId}
          onClick={() => props.onOpen(t.id)}
          extra={archive(t)}
        />
      ))}
      <ListSection title="私聊" count={people.length} />
      {people.map((p) => {
        const mine = withPerson(p.name);
        const direct = mine.find((t) => t.kind === "direct");
        const topics = mine.filter((t) => t.kind === "topic").sort((a, b) => a.createdAt - b.createdAt);
        return (
          <div key={p.name} className="person-node" data-person={p.name}>
            <ListRow
              className="chat-row"
              avatar={
                <span className="av-dot">
                  <Avatar name={p.name} />
                  <span className={`dot ${p.online ? "on" : ""}`} title={p.online ? "在线" : "不在线"} />
                </span>
              }
              title={<Who name={p.name} />}
              time={direct ? timeText(direct.updatedAt) : undefined}
              sub={direct?.last ? preview(direct.last) : <span className="muted">{p.role || "还没聊过"}</span>}
              badge={direct?.unread}
              unread={!!direct?.unread}
              current={!!direct && direct.id === props.openId}
              onClick={() => (direct ? props.onOpen(direct.id) : props.onChatWith(p.name))}
            />
            {topics.map((t) => (
              <ListRow
                key={t.id}
                className="chat-row kid"
                title={
                  <>
                    <span className="tag">话题</span> {t.title}
                  </>
                }
                time={timeText(t.updatedAt)}
                sub={t.last ? preview(t.last) : undefined}
                badge={t.unread}
                unread={t.unread > 0}
                current={t.id === props.openId}
                onClick={() => props.onOpen(t.id)}
                extra={archive(t)}
              />
            ))}
          </div>
        );
      })}
      {!others.length && <div className="list-empty">还没有其他人。把服务器的地址发给同事，让他们注册。</div>}
      {!!others.length && !people.length && !groups.length && <div className="list-empty">没有找到「{props.query}」。</div>}
      {archived.length > 0 && (
        <>
          <button type="button" className="nav-fold" onClick={() => setArchOpen(!archOpen)}>
            {archOpen ? "▾" : "▸"} 已归档 {archived.length}
          </button>
          {archOpen &&
            archived.map((t) => (
              <ListRow
                key={t.id}
                className="chat-row kid archived"
                title={
                  <>
                    <span className="tag">{t.kind === "group" ? "群聊" : "话题"}</span> {t.title || "普通聊天"}
                  </>
                }
                time={timeText(t.updatedAt)}
                sub={t.last ? preview(t.last) : undefined}
                current={t.id === props.openId}
                onClick={() => props.onOpen(t.id)}
                extra={archive(t, true)}
              />
            ))}
        </>
      )}
    </>
  );
}

/** The groups someone and I are both in (a person's page in 成员). */
export function SharedGroups({ session, name, onOpen }: { session: Session; name: string; onOpen: (id: string) => void }) {
  const { threads } = useSession(session);
  const show = useDisplayName();
  const groups = threads.filter((t) => t.kind === "group" && t.members.includes(name)).sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <>
      <h3>一起在的群聊 · {groups.length}</h3>
      {groups.map((t) => (
        <button key={t.id} type="button" className="box-row group-box" onClick={() => onOpen(t.id)}>
          <span className="avatar sq group">群</span>
          <span className="grow">
            <b>{t.title}</b>
            <span className="muted tiny ellipsis">
              {t.members.length} 人 · {t.members.map(show).join("、")}
            </span>
          </span>
          {t.archived && <span className="chip">已归档</span>}
        </button>
      ))}
      {!groups.length && <div className="muted tiny">没有。在聊天里 @ 别人，就会把那个对话变成群聊。</div>}
    </>
  );
}

function NewTopicDialog({ other, onClose, onNewTopic }: { other: string; onClose: () => void; onNewTopic: (other: string, title: string) => Promise<void> }) {
  const show = useDisplayName();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      await onNewTopic(other, title.trim());
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="新话题"
      sub={`和 ${show(other)} 单独聊一件事；普通聊天还在`}
      onClose={onClose}
      foot={
        <>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy || !title.trim()} onClick={() => void start()}>
            开始
          </button>
        </>
      }
    >
      <Field label="话题">
        <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void start()} placeholder="话题，比如：技能表结构" autoFocus />
      </Field>
      {error && <div className="notice error">{error}</div>}
    </Dialog>
  );
}

/** A chat: the plain one with someone, a topic, or a group. */
export function ChatView({ session, thread, toast, onArchive, onNewTopic }: { session: Session; thread: Thread; toast: (text: string) => void; onArchive: (thread: Thread, archived: boolean) => void; onNewTopic: (other: string, title: string) => Promise<void> }) {
  const me = session.me.name;
  const { members } = useSession(session);
  const show = useDisplayName();
  const { messages, error } = useMessages(session, thread.id);
  const other = thread.members.find((n) => n !== me) ?? me;
  const online = members.find((m) => m.name === other)?.online;
  const [dialog, setDialog] = useState<"add" | "rename" | "topic" | null>(null);
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
          <h1 className="head-title">{group || thread.kind === "topic" ? thread.title : <Who name={other} />}</h1>
          <div className="head-meta">
            <span className="page-crumb">{group ? "群聊" : thread.kind === "topic" ? <>和 <Who name={other} /> 的话题</> : "私聊"}</span>
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
          {!group && (
            <button type="button" onClick={() => setDialog("topic")} title={`和 ${show(other)} 另开一个话题，单独聊一件事`}>
              ＋ 新话题
            </button>
          )}
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
      {dialog === "topic" && <NewTopicDialog other={other} onClose={() => setDialog(null)} onNewTopic={onNewTopic} />}
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
