import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import iconUrl from "./icon.svg";
import { Avatar, PeopleContext, preview, sessionStatus, waitedText, Who } from "./bits.js";
import { ChatTree, ChatView, GroupRows, ProfileDialog } from "./Chats.js";
import { FileViewer, PickFiles } from "./Files.js";
import { Check, Dialog, Field, PersonPick, Pick } from "./Dialog.js";
import { copyText, shell } from "./env.js";
import { errorText } from "./Messages.js";
import { useMinuteTick, useSession, type Session } from "./session.js";
import { SessionView } from "./SessionView.js";
import { ShellUpdatePage, useShellUpdate } from "./ShellUpdate.js";
import { SettingsDialog, type SettingsPart } from "./Settings.js";
import { usagePointer, usagePrompt, type TaskView, type ThreadView as Thread } from "./shared.js";
import { flowIsNew, markFlowSeen, SideFoot } from "./SideFoot.js";
import { Board, filterLabel, FlowDialog, HandedRow, matches, NewTaskDialog, TaskPage, TransferDialog, type TaskFilter, type TaskPane } from "./Tasks.js";
import { writeUsageFile } from "./usageFile.js";
import { macLights, ownTitleBar, WindowControls } from "./Window.js";
import { pageHasDraft, pageIsIdle, saveResume, useUpdates } from "./update.js";

// After login, in AMO Studio's layout (stages 2a–2b, plans/relay-tasks.md): the top bar with four views — 待处理 (tasks
// handed to me and the sessions waiting on me, then the ones waiting on others or on an AI, then the finished ones),
// 任务 (the team's board, a task's page), 聊天 (the plain chat with each person and the topics next to it; archived
// ones folded) and 成员 — the view's list on the left, the open one on the right. The top bar holds only those and
// ＋ 新会话; the bottom of the left column (SideFoot) what wants me, the shortcuts, me and 设置. A newer client the
// service publishes is applied once the window is not in use and nothing is typed.

type View = "queue" | "tasks" | "chat" | "people";
type Dialogs =
  | { kind: "session"; to?: string; taskId?: string }
  | { kind: "profile" }
  | { kind: "oldShell" }
  | { kind: "task" }
  | { kind: "transfer"; task: TaskView; thread?: Thread }
  | { kind: "flow" }
  | { kind: "settings"; part?: SettingsPart }
  | { kind: "file"; id: string; scripts: boolean };

export function Home({ session, onLogout, resumeOpen = null, updatedTo = null }: { session: Session; onLogout: () => void; resumeOpen?: string | null; updatedTo?: string | null }) {
  const { threads, members, connection, client, tasks, settings } = useSession(session);
  const me = session.me.name;
  useMinuteTick();
  const [view, setView] = useState<View>("queue");
  const [openId, setOpenId] = useState<string | null>(resumeOpen);
  const [person, setPerson] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>({ kind: "mine" });
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskPane, setTaskPane] = useState<TaskPane>("overview");
  const [toastText, setToastText] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [archOpen, setArchOpen] = useState(false);
  const openRef = useRef(openId);
  openRef.current = openId;
  const updates = useUpdates(
    client,
    async () => !pageHasDraft() && (await pageIsIdle()),
    (version) => saveResume({ openId: openRef.current, updatedTo: version }),
  );

  const checkHealth = useCallback(() => session.client.health(), [session]);
  const shellUpdate = useShellUpdate(checkHealth);
  const toast = useCallback((text: string) => {
    setToastText(text);
    setTimeout(() => setToastText((t) => (t === text ? null : t)), 2400);
  }, []);
  // An update that applied itself (the window was not in use, so a toast then goes unseen): a strip at the bottom left
  // until it is clicked away.
  const [updatedNote, setUpdatedNote] = useState(updatedTo);

  const groups = useMemo(() => {
    const sessions = threads.filter((t) => t.kind === "request");
    const withStatus = sessions.map((t) => ({ t, s: sessionStatus(t, me, Date.now(), settings) }));
    const mine = withStatus.filter((x) => x.s.needsMe).map((x) => x.t);
    const waiting = withStatus.filter((x) => !x.s.needsMe && x.t.request!.state !== "done").map((x) => x.t);
    const done = withStatus.filter((x) => x.t.request!.state === "done").map((x) => x.t);
    const chats = threads.filter((t) => t.kind !== "request" && !t.archived);
    const archived = threads.filter((t) => t.kind !== "request" && t.archived);
    const handed = tasks.filter((t) => t.unseen && !t.archived);
    return { mine, waiting, done, chats, archived, handed };
  }, [threads, tasks, me, settings]);
  const openTask = tasks.find((t) => t.id === taskId) ?? null;
  const queueCount = groups.mine.length + groups.handed.length;
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

  useEffect(() => shell?.setUnread(queueCount + chatUnread), [queueCount, chatUnread]);

  // Notifications when the window is not looking at it.
  useEffect(
    () =>
      session.onMessage((m) => {
        if (m.author === me || m.kind === "event" || (document.hasFocus() && session.openThread === m.threadId)) return;
        const t = session.snapshot.threads.find((x) => x.id === m.threadId);
        const title =
          m.kind === "request"
            ? `${m.author}${m.via.kind === "ai" ? " 的 AI" : ""} 发来会话`
            : m.kind === "reply"
              ? `${m.author} 回复了`
              : m.mentions?.includes(me)
                ? `${m.author} 在「${t?.title || "聊天"}」里 @ 了你`
                : t?.kind === "topic" || t?.kind === "group"
                  ? `${m.author} · ${t.title}`
                  : m.author;
        shell?.notify({ title, body: m.kind === "request" ? (t?.title ?? preview(m)) : preview(m).slice(0, 120), threadId: m.threadId });
      }),
    [session, me],
  );
  useEffect(() => shell?.onOpenThread((id) => setOpenId(id)), []);

  const showTask = (id: string, pane: TaskPane = "overview") => {
    setView("tasks");
    setTaskId(id);
    setTaskPane(pane);
  };

  const switchView = (v: View) => {
    setView(v);
    if (v === "tasks") setTaskId(null);
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

  // The usage file stays current with the team and its flow.
  const memberKey = members.map((m) => `${m.name}:${m.role}`).join(",");
  useEffect(() => void writeUsageFile(session), [session, memberKey, settings.flow]);

  const copyUsage = async () => {
    const written = await writeUsageFile(session);
    if (written) {
      await copyText(usagePointer(written.file, written.cli));
      return toast("已复制用法文件的位置，贴给 agent，它会自己去读");
    }
    const hookup = shell ? await shell.mcp().catch(() => null) : null;
    if (hookup?.cli) {
      // An older desktop client cannot write the file: point the agent at the command that prints the usage.
      await copyText(`请先运行 "${hookup.cli}" prompt（PowerShell 里写 & "${hookup.cli}" prompt），按它打印的说明用 AMO 中转（团队里互相传话、发会话找人确认、推进团队任务）。`);
      return toast("已复制一行指令，贴给 agent，它会自己去看用法");
    }
    await copyText(usagePrompt({ me, role: session.me.role, members, cli: hookup?.cli, flow: settings.flow }));
    toast("用法已复制，贴给 agent 就行");
  };

  const flowDoc = settings.flowDoc ?? null;
  const openFlow = () => {
    if (!flowDoc) return setDialog({ kind: "settings", part: "flow" });
    markFlowSeen(flowDoc, session.me.server);
    setDialog({ kind: "file", id: flowDoc.id, scripts: settings.flowScripts !== false && /\.html?$/i.test(flowDoc.name) });
  };
  const goQueue = (which: "mine" | "waiting") => {
    // Only a task waiting on me: its page; otherwise the first session of the kind.
    if (which === "mine" && !groups.mine.length && groups.handed[0]) return showTask(groups.handed[0].id);
    setView("queue");
    setOpenId((which === "mine" ? groups.mine[0] : groups.waiting[0])?.id ?? null);
  };

  const others = members.filter((m) => m.name !== me);
  const peer = open && open.kind !== "request" ? (open.members.find((n) => n !== me) ?? me) : null;
  const peers = peer ? threads.filter((t) => t.kind !== "request" && t.members.includes(peer) && (!t.archived || t.id === open!.id)) : [];

  let nav;
  if (view === "queue") {
    nav = (
      <>
        <NavLabel title="待我处理" count={queueCount} />
        {groups.handed.map((t) => (
          <HandedRow key={t.id} task={t} current={false} onOpen={(id) => showTask(id)} />
        ))}
        {groups.mine.map((t) => (
          <SessionRow key={t.id} thread={t} me={me} current={t.id === openId} onOpen={setOpenId} limits={settings} />
        ))}
        {!queueCount && <div className="nav-empty">手上没有要处理的。</div>}
        <NavLabel title="等对方 / AI 处理中" count={groups.waiting.length} />
        {groups.waiting.map((t) => (
          <SessionRow key={t.id} thread={t} me={me} current={t.id === openId} onOpen={setOpenId} limits={settings} />
        ))}
        {!groups.waiting.length && <div className="nav-empty">没有。</div>}
        {groups.done.length > 0 && (
          <>
            <button type="button" className="nav-fold" onClick={() => setDoneOpen(!doneOpen)}>
              {doneOpen ? "▾" : "▸"} 已完成 {groups.done.length}
            </button>
            {doneOpen && groups.done.map((t) => <SessionRow key={t.id} thread={t} me={me} current={t.id === openId} onOpen={setOpenId} limits={settings} />)}
          </>
        )}
      </>
    );
  } else if (view === "tasks") {
    const live = tasks.filter((t) => !t.archived);
    const row = (f: TaskFilter, label: React.ReactNode, n: number) => (
      <button
        key={f.kind === "holder" ? `h:${f.name}` : f.kind}
        type="button"
        className="nav-row"
        aria-current={!taskId && filterLabel(f) === filterLabel(taskFilter) ? "true" : undefined}
        onClick={() => (setTaskFilter(f), setTaskId(null))}
      >
        <span className="name">{label}</span>
        <span className="count">{n}</span>
      </button>
    );
    nav = (
      <>
        <NavLabel title="任务" count={live.length} />
        {(
          [
            [{ kind: "mine" }, "我手里的"],
            [{ kind: "created" }, "我创建的"],
            [{ kind: "all" }, "全部任务"],
          ] as Array<[TaskFilter, string]>
        ).map(([f, l]) => row(f, l, live.filter((t) => matches(t, f, me)).length))}
        <NavLabel title="按持有人" count={members.length} />
        {members.map((m) =>
          row(
            { kind: "holder", name: m.name },
            <>
              <Avatar name={m.name} small />
              {m.name}
            </>,
            live.filter((t) => t.holder === m.name).length,
          ),
        )}
      </>
    );
  } else if (view === "chat") {
    nav = <ChatTree session={session} openId={openId} onOpen={setOpenId} onChatWith={(n) => void chatWith(n)} onNewTopic={newTopic} onArchive={(t, a) => void archive(t, a)} />;
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
        <GroupRows session={session} onOpen={(id) => (setView("chat"), setOpenId(id))} />
      </>
    );
  }

  let main;
  if (view === "queue" && open?.kind === "request")
    main = <SessionView key={open.id} session={session} thread={open} toast={toast} onOpenTask={(id) => showTask(id, open.id)} onTakeover={(t) => { const task = tasks.find((x) => x.id === t.request?.taskId); if (task) setDialog({ kind: "transfer", task, thread: t }); }} />;
  else if (view === "tasks" && openTask)
    main = (
      <TaskPage
        key={openTask.id}
        session={session}
        task={openTask}
        pane={taskPane}
        onPane={setTaskPane}
        onBack={() => setTaskId(null)}
        toast={toast}
        onNewSession={(id) => setDialog({ kind: "session", taskId: id })}
        onTransfer={(task, thread) => setDialog({ kind: "transfer", task, thread })}
      />
    );
  else if (view === "tasks") main = <Board session={session} filter={taskFilter} onOpen={(id) => showTask(id)} toast={toast} />;
  else if (view === "chat" && open && open.kind !== "request")
    main = <ChatView key={open.id} session={session} thread={open} toast={toast} onArchive={(t, a) => void archive(t, a)} />;
  else if (view === "people" && person)
    main = <PersonView name={person} session={session} threads={threads} onChat={(n) => void chatWith(n)} onAsk={(n) => setDialog({ kind: "session", to: n })} onOpen={(id) => (setView("queue"), setOpenId(id))} />;
  else
    main = (
      <div className="placeholder">
        {view === "queue" ? (
          <>
            <h2>手上的事都在左边</h2>
            <p>待处理里只有要你动手的：收到的会话、返回给你的会话。点「＋ 新会话」请同事处理一件事；想让 AI 自己去问人，点左下的「复制用法」。</p>
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
    ["queue", "待处理", queueCount],
    ["tasks", "任务", 0],
    ["chat", "聊天", chatUnread],
    ["people", "成员", 0],
  ];
  const people = useMemo(() => new Map(members.map((m) => [m.name, m])), [members]);
  return (
    <PeopleContext.Provider value={people}>
    <div className="app">
      <header className={`topbar ${ownTitleBar ? "own" : ""} ${macLights ? "mac" : ""}`}>
        <div className="brand">
          <img className="brand-mark" src={iconUrl} alt="" />
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
        {view === "tasks" ? (
          <button type="button" className="primary new-btn" onClick={() => setDialog({ kind: "task" })}>
            ＋ 新任务
          </button>
        ) : (
          <button type="button" className="primary new-btn" onClick={() => setDialog({ kind: "session" })}>
            ＋ 新会话
          </button>
        )}
        <WindowControls />
      </header>
      <div className="body">
        <aside className="side">
          <div className="scope-nav">{nav}</div>
          <SideFoot
            session={session}
            mine={groups.mine.length}
            handed={groups.handed.length}
            waiting={groups.waiting.length}
            updates={updates}
            shellUpdate={shellUpdate}
            flowNew={flowIsNew(flowDoc, me, session.me.server)}
            updatedTo={updatedNote}
            onUpdatedSeen={() => setUpdatedNote(null)}
            onQueue={() => goQueue("mine")}
            onWaiting={() => goQueue("waiting")}
            onShellUpdate={() => setDialog({ kind: "oldShell" })}
            onFlow={openFlow}
            onQuick={() => setDialog({ kind: "flow" })}
            onCopyUsage={() => void copyUsage()}
            onProfile={() => setDialog({ kind: "profile" })}
            onSettings={() => setDialog({ kind: "settings" })}
          />
        </aside>
        <main className="main-col">{main}</main>
      </div>
      {dialog?.kind === "session" && (
        <NewSessionDialog
          session={session}
          people={others.map((m) => m.name)}
          tasks={tasks.filter((t) => !t.archived)}
          to={dialog.to}
          taskId={dialog.taskId}
          onClose={() => setDialog(null)}
          onSent={(id, tid) => {
            setDialog(null);
            if (tid) showTask(tid, id);
            else (setView("queue"), setOpenId(id));
            toast("会话已发出，会出现在对方的待处理里");
          }}
        />
      )}
      {dialog?.kind === "oldShell" && shellUpdate && <ShellUpdatePage update={shellUpdate} server={session.me.server} onClose={() => setDialog(null)} />}
      {dialog?.kind === "profile" && <ProfileDialog session={session} onClose={() => setDialog(null)} toast={toast} />}
      {dialog?.kind === "task" && <NewTaskDialog session={session} onClose={() => setDialog(null)} onMade={(id) => (setDialog(null), showTask(id))} />}
      {dialog?.kind === "transfer" && <TransferDialog session={session} task={tasks.find((t) => t.id === dialog.task.id) ?? dialog.task} thread={dialog.thread} onClose={() => setDialog(null)} toast={toast} />}
      {dialog?.kind === "flow" && <FlowDialog settings={settings} onClose={() => setDialog(null)} toast={toast} />}
      {dialog?.kind === "settings" && (
        <SettingsDialog
          session={session}
          part={dialog.part}
          onClose={() => setDialog(null)}
          toast={toast}
          onCopyUsage={() => void copyUsage()}
          onProfile={() => setDialog({ kind: "profile" })}
          onLogout={onLogout}
          onOpenFile={(id) => setDialog({ kind: "file", id, scripts: settings.flowScripts !== false && !!flowDoc && /\.html?$/i.test(flowDoc.name) })}
        />
      )}
      {dialog?.kind === "file" && <FileViewer session={session} fileId={dialog.id} scripts={dialog.scripts} onClose={() => setDialog(null)} toast={toast} />}
      {toastText && <div className="toast">{toastText}</div>}
    </div>
    </PeopleContext.Provider>
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

function SessionRow({ thread, me, current, onOpen, limits }: { thread: Thread; me: string; current: boolean; onOpen: (id: string) => void; limits?: { aiLateMinutes: number; aiStuckMinutes: number } }) {
  const r = thread.request!;
  const s = sessionStatus(thread, me, Date.now(), limits);
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

function NewSessionDialog(props: { session: Session; people: string[]; tasks: TaskView[]; to?: string; taskId?: string; onClose: () => void; onSent: (threadId: string, taskId: string | null) => void }) {
  const [to, setTo] = useState(props.to ?? props.people[0] ?? "");
  const [taskId, setTaskId] = useState(props.taskId ?? "");
  const [attach, setAttach] = useState<string[]>([]);
  const [local, setLocal] = useState<File[]>([]);
  const taskFiles = props.tasks.find((t) => t.id === taskId)?.files ?? [];
  useEffect(() => setAttach(taskFiles.map((f) => f.id)), [taskId]); // eslint-disable-line react-hooks/exhaustive-deps
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
      const { thread } = await props.session.client.ask({ to, title: title.trim(), body: body.trim(), questions: qs, needsReply, taskId: taskId || undefined, files: attach.filter((id) => taskFiles.some((f) => f.id === id)) });
      for (const f of local) await props.session.client.upload({ threadId: thread.id }, f.name, f, f.type);
      props.onSent(thread.id, taskId || null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string, on: boolean) => setAttach((a) => (on ? [...a, id] : a.filter((x) => x !== id)));
  return (
    <Dialog
      title="新会话"
      onClose={props.onClose}
      wide
      foot={
        <>
          <Check checked={needsReply} onChange={setNeedsReply}>
            需要对方回复（对方不能直接标记完成）
          </Check>
          <span className="grow" />
          <button type="button" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy || !to || !title.trim() || !body.trim()} onClick={() => void send()}>
            发出
          </button>
        </>
      }
    >
      <Field label="发给">
        {props.people.length ? <PersonPick people={props.people} value={to} onChange={setTo} label="发给" /> : <div className="muted tiny">还没有其他人</div>}
      </Field>
      <Field label="所属任务" hint="挂在任务下，回复会记进任务的决策">
        <Pick
          label="所属任务"
          value={taskId}
          onChange={setTaskId}
          options={[{ value: "", label: "不挂任务" }, ...props.tasks.map((t) => ({ value: t.id, label: t.title }))]}
        />
      </Field>
      <Field label="标题">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话说清要对方处理什么" autoFocus />
      </Field>
      <Field label="正文" hint="Markdown；对方看不到你本机的文件，关键内容贴进来或作为附件">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} />
      </Field>
      <Field label="要对方逐条回答的问题" hint="可不填；选项用逗号隔开">
        <div className="qs">
          {questions.map((q, i) => (
            <div key={i} className="q-row">
              <span className="rq-n">{i + 1}</span>
              <input value={q.text} onChange={(e) => setQuestions((list) => list.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} placeholder="问题" />
              <input className="opts" value={q.options} onChange={(e) => setQuestions((list) => list.map((x, j) => (j === i ? { ...x, options: e.target.value } : x)))} placeholder="选项，用逗号隔开（可不填）" />
              <button type="button" className="x" title="去掉这个问题" onClick={() => setQuestions((list) => (list.length > 1 ? list.filter((_, j) => j !== i) : [{ text: "", options: "" }]))}>
                ×
              </button>
            </div>
          ))}
          <button type="button" className="link add-q" onClick={() => setQuestions((list) => [...list, { text: "", options: "" }])}>
            ＋ 再加一个问题
          </button>
        </div>
      </Field>
      <Field label="附件">
        <div className="att-pick">
          {taskFiles.map((f) => (
            <button key={f.id} type="button" className={`att ${attach.includes(f.id) ? "on" : ""}`} aria-pressed={attach.includes(f.id)} onClick={() => toggle(f.id, !attach.includes(f.id))} title="任务里的文件，点一下带上或不带">
              <span className="file-ico">{f.name.split(".").pop()?.slice(0, 4)}</span>
              {f.name} v{f.version}
            </button>
          ))}
          {local.map((f, i) => (
            <button key={`${f.name}-${i}`} type="button" className="att on" title="本机文件，发出时上传；点一下去掉" onClick={() => setLocal((l) => l.filter((_, j) => j !== i))}>
              <span className="file-ico">{f.name.split(".").pop()?.slice(0, 4)}</span>
              {f.name} <span className="muted">· 本机</span>
            </button>
          ))}
          <PickFiles small label="＋ 从本机选" onFiles={(fl) => setLocal((l) => [...l, ...fl])} />
        </div>
      </Field>
      {error && <div className="notice error">{error}</div>}
    </Dialog>
  );
}
