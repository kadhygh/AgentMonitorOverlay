import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Avatar, preview, sessionStatus, timeText, waitedText } from "./bits.js";
import { ChatView } from "./ChatView.js";
import { copyText, shell } from "./env.js";
import { UpdateBanner } from "./Login.js";
import { errorText } from "./Messages.js";
import { useMinuteTick, useSession, type Session } from "./session.js";
import { SessionView } from "./SessionView.js";
import { usagePrompt, type McpHookup, type ThreadView as Thread } from "./shared.js";
import { nextTheme, readTheme, setTheme, THEME_LABEL, type Theme } from "./theme.js";
import { pageHasDraft, pageIsIdle, saveResume, spanText, useSecondTick, useUpdates } from "./update.js";

// After login, in AMO Studio's layout (stage 2a, plans/relay-tasks.md): the top bar with three views — 待处理 (the
// sessions waiting on me, then the ones waiting on others or on an AI, then the finished ones), 聊天 (the plain chat
// with each person and the topics next to it; archived ones folded) and 成员 — the view's list on the left, the open
// one on the right. Next to my name: whether the service is connected; while it is not, a bar says so. A newer client
// the service publishes is applied once the window is not in use and nothing is typed.

type View = "queue" | "chat" | "people";

export function Home({ session, onLogout, resumeOpen = null }: { session: Session; onLogout: () => void; resumeOpen?: string | null }) {
  const { threads, members, connection, client } = useSession(session);
  const me = session.me.name;
  useMinuteTick();
  const [view, setView] = useState<View>("queue");
  const [openId, setOpenId] = useState<string | null>(resumeOpen);
  const [person, setPerson] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: "session"; to?: string } | { kind: "ai" } | null>(null);
  const [toastText, setToastText] = useState<string | null>(null);
  const [theme, setThemeState] = useState<Theme>(readTheme);
  const [doneOpen, setDoneOpen] = useState(false);
  const [archOpen, setArchOpen] = useState(false);
  const openRef = useRef(openId);
  openRef.current = openId;
  const updates = useUpdates(
    client,
    async () => !pageHasDraft() && (await pageIsIdle()),
    () => saveResume({ openId: openRef.current }),
  );

  const toast = useCallback((text: string) => {
    setToastText(text);
    setTimeout(() => setToastText((t) => (t === text ? null : t)), 2400);
  }, []);

  const groups = useMemo(() => {
    const sessions = threads.filter((t) => t.kind === "request");
    const withStatus = sessions.map((t) => ({ t, s: sessionStatus(t, me) }));
    const mine = withStatus.filter((x) => x.s.needsMe).map((x) => x.t);
    const waiting = withStatus.filter((x) => !x.s.needsMe && x.t.request!.state !== "done").map((x) => x.t);
    const done = withStatus.filter((x) => x.t.request!.state === "done").map((x) => x.t);
    const chats = threads.filter((t) => t.kind !== "request" && !t.archived);
    const archived = threads.filter((t) => t.kind !== "request" && t.archived);
    return { mine, waiting, done, chats, archived };
  }, [threads, me]);
  const open = threads.find((t) => t.id === openId) ?? null;
  const chatUnread = groups.chats.reduce((n, t) => n + t.unread, 0);

  // The view follows what is open (a notification, a resumed reload).
  useEffect(() => {
    if (open) setView(open.kind === "request" ? "queue" : "chat");
  }, [open?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Something open in the view when there is something.
  // Not before the list has loaded: a resumed conversation would be replaced.
  useEffect(() => {
    if (!threads.length || (openId && threads.some((t) => t.id === openId))) return;
    if (view === "queue") setOpenId((groups.mine[0] ?? groups.waiting[0])?.id ?? null);
    if (view === "chat") setOpenId(groups.chats[0]?.id ?? null);
  }, [view, threads.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => shell?.setUnread(groups.mine.length + chatUnread), [groups.mine.length, chatUnread]);

  // Notifications when the window is not looking at it.
  useEffect(
    () =>
      session.onMessage((m) => {
        if (m.author === me || m.kind === "event" || (document.hasFocus() && session.openThread === m.threadId)) return;
        const t = session.snapshot.threads.find((x) => x.id === m.threadId);
        const title = m.kind === "request" ? `${m.author}${m.via.kind === "ai" ? " 的 AI" : ""} 发来会话` : m.kind === "reply" ? `${m.author} 回复了` : t?.kind === "topic" ? `${m.author} · ${t.title}` : m.author;
        shell?.notify({ title, body: m.kind === "request" ? (t?.title ?? preview(m)) : preview(m).slice(0, 120), threadId: m.threadId });
      }),
    [session, me],
  );
  useEffect(() => shell?.onOpenThread((id) => setOpenId(id)), []);

  const switchView = (v: View) => {
    setView(v);
    if (v === "queue") setOpenId((groups.mine[0] ?? groups.waiting[0])?.id ?? null);
    else if (v === "chat") setOpenId(groups.chats[0]?.id ?? null);
    else setPerson((p) => p ?? members.find((m) => m.name !== me)?.name ?? null);
  };

  const chatWith = async (name: string) => {
    setView("chat");
    const existing = threads.find((t) => t.kind === "direct" && t.members.includes(name));
    if (existing) return setOpenId(existing.id);
    try {
      const t = await session.client.direct(name);
      session.adopt({ ...t, unread: 0, readSeq: 0, last: null, archived: false });
      setOpenId(t.id);
    } catch (err) {
      toast(errorText(err));
    }
  };

  /** Throws for the caller's form to show. */
  const newTopic = async (other: string, title: string) => {
    const t = await session.client.topic(other, title);
    session.adopt({ ...t, unread: 0, readSeq: 0, last: null, archived: false });
    setOpenId(t.id);
  };

  const archive = async (t: Thread, archived: boolean) => {
    try {
      await session.archive(t.id, archived);
      toast(archived ? "已归档，在左边「已归档」里能找到" : "已放回列表");
    } catch (err) {
      toast(errorText(err));
    }
  };

  const copyUsage = async () => {
    const hookup = shell ? await shell.mcp().catch(() => null) : null;
    await copyText(usagePrompt({ me, role: session.me.role, members, cli: hookup?.cli }));
    toast("用法已复制，贴给 agent 就行");
  };

  const cycleTheme = () => {
    const t = nextTheme(theme);
    setTheme(t);
    setThemeState(t);
  };

  const others = members.filter((m) => m.name !== me);
  const peer = open && open.kind !== "request" ? (open.members.find((n) => n !== me) ?? me) : null;
  const peers = peer ? threads.filter((t) => t.kind !== "request" && t.members.includes(peer) && (!t.archived || t.id === open!.id)) : [];

  let nav;
  if (view === "queue") {
    nav = (
      <>
        <NavLabel title="待我处理" count={groups.mine.length} />
        {groups.mine.map((t) => (
          <SessionRow key={t.id} thread={t} me={me} current={t.id === openId} onOpen={setOpenId} />
        ))}
        {!groups.mine.length && <div className="nav-empty">手上没有要处理的会话。</div>}
        <NavLabel title="等对方 / AI 处理中" count={groups.waiting.length} />
        {groups.waiting.map((t) => (
          <SessionRow key={t.id} thread={t} me={me} current={t.id === openId} onOpen={setOpenId} />
        ))}
        {!groups.waiting.length && <div className="nav-empty">没有。</div>}
        {groups.done.length > 0 && (
          <>
            <button type="button" className="nav-fold" onClick={() => setDoneOpen(!doneOpen)}>
              {doneOpen ? "▾" : "▸"} 已完成 {groups.done.length}
            </button>
            {doneOpen && groups.done.map((t) => <SessionRow key={t.id} thread={t} me={me} current={t.id === openId} onOpen={setOpenId} />)}
          </>
        )}
      </>
    );
  } else if (view === "chat") {
    nav = (
      <>
        <NavLabel title="对话" count={groups.chats.length} />
        {groups.chats.map((t) => (
          <ChatRow key={t.id} thread={t} me={me} current={t.id === openId} onOpen={setOpenId} onArchive={archive} />
        ))}
        {!groups.chats.length && <div className="nav-empty">点「成员」里的同事开始聊天。</div>}
        {groups.archived.length > 0 && (
          <>
            <button type="button" className="nav-fold" onClick={() => setArchOpen(!archOpen)}>
              {archOpen ? "▾" : "▸"} 已归档 {groups.archived.length}
            </button>
            {archOpen && groups.archived.map((t) => <ChatRow key={t.id} thread={t} me={me} current={t.id === openId} onOpen={setOpenId} onArchive={archive} />)}
          </>
        )}
      </>
    );
  } else {
    nav = (
      <>
        <NavLabel title={connection === "offline" ? "成员 · 在线状态未知" : "成员"} count={members.length} />
        {members.map((m) => (
          <button key={m.name} type="button" className="nav-row person" aria-current={person === m.name ? "true" : undefined} onClick={() => setPerson(m.name)}>
            <span className="name">
              <Avatar name={m.name} small />
              {m.name}
              {m.name === me ? "（我）" : ""}
              <span className="muted tiny ellipsis">{m.role}</span>
            </span>
            <span className={`dot ${m.online && connection !== "offline" ? "on" : ""}`} />
          </button>
        ))}
        {!others.length && <div className="nav-empty">还没有其他人。把服务器的地址发给同事，让他们注册。</div>}
      </>
    );
  }

  let main;
  if (view === "queue" && open?.kind === "request") main = <SessionView key={open.id} session={session} thread={open} toast={toast} />;
  else if (view === "chat" && open && open.kind !== "request")
    main = <ChatView key={open.id} session={session} thread={open} peers={peers} toast={toast} onOpen={setOpenId} onChatWith={(n) => void chatWith(n)} onNewTopic={newTopic} onArchive={(t, a) => void archive(t, a)} />;
  else if (view === "people" && person)
    main = <PersonView name={person} session={session} threads={threads} onChat={(n) => void chatWith(n)} onAsk={(n) => setDialog({ kind: "session", to: n })} onOpen={(id) => (setView("queue"), setOpenId(id))} />;
  else
    main = (
      <div className="placeholder">
        {view === "queue" ? (
          <>
            <h2>手上的事都在左边</h2>
            <p>待处理里只有要你动手的：收到的会话、返回给你的会话。点「＋ 新会话」请同事处理一件事；想让 AI 自己去问人，点「复制用法」或「接入 AI」。</p>
          </>
        ) : view === "chat" ? (
          <>
            <h2>还没有对话</h2>
            <p>在「成员」里点同事开始私聊；和同一个人还可以开多个话题。</p>
          </>
        ) : (
          <h2>选一个成员</h2>
        )}
      </div>
    );

  const tabs: Array<[View, string, number]> = [
    ["queue", "待处理", groups.mine.length],
    ["chat", "聊天", chatUnread],
    ["people", "成员", 0],
  ];
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">中</span>
          <span className="brand-name">AMO 中转</span>
          <span className="brand-sep">{session.me.service}</span>
        </div>
        <nav className="view-tabs">
          {tabs.map(([v, label, n]) => (
            <button key={v} type="button" className="view-tab" aria-current={view === v ? "page" : undefined} onClick={() => switchView(v)}>
              {label}
              {n > 0 && <span className="badge">{n}</span>}
            </button>
          ))}
        </nav>
        <span className="grow" />
        {updates.update && <UpdateBanner updates={updates} server={session.me.server} auto="不用时自动更新" compact />}
        <button type="button" className="tb-btn" onClick={() => void copyUsage()} title="复制一段说明，贴给任何 agent，它就知道怎么用中转找人处理事情">
          复制用法
        </button>
        <button type="button" className="tb-btn" onClick={() => setDialog({ kind: "ai" })} title="让本机的 AI 客户端（Claude Code、Codex…）直接用中转">
          接入 AI
        </button>
        <button type="button" className="tb-btn" onClick={cycleTheme} title="主题：跟随系统 / 浅色 / 深色，点一下切换">
          {THEME_LABEL[theme]}
        </button>
        <button type="button" className="primary" onClick={() => setDialog({ kind: "session" })}>
          ＋ 新会话
        </button>
        <span className="me-chip" title={`${session.me.role || session.me.service} · 服务器 ${session.me.server}`}>
          <Avatar name={me} small />
          {me}
          <span className={`conn-chip ${connection}`}>
            <span className="conn-dot" />
            {{ online: "在线", connecting: "连接中", offline: "离线" }[connection]}
          </span>
        </span>
        <button type="button" className="tb-btn small" onClick={onLogout}>
          退出
        </button>
      </header>
      <ConnectionBar session={session} />
      <div className="body">
        <aside className="scope-nav">{nav}</aside>
        <main className="main-col">{main}</main>
      </div>
      {dialog?.kind === "session" && (
        <NewSessionDialog
          session={session}
          people={others.map((m) => m.name)}
          to={dialog.to}
          onClose={() => setDialog(null)}
          onSent={(id) => (setDialog(null), setView("queue"), setOpenId(id), toast("会话已发出，会出现在对方的待处理里"))}
        />
      )}
      {dialog?.kind === "ai" && <ConnectAiDialog onClose={() => setDialog(null)} onCopyUsage={() => void copyUsage()} toast={toast} />}
      {toastText && <div className="toast">{toastText}</div>}
    </div>
  );
}

function NavLabel({ title, count }: { title: string; count: number }) {
  return (
    <div className="nav-label">
      {title}
      <span className="count">{count}</span>
      <span className="rule" />
    </div>
  );
}

function SessionRow({ thread, me, current, onOpen }: { thread: Thread; me: string; current: boolean; onOpen: (id: string) => void }) {
  const r = thread.request!;
  const s = sessionStatus(thread, me);
  const at = r.state === "returned" ? (r.returnedAt ?? thread.updatedAt) : thread.updatedAt;
  return (
    <button type="button" className={`srow ${thread.unread ? "unread" : ""}`} aria-current={current ? "true" : undefined} onClick={() => onOpen(thread.id)}>
      <div className="srow-top">
        <span className={`dot ${s.dot}`} />
        <span className="srow-title">{thread.title}</span>
        {r.byAi && <span className="tag ai">AI</span>}
        {thread.unread > 0 && <span className="badge">{thread.unread}</span>}
        <span className="srow-time">{waitedText(Date.now() - at)}</span>
      </div>
      <div className="srow-meta">
        <span className={`t ${s.warn ? "warn" : ""}`}>{r.from === me && r.state === "open" ? `等 ${r.to} 处理` : s.text}</span>
      </div>
    </button>
  );
}

function ChatRow({ thread, me, current, onOpen, onArchive }: { thread: Thread; me: string; current: boolean; onOpen: (id: string) => void; onArchive: (t: Thread, archived: boolean) => void }) {
  const other = thread.members.find((n) => n !== me) ?? me;
  return (
    <div className="srow-wrap">
      <button type="button" className={`srow ${thread.unread ? "unread" : ""}`} aria-current={current ? "true" : undefined} onClick={() => onOpen(thread.id)}>
        <div className="srow-top">
          <Avatar name={other} small />
          <span className="srow-title">{thread.kind === "direct" ? other : thread.title}</span>
          {thread.unread > 0 && <span className="badge">{thread.unread}</span>}
          <span className="srow-time">{timeText(thread.updatedAt)}</span>
        </div>
        <div className="srow-meta" style={{ paddingLeft: 28 }}>
          {thread.kind === "topic" && <span className="chip">话题 · {other}</span>}
          <span className="t">{preview(thread.last)}</span>
        </div>
      </button>
      {thread.kind !== "direct" && (
        <button type="button" className="small srow-archive" title={thread.archived ? "放回列表" : "归档：从列表收起，只影响你自己；有新消息会回来"} onClick={() => onArchive(thread, !thread.archived)}>
          {thread.archived ? "放回" : "归档"}
        </button>
      )}
    </div>
  );
}

function PersonView(props: { name: string; session: Session; threads: Thread[]; onChat: (name: string) => void; onAsk: (name: string) => void; onOpen: (id: string) => void }) {
  const me = props.session.me.name;
  const m = props.session.snapshot.members.find((x) => x.name === props.name);
  const between = props.threads.filter((t) => t.kind === "request" && t.members.includes(props.name) && t.members.includes(me) && props.name !== me);
  const live = between.filter((t) => t.request!.state !== "done");
  return (
    <section className="view">
      <div className="person-head">
        <Avatar name={props.name} />
        <div className="grow">
          <h2>{props.name}</h2>
          <div className="dim small">
            {m?.role || "（没写负责什么）"} · {m?.online ? "在线" : "不在线"}
          </div>
        </div>
        {props.name !== me && (
          <>
            <button type="button" onClick={() => props.onChat(props.name)}>
              私聊
            </button>
            <button type="button" className="primary" onClick={() => props.onAsk(props.name)}>
              发起会话
            </button>
          </>
        )}
      </div>
      <div className="pane">
        <h3>和你之间进行中的会话 · {live.length}</h3>
        {live.map((t) => (
          <SessionRow key={t.id} thread={t} me={me} current={false} onOpen={props.onOpen} />
        ))}
        {!live.length && <div className="muted tiny">没有。</div>}
      </div>
    </section>
  );
}

/** Offline: since when, the next try, and a way to try now. Hidden for a brief blip. */
function ConnectionBar({ session }: { session: Session }) {
  const { connection, offlineSince, retryAt } = useSession(session);
  const now = useSecondTick(connection === "offline");
  if (connection !== "offline" || !offlineSince || now - offlineSince < 1500) return null;
  return (
    <div className="conn-bar" role="status">
      <b>! 和服务器断开了</b>
      <span>
        已 {spanText(now - offlineSince)} · {retryAt && retryAt > now ? `${spanText(retryAt - now)}后重连` : "正在重连…"}
      </span>
      <button type="button" className="link" onClick={() => session.reconnectNow()}>
        立即重连
      </button>
      <span className="muted tiny">这段时间发不出消息；连上后会补上别人发来的。服务所在的电脑关机、睡眠或断网时会这样。</span>
    </div>
  );
}

function Dialog({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-label={title}>
        <div className="dialog-head">
          <b>{title}</b>
          <button type="button" className="x" onClick={onClose} title="关闭 (Esc)">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function NewSessionDialog(props: { session: Session; people: string[]; to?: string; onClose: () => void; onSent: (threadId: string) => void }) {
  const [to, setTo] = useState(props.to ?? props.people[0] ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [needsReply, setNeedsReply] = useState(true);
  const [questions, setQuestions] = useState<Array<{ text: string; options: string }>>([{ text: "", options: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const qs = questions
        .filter((q) => q.text.trim())
        .map((q) => {
          const options = q.options
            .split(/[,，/、]/)
            .map((o) => o.trim())
            .filter(Boolean);
          return options.length ? { text: q.text.trim(), options } : { text: q.text.trim() };
        });
      const { thread } = await props.session.client.ask({ to, title: title.trim(), body: body.trim(), questions: qs, needsReply });
      props.onSent(thread.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="新会话" onClose={props.onClose} wide>
      <div className="form">
        <label>
          发给
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {props.people.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label>
          标题
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话说清要对方处理什么" autoFocus />
        </label>
        <label>
          正文 <span className="muted tiny">（Markdown；对方看不到你本机的文件，关键内容贴进来）</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7} />
        </label>
        <div className="qs">
          <div className="dim tiny">要对方逐条回答的问题</div>
          {questions.map((q, i) => (
            <div key={i} className="q-row">
              <span className="rq-n">{i + 1}</span>
              <input value={q.text} onChange={(e) => setQuestions((list) => list.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} placeholder="问题" />
              <input className="opts" value={q.options} onChange={(e) => setQuestions((list) => list.map((x, j) => (j === i ? { ...x, options: e.target.value } : x)))} placeholder="选项，用逗号隔开（可不填）" />
              <button type="button" className="x" onClick={() => setQuestions((list) => (list.length > 1 ? list.filter((_, j) => j !== i) : [{ text: "", options: "" }]))}>
                ×
              </button>
            </div>
          ))}
          <button type="button" className="link" style={{ alignSelf: "flex-start" }} onClick={() => setQuestions((list) => [...list, { text: "", options: "" }])}>
            ＋ 再加一个问题
          </button>
        </div>
        <label className="check">
          <input type="checkbox" checked={needsReply} onChange={(e) => setNeedsReply(e.target.checked)} />
          需要对方回复（对方不能直接标记完成，由你来标记）
        </label>
        {error && <div className="notice error">{error}</div>}
        <div className="dialog-foot">
          <button type="button" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy || !to || !title.trim() || !body.trim()} onClick={() => void send()}>
            发出
          </button>
        </div>
      </div>
    </Dialog>
  );
}

const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

function ConnectAiDialog({ onClose, onCopyUsage, toast }: { onClose: () => void; onCopyUsage: () => void; toast: (t: string) => void }) {
  const [hookup, setHookup] = useState<McpHookup | null>(null);
  useEffect(() => void shell?.mcp().then(setHookup), []);

  if (!shell) {
    return (
      <Dialog title="接入 AI" onClose={onClose}>
        <p>浏览器里没法让本机的 AI 直接接入。要用 MCP，请下载桌面客户端（服务器首页有下载）。</p>
        <p className="dim small">现在也可以点「复制用法」把说明贴给 agent，再把它写好的内容手动用「＋ 新会话」发出去。</p>
        <div className="dialog-foot">
          <button type="button" onClick={onCopyUsage}>
            复制用法
          </button>
        </div>
      </Dialog>
    );
  }
  if (!hookup) return null;
  const envFlags = Object.entries(hookup.env)
    .map(([k, v]) => `-e ${k}=${v}`)
    .join(" ");
  const claude = `claude mcp add amo-relay --scope user ${envFlags} -- ${[hookup.command, ...hookup.args].map(quote).join(" ")}`;
  const toml = [
    "[mcp_servers.amo-relay]",
    `command = ${JSON.stringify(hookup.command)}`,
    `args = [${hookup.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    `env = { ${Object.entries(hookup.env)
      .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
      .join(", ")} }`,
  ].join("\n");
  const json = JSON.stringify({ mcpServers: { "amo-relay": { command: hookup.command, args: hookup.args, env: hookup.env } } }, null, 2);
  const block = (label: string, text: string, hint: string) => (
    <div className="hookup">
      <div className="hookup-head">
        <b>{label}</b>
        <span className="muted tiny">{hint}</span>
        <div className="grow" />
        <button type="button" className="small" onClick={() => void copyText(text).then(() => toast(`已复制 ${label} 的配置`))}>
          复制
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
  return (
    <Dialog title="接入 AI（MCP）" onClose={onClose} wide>
      <p className="dim small" style={{ margin: 0 }}>
        接好后，本机的 AI 用你现在登录的身份收发会话：能看到团队成员、给人发会话、取回复并接着处理。换账号登录后，它跟着换。MCP 由这个客户端自带的运行时启动，本机不用装 Node。
      </p>
      {block("Claude Code", claude, "在终端里运行一次")}
      {block("Codex", toml, "加到 ~/.codex/config.toml")}
      {block("其他客户端", json, "支持 mcpServers JSON 的都可以")}
      <p className="dim small" style={{ margin: 0 }}>
        不支持 MCP 的 agent：点「复制用法」，说明里带着命令行用法（<code>{hookup.cli}</code>）。
      </p>
      <div className="dialog-foot">
        <button type="button" onClick={onCopyUsage}>
          复制用法
        </button>
        <button type="button" className="primary" onClick={onClose}>
          好
        </button>
      </div>
    </Dialog>
  );
}
