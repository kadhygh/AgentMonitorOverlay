import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import iconUrl from "./icon.svg";
import { Avatar, PeopleContext, preview, sessionStatus, useDisplayName, waitedText, Who } from "./bits.js";
import { ChatList, ChatView, SharedGroups } from "./Chats.js";
import { FileViewer, PickFiles } from "./Files.js";
import { Check, Dialog, Field, PersonPick, Pick } from "./Dialog.js";
import { copyText, shell } from "./env.js";
import { fullUi } from "./features.js";
import { CoworkList, CoworkView, CoworkWaitingRows, coworkUnreadCount, coworkWaiting, NewCoworkDialog } from "./Cowork.js";
import { FloatArea } from "./Floats.js";
import { FilterRow, ICONS, ListPane, ListRow, ListSection, Rail, RailItem } from "./Layout.js";
import { errorText } from "./Messages.js";
import { coworkOf, useMinuteTick, useSession, type Session } from "./session.js";
import { HelpDialog, type HelpSection } from "./Help.js";
import { SessionView } from "./SessionView.js";
import { ShellUpdatePage, useShellUpdate } from "./ShellUpdate.js";
import { SettingsDialog, type SettingsPart } from "./Settings.js";
import { ACCOUNT_KINDS, chatTitleFor, isAccountKind, listedOthers, unlistedNames, usagePointer, usagePrompt, type Member, type RelayDevice, type TaskView, type ThreadView as Thread } from "./shared.js";
import { ConnChip, flowIsNew, markFlowSeen, QueueStrip, Shortcuts, StatusStrips } from "./SideFoot.js";
import { Board, filterLabel, FlowDialog, HandedRow, matches, NewTaskDialog, TaskPage, TransferDialog, type TaskFilter, type TaskPane } from "./Tasks.js";
import { writeUsageFile } from "./usageFile.js";
import { macLights, ownTitleBar, WindowControls } from "./Window.js";
import { saveResume, useUpdates } from "./update.js";
import { TransferEngine } from "./transfer.js";
import { pendingHere, SendDialog, transferAvailability, TransferMain, TransferNav, type TransferAvailability, type TransferFilter } from "./Transfers.js";
import { transferBytesText, transferTitle } from "./shared.js";
import { takeOpenRequest, useOpenRequest } from "./openRequests.js";
import { copyRef, MenuHost, openMenu, RefsContext, type RefsCtx } from "./RefChips.js";
import { parseOpen, requestRef } from "./refs.js";

// After login, in layout A「IM 三栏」(2026-11-23, plans/cowork.md 第 8 条; the prototype studio/out/relay-redesign/a-im.html,
// the frame's parts in Layout.tsx): the title bar (the service and how it is connected, the window's buttons); the
// icon rail — 待处理 (tasks handed to me and the sessions waiting on me, what waits on me in the 协作, then the ones
// waiting on others or on an AI, then the finished ones), 协作 (Cowork.tsx: its list, its 群聊 with the 信息栏, its 子会话
// and 白板 floating over the page), 聊天 (groups, then each person's plain chat with their topics under
// it; archived ones folded), 传文件 (sends to accept on this device, received, sent) and 成员; at its foot 说明, 设置 and
// me — then the view's list, the open thing in the middle, and its 信息栏 on the right (a session's files), folded
// until asked for up to 1100 px wide. Under each list what wants me (offline, newer versions); under 待处理's also what waits on me
// and 复制用法. A newer client the service publishes is applied once the window is not in use and nothing is typed.
// Tightened (2026-10-28, features.ts): no 任务 and no ＋ 新会话 — sessions come from AIs, people chat; the task views
// and the flow shortcuts come back with fullUi().

type View = "queue" | "cowork" | "tasks" | "chat" | "people" | "transfers";
type Dialogs =
  | { kind: "session"; to?: string; taskId?: string }
  | { kind: "oldShell" }
  | { kind: "task" }
  | { kind: "transfer"; task: TaskView; thread?: Thread }
  | { kind: "flow" }
  | { kind: "settings"; part?: SettingsPart }
  | { kind: "file"; id: string; scripts: boolean }
  | { kind: "help"; section?: HelpSection }
  | { kind: "sendFiles"; to?: string }
  | { kind: "cowork" };

/**
 * A 协作's 群聊 (kind cowork) or one of its 子会话 (a request with coworkId; the service since 协作 step 1, 2026-11-23):
 * they come in the thread list like the rest but belong on the 协作 page, not in 待处理 or 聊天.
 */
export const ofCowork = (t: Thread) => !!coworkOf(t);

/** A plain chat or topic whose other side is one `hidden` (unlistedNames): left out of 聊天, its count and its notifications. */
const hiddenChat = (hidden: Set<string>, me: string) => (t: Thread) => (t.kind === "direct" || t.kind === "topic") && t.members.some((n) => n !== me && hidden.has(n));

export function Home({ session, onLogout, resumeOpen = null, updatedTo = null }: { session: Session; onLogout?: () => void; resumeOpen?: string | null; updatedTo?: string | null }) {
  const st = useSession(session);
  const { threads, members, connection, client, tasks, settings, transfers, device, transfersOk } = st;
  const me = session.me.name;
  useMinuteTick();
  const full = fullUi();
  const [view, setView] = useState<View>("queue");
  const [openId, setOpenId] = useState<string | null>(resumeOpen);
  const [person, setPerson] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [taskFilter, setTaskFilter] = useState<TaskFilter>({ kind: "mine" });
  const [taskId, setTaskId] = useState<string | null>(null);
  const [taskPane, setTaskPane] = useState<TaskPane>("overview");
  const [toastText, setToastText] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [transferFilter, setTransferFilter] = useState<TransferFilter>("pending");
  const [chatQuery, setChatQuery] = useState("");
  const [peopleQuery, setPeopleQuery] = useState("");
  /** 成员's folded part at its foot: 测试 and turned-off accounts (2026-11-23). */
  const [hiddenOpen, setHiddenOpen] = useState(false);
  // 协作: the one open, and a 子会话 to open in it (from 待处理, a notification, Studio's 在中转里打开).
  const [coworkId, setCoworkId] = useState<string | null>(null);
  const [coworkFocus, setCoworkFocus] = useState<{ sub?: string; n: number } | null>(null);
  const [coworkQuery, setCoworkQuery] = useState("");
  const availability = transferAvailability({ device, transfersOk });
  // The engine that moves the bytes (transfer.ts): while signed in on a desktop client that has 传文件.
  const [engine, setEngine] = useState<TransferEngine | null>(null);
  useEffect(() => {
    if (availability !== "ok" || !shell?.transfer) return;
    const e = new TransferEngine(session, shell.transfer);
    e.start();
    setEngine(e);
    return () => (e.stop(), setEngine(null));
  }, [session, availability]);
  const pendingFiles = useMemo(() => pendingHere(transfers, me, device?.id), [transfers, me, device?.id]);
  const openRef = useRef(openId);
  openRef.current = openId;
  const updates = useUpdates(client, null, (version) => saveResume({ openId: openRef.current, updatedTo: version }));

  const checkHealth = useCallback(() => session.client.health(), [session]);
  const shellUpdate = useShellUpdate(checkHealth);
  const toast = useCallback((text: string, ms = 2400) => {
    setToastText(text);
    setTimeout(() => setToastText((t) => (t === text ? null : t)), ms);
  }, []);
  // Back from 「立即更新」: say it took.
  useEffect(() => {
    if (updatedTo) toast(`已更新到 ${updatedTo}`);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => {
    const sessions = threads.filter((t) => t.kind === "request" && !ofCowork(t));
    const withStatus = sessions.map((t) => ({ t, s: sessionStatus(t, me, Date.now(), settings) }));
    const mine = withStatus.filter((x) => x.s.needsMe).map((x) => x.t);
    const waiting = withStatus.filter((x) => !x.s.needsMe && x.t.request!.state !== "done").map((x) => x.t);
    const done = withStatus.filter((x) => x.t.request!.state === "done").map((x) => x.t);
    // A plain chat or topic with a 测试 or turned-off account is not in the list (2026-11-23), so not in its count either.
    const unshown = hiddenChat(unlistedNames(members, me), me);
    const chats = threads.filter((t) => t.kind !== "request" && !ofCowork(t) && !t.archived && !unshown(t));
    const archived = threads.filter((t) => t.kind !== "request" && !ofCowork(t) && t.archived);
    const handed = full ? tasks.filter((t) => t.unseen && !t.archived) : [];
    return { mine, waiting, done, chats, archived, handed };
  }, [threads, tasks, me, settings, full, members]);
  const openTask = tasks.find((t) => t.id === taskId) ?? null;
  const waitingCowork = coworkWaiting(st, me).count;
  const queueCount = groups.mine.length + groups.handed.length + waitingCowork;
  const open = threads.find((t) => t.id === openId) ?? null;
  const chatUnread = groups.chats.reduce((n, t) => n + t.unread, 0);

  // The view follows what is open (a notification, a resumed reload).
  useEffect(() => {
    if (open && ofCowork(open)) showCowork(coworkOf(open)!, open.kind === "request" ? open.id : undefined);
    else if (open) setView(open.kind === "request" ? "queue" : "chat");
  }, [open?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Something open in the view when there is something.
  // Not before the list has loaded: a resumed conversation would be replaced.
  useEffect(() => {
    if (!threads.length || (openId && threads.some((t) => t.id === openId))) return;
    if (view === "queue") setOpenId((groups.mine[0] ?? groups.waiting[0])?.id ?? null);
    if (view === "chat") setOpenId(groups.chats[0]?.id ?? null);
  }, [view, threads.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // The shell shows it on the taskbar and the tray (and AMO 平台's tray); signed out, nothing waits.
  useEffect(() => shell?.setUnread(queueCount + chatUnread + pendingFiles.length), [queueCount, chatUnread, pendingFiles.length]);
  const openCowork = st.coworks.find((c) => c.id === coworkId) ?? null;
  useEffect(() => () => shell?.setUnread(0), []);

  // Notifications when the window is not looking at it.
  useEffect(
    () =>
      session.onMessage((m) => {
        if (m.author === me || m.kind === "event" || (document.hasFocus() && session.openThread === m.threadId)) return;
        const t = session.snapshot.threads.find((x) => x.id === m.threadId);
        if (t && hiddenChat(unlistedNames(session.snapshot.members, me), me)(t)) return;
        if (t && ofCowork(t)) {
          // In a 协作 only what is for me: an @ of me, or a 子会话 that waits on me.
          const c = session.snapshot.coworks.find((x) => x.id === coworkOf(t));
          const forMe = m.mentions?.includes(me) || (t.kind === "request" && t.request?.to === me);
          if (forMe) shell?.notify({ title: m.mentions?.includes(me) ? `${m.author}${m.via.kind === "ai" ? " 的 AI" : ""} 在协作「${c?.title ?? ""}」里 @ 了你` : `协作「${c?.title ?? ""}」的子会话：${t.title}`, body: preview(m).slice(0, 120), threadId: m.threadId });
          return;
        }
        const title =
          m.kind === "request"
            ? `${m.author}${m.via.kind === "ai" ? " 的 AI" : ""} 发来会话`
            : m.kind === "reply"
              ? `${m.author} 回复了`
              : m.mentions?.includes(me)
                ? `${m.author} 在「${(t && chatTitleFor(t, session.snapshot.members, me)) || "聊天"}」里 @ 了你`
                : t?.kind === "topic" || t?.kind === "group"
                  ? `${m.author} · ${chatTitleFor(t, session.snapshot.members, me)}`
                  : m.author;
        shell?.notify({ title, body: m.kind === "request" ? (t?.title ?? preview(m)) : preview(m).slice(0, 120), threadId: m.threadId });
      }),
    [session, me],
  );
  // 传文件: a send to accept on this device, heard while the window was elsewhere (or on another tab).
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(
    () =>
      session.onTransfer((t) => {
        const d = session.snapshot.device?.id;
        if (t.state !== "open" || !t.targets.some((x) => x.account === me && x.device === d && x.state === "pending")) return;
        if (t.from === me && t.fromDevice === d) return;
        if (document.hasFocus() && viewRef.current === "transfers") return;
        // Once per send: a push of the same one (its sender's progress) is not news.
        if (notifiedTransfers.current.has(t.id)) return;
        notifiedTransfers.current.add(t.id);
        shell?.notify({ title: t.from === me ? `你的「${t.fromDeviceName}」发来文件` : `${t.from} 发来文件`, body: `${transferTitle(t)} · ${transferBytesText(t.totalSize)}，点开确认接收`, threadId: `transfer:${t.id}` });
      }),
    [session, me],
  );
  const notifiedTransfers = useRef(new Set<string>());
  // A notification clicked, or AMO Studio's 在中转里打开 (2026-11-05: --open-thread, also the one the shell started with).
  const openThread = (id: string) => {
    if (id.startsWith("transfer:")) {
      setView("transfers");
      setTransferFilter("pending");
      return;
    }
    const t = threads.find((x) => x.id === id);
    if (t && ofCowork(t)) return showCowork(coworkOf(t)!, t.kind === "request" ? t.id : undefined);
    setView(t && t.kind !== "request" ? "chat" : "queue");
    setOpenId(id);
  };
  // What the shell asks to open (openRequests.ts: a notification, Studio's 在中转里打开 and 打开协作 — 2026-11-23,
  // --open=cowork:<id>): once the lists are in, so what is not in them is one I cannot see — said, not dropped.
  const asked = useOpenRequest();
  useEffect(() => {
    if (!asked || !st.loaded) return;
    const ref = parseOpen(takeOpenRequest() ?? "");
    if (!ref) return;
    if (ref.kind === "cowork") {
      if (st.coworks.some((c) => c.id === ref.id)) return showCowork(ref.id);
      return toast(st.coworksOk ? "打不开这个协作：你不在里面，或者它已经不在了。请发起人把你拉进去" : "打不开这个协作：中转服务还是旧版，没有协作", 6000);
    }
    if (ref.id.startsWith("transfer:") || threads.some((t) => t.id === ref.id)) return openThread(ref.id);
    const sub = st.coworks.find((c) => c.sessions.some((s) => s.id === ref.id));
    if (sub) return showCowork(sub.id, ref.id);
    toast("打不开这个会话：你看不到它，或者它已经不在了", 6000);
  }, [asked, st.loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  // 复制引用's chips in messages (RefChips.tsx): what each names, and opening it.
  const subOf = (id: string) => {
    for (const c of st.coworks) {
      const s = c.sessions.find((x) => x.id === id);
      if (s) return { c, s };
    }
    return null;
  };
  const refs: RefsCtx = {
    device: device?.id ?? null,
    toast,
    describe(ref) {
      const t = ref.kind === "thread" ? threads.find((x) => x.id === ref.id) : undefined;
      const cid = ref.kind === "cowork" ? ref.id : t?.kind === "cowork" ? t.id : null;
      if (cid) {
        const c = st.coworks.find((x) => x.id === cid);
        return c ? { text: `协作「${c.title}」`, hint: "打开这个协作", can: true } : { text: "看不到的协作", hint: "你不在这个协作里，或者它已经不在了", can: false };
      }
      const sub = subOf(ref.id);
      if (sub || (t && ofCowork(t))) {
        const c = sub?.c ?? st.coworks.find((x) => x.id === coworkOf(t!));
        return { text: `子会话「${sub?.s.title ?? t!.title}」`, hint: c ? `打开协作「${c.title}」里的这个子会话` : "打开这个子会话", can: !!c };
      }
      if (t?.kind === "request") return { text: `中转会话「${t.title}」`, hint: "打开这个中转会话", can: true };
      if (t) return { text: `聊天「${chatTitleFor(t, members, me)}」`, hint: "打开这个聊天", can: true };
      return { text: "看不到的会话", hint: "你不在这个会话里，或者它已经不在了", can: false };
    },
    open(ref) {
      if (ref.kind === "cowork") return showCowork(ref.id);
      const sub = subOf(ref.id);
      if (sub) return showCowork(sub.c.id, ref.id);
      openThread(ref.id);
    },
  };

  /** A 协作, and one of its 子会话 opened over it. */
  function showCowork(id: string, sub?: string) {
    setView("cowork");
    setCoworkId(id);
    // (one-shot: cleared when the 协作 is opened another way, so coming back does not open that 子会话 again)
    setCoworkFocus(sub ? (f) => ({ sub, n: (f?.n ?? 0) + 1 }) : null);
  }

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
    else if (v === "transfers") setTransferFilter(pendingFiles.length ? "pending" : "in");
    else if (v === "cowork") {
      setCoworkFocus(null);
      setCoworkId((c) => (c && st.coworks.some((x) => x.id === c) ? c : (st.coworks.find((x) => !x.endedAt) ?? st.coworks[0])?.id ?? null));
    } else setPerson((p) => p ?? listedOthers(members, me)[0]?.name ?? null);
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
      await copyText(`请先运行 "${hookup.cli}" prompt（PowerShell 里写 & "${hookup.cli}" prompt），按它打印的说明用 AMO 中转（推进中卡住、或方案要人把关时，发会话找人确认）。`);
      return toast("已复制一行指令，贴给 agent，它会自己去看用法");
    }
    await copyText(usagePrompt({ me, role: session.me.role, members, cli: hookup?.cli, flow: settings.flow, tasks: full }));
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

  // Who is offered where people are listed and picked: not 测试 or turned-off accounts (2026-11-23, isListed).
  const others = listedOthers(members, me);
  const hidden = unlistedNames(members, me);
  const show = useDisplayName();
  const queueFoot = (
    <>
      <QueueStrip mine={groups.mine.length} handed={groups.handed.length} waiting={groups.waiting.length} onQueue={() => goQueue("mine")} onWaiting={() => goQueue("waiting")} />
      <Shortcuts session={session} flowNew={flowIsNew(flowDoc, me, session.me.server)} flowShortcuts={full} onFlow={openFlow} onQuick={() => setDialog({ kind: "flow" })} onCopyUsage={() => void copyUsage()} />
    </>
  );
  const strips = <StatusStrips session={session} updates={updates} shellUpdate={shellUpdate} onShellUpdate={() => setDialog({ kind: "oldShell" })} />;

  let list;
  if (view === "queue") {
    list = (
      <ListPane
        title="待处理"
        actions={
          full && (
            <button type="button" className="small primary" onClick={() => setDialog({ kind: "session" })}>
              ＋ 新会话
            </button>
          )
        }
        foot={
          <>
            {strips}
            {queueFoot}
          </>
        }
      >
        <ListSection title="待我处理" count={queueCount} />
        {groups.handed.map((t) => (
          <HandedRow key={t.id} task={t} current={false} onOpen={(id) => showTask(id)} />
        ))}
        {groups.mine.map((t) => (
          <SessionRow key={t.id} thread={t} me={me} current={t.id === openId} onOpen={setOpenId} limits={settings} toast={toast} />
        ))}
        {!queueCount && <div className="list-empty">手上没有要处理的。</div>}
        <CoworkWaitingRows session={session} onOpen={showCowork} />
        {pendingFiles.length > 0 && <FilterRow label="等你接收的文件" count={pendingFiles.length} hot current={false} onClick={() => switchView("transfers")} />}
        <ListSection title="等对方 / AI 处理中" count={groups.waiting.length} />
        {groups.waiting.map((t) => (
          <SessionRow key={t.id} thread={t} me={me} current={t.id === openId} onOpen={setOpenId} limits={settings} toast={toast} />
        ))}
        {!groups.waiting.length && <div className="list-empty">没有。</div>}
        {groups.done.length > 0 && (
          <>
            <button type="button" className="nav-fold" onClick={() => setDoneOpen(!doneOpen)}>
              {doneOpen ? "▾" : "▸"} 已完成 {groups.done.length}
            </button>
            {doneOpen && groups.done.map((t) => <SessionRow key={t.id} thread={t} me={me} current={t.id === openId} onOpen={setOpenId} limits={settings} toast={toast} />)}
          </>
        )}
      </ListPane>
    );
  } else if (view === "cowork") {
    list = (
      <ListPane
        title="协作"
        actions={
          st.coworksOk && (
            <button type="button" className="small primary" onClick={() => setDialog({ kind: "cowork" })}>
              ＋ 发起协作
            </button>
          )
        }
        search={{ value: coworkQuery, onChange: setCoworkQuery, placeholder: "搜索协作、目标、成员" }}
        foot={strips}
      >
        <CoworkList session={session} openId={coworkId} query={coworkQuery} onOpen={(id) => (setCoworkFocus(null), setCoworkId(id))} />
      </ListPane>
    );
  } else if (view === "tasks") {
    const live = tasks.filter((t) => !t.archived);
    const row = (f: TaskFilter, label: React.ReactNode, n: number) => <FilterRow key={f.kind === "holder" ? `h:${f.name}` : f.kind} label={label} count={n} current={!taskId && filterLabel(f) === filterLabel(taskFilter)} onClick={() => (setTaskFilter(f), setTaskId(null))} />;
    list = (
      <ListPane
        title="任务"
        actions={
          <button type="button" className="small primary" onClick={() => setDialog({ kind: "task" })}>
            ＋ 新任务
          </button>
        }
        foot={strips}
      >
        <ListSection title="任务" count={live.length} />
        {(
          [
            [{ kind: "mine" }, "我手里的"],
            [{ kind: "created" }, "我创建的"],
            [{ kind: "all" }, "全部任务"],
          ] as Array<[TaskFilter, string]>
        ).map(([f, l]) => row(f, l, live.filter((t) => matches(t, f, me)).length))}
        <ListSection title="按持有人" count={members.filter((m) => !hidden.has(m.name)).length} />
        {members.filter((m) => !hidden.has(m.name)).map((m) =>
          row(
            { kind: "holder", name: m.name },
            <>
              <Avatar name={m.name} small />
              {show(m.name)}
            </>,
            live.filter((t) => t.holder === m.name).length,
          ),
        )}
      </ListPane>
    );
  } else if (view === "transfers") {
    list = (
      <ListPane
        title="传文件"
        actions={
          availability === "ok" && (
            <button type="button" className="small primary" onClick={() => setDialog({ kind: "sendFiles" })}>
              ＋ 发文件
            </button>
          )
        }
        foot={strips}
      >
        <TransferNav session={session} filter={transferFilter} onFilter={setTransferFilter} availability={availability} toast={toast} />
      </ListPane>
    );
  } else if (view === "chat") {
    list = (
      <ListPane title="聊天" search={{ value: chatQuery, onChange: setChatQuery, placeholder: "搜索人、群、话题" }} foot={strips}>
        <ChatList session={session} openId={openId} query={chatQuery} onOpen={setOpenId} onChatWith={(n) => void chatWith(n)} onArchive={(t, a) => void archive(t, a)} />
      </ListPane>
    );
  } else {
    const q = peopleQuery.trim().toLowerCase();
    const found = members.filter((m) => !q || [m.name, m.nick, m.role].some((w) => w.toLowerCase().includes(q)));
    const shown = found.filter((m) => !hidden.has(m.name));
    // At the foot, folded: they are not offered anywhere else, but an admin finds them here (the user, 2026-11-23).
    const set = found.filter((m) => hidden.has(m.name));
    const unknown = connection === "offline";
    const hiddenWhy = (m: Member) => (m.disabled ? "! 已停用" : `${m.kind && isAccountKind(m.kind) ? ACCOUNT_KINDS[m.kind].label : (m.kind ?? "")}账号`);
    const personRow = (m: Member) => (
      <ListRow
        key={m.name}
        className="person-row"
        avatar={<Avatar name={m.name} />}
        title={
          <>
            <Who name={m.name} />
            {m.name === me ? "（我）" : ""}
          </>
        }
        sub={[hidden.has(m.name) ? hiddenWhy(m) : null, m.role || "没写负责什么", unknown ? null : m.online ? "在线" : m.lastSeen ? seenText(Date.now() - m.lastSeen) : "不在线"].filter(Boolean).join(" · ")}
        dot={m.online && !unknown ? "on" : "off"}
        current={person === m.name}
        onClick={() => setPerson(m.name)}
      />
    );
    list = (
      <ListPane title="成员" search={{ value: peopleQuery, onChange: setPeopleQuery, placeholder: "搜索成员" }} foot={strips}>
        {unknown ? (
          <>
            <ListSection title="成员 · 在线状态未知" count={shown.length} />
            {shown.map(personRow)}
          </>
        ) : (
          <>
            <ListSection title="在线" count={shown.filter((m) => m.online).length} />
            {shown.filter((m) => m.online).map(personRow)}
            <ListSection title="不在线" count={shown.filter((m) => !m.online).length} />
            {shown.filter((m) => !m.online).map(personRow)}
          </>
        )}
        {set.length > 0 && (
          <>
            <button type="button" className="nav-fold" data-testid="people-hidden" aria-expanded={hiddenOpen} onClick={() => setHiddenOpen(!hiddenOpen)} title="这些账号不出现在聊天列表和选人的地方；聊过的记录照常显示。在服务器的管理页里改">
              {hiddenOpen ? "▾" : "▸"} 已停用 / 测试账号 {set.length}
            </button>
            {hiddenOpen && set.map(personRow)}
          </>
        )}
        {!others.length && <div className="list-empty">还没有其他人。把服务器的地址发给同事，让他们注册。</div>}
      </ListPane>
    );
  }

  let main;
  if (view === "queue" && open?.kind === "request")
    main = <SessionView key={open.id} session={session} thread={open} toast={toast} onOpenTask={full ? (id) => showTask(id, open.id) : undefined} onHelp={(section) => setDialog({ kind: "help", section: section as HelpSection })} onTakeover={full ? (t) => { const task = tasks.find((x) => x.id === t.request?.taskId); if (task) setDialog({ kind: "transfer", task, thread: t }); } : undefined} />;
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
  else if (view === "transfers") main = <TransferMain session={session} engine={engine} filter={transferFilter} availability={availability} onSend={() => setDialog({ kind: "sendFiles" })} toast={toast} />;
  else if (view === "tasks") main = <Board session={session} filter={taskFilter} onOpen={(id) => showTask(id)} toast={toast} />;
  else if (view === "chat" && open && open.kind !== "request")
    main = <ChatView key={open.id} session={session} thread={open} toast={toast} onArchive={(t, a) => void archive(t, a)} onNewTopic={newTopic} />;
  else if (view === "people" && person)
    main = (
      <PersonView
        name={person}
        session={session}
        threads={threads}
        availability={availability}
        onChat={(n) => void chatWith(n)}
        onAsk={full ? (n) => setDialog({ kind: "session", to: n }) : undefined}
        onSendFiles={(n) => setDialog({ kind: "sendFiles", to: n })}
        onOpen={(id) => (setView("queue"), setOpenId(id))}
        onOpenChat={(id) => (setView("chat"), setOpenId(id))}
      />
    );
  else if (view === "cowork" && openCowork) main = <CoworkView key={openCowork.id} session={session} cowork={openCowork} toast={toast} focus={coworkFocus} />;
  else
    main = (
      <div className="placeholder">
        {view === "queue" ? (
          <>
            <h2>手上的事都在左边</h2>
            {full ? (
              <p>待处理里只有要你动手的：收到的会话、返回给你的会话。点「＋ 新会话」请同事处理一件事；想让 AI 自己去问人，点左边列表下面的「复制用法」。</p>
            ) : (
              <p>同事的 AI 卡住了、或方案想让你把关时，会发会话给你，出现在左边；你回复后，会话回到它手里。想让自己的 AI 这样找人，点左边列表下面的「复制用法」贴给它。人和人之间直接在「聊天」里说。</p>
            )}
          </>
        ) : view === "cowork" ? (
          <>
            <h2>几个人带着各自的 AI 一起推进一件事</h2>
            <p>群聊是主体：@ 人、@ 某个 AI（只有被 @ 的 AI 会被唤醒）；要和某人确认的事开成子会话，折叠成一张卡；目标、已定的事和白板围着它。点左上「＋ 发起协作」开始。</p>
          </>
        ) : view === "chat" ? (
          <>
            <h2>还没有对话</h2>
            <p>点左边的同事开始私聊；在对话上方的「＋ 新话题」里，和同一个人还可以开多个话题。</p>
          </>
        ) : (
          <h2>选一个成员</h2>
        )}
      </div>
    );

  const rail: Array<[View, string, React.ReactNode, number]> = [
    ["queue", "待处理", ICONS.queue, queueCount],
    ["cowork", "协作", ICONS.cowork, coworkUnreadCount(session)],
    ...(full ? [["tasks", "任务", ICONS.tasks, 0] as [View, string, React.ReactNode, number]] : []),
    ["chat", "聊天", ICONS.chat, chatUnread],
    ["transfers", "传文件", ICONS.transfers, pendingFiles.length],
    ["people", "成员", ICONS.people, 0],
  ];
  const people = useMemo(() => new Map(members.map((m) => [m.name, m])), [members]);
  const meShown = people.get(me)?.nick ? `${people.get(me)!.nick}(${me})` : me;
  // A task's page has its own column of sessions: the list makes room for it.
  const listShown = !(view === "tasks" && openTask);
  return (
    <PeopleContext.Provider value={people}>
    <RefsContext.Provider value={refs}>
    <div className="app layout-a">
      <header className={`topbar ${ownTitleBar ? "own" : ""} ${macLights ? "mac" : ""}`}>
        <div className="brand">
          <img className="brand-mark" src={iconUrl} alt="" />
          <span className="brand-name">AMO 中转</span>
          <span className="brand-sep">{session.me.service}</span>
        </div>
        <span className="grow" />
        <ConnChip session={session} />
        <WindowControls />
      </header>
      <div className="body">
        <Rail
          foot={
            <>
              <RailItem label="说明" icon={ICONS.help} title="中转怎么用：会话的状态和按钮是什么意思" onClick={() => setDialog({ kind: "help" })} />
              <RailItem label="设置" icon={ICONS.settings} title="设置：字体大小、主题、接入 AI、我的资料" onClick={() => setDialog({ kind: "settings" })} />
              <button type="button" className="me-chip" title={`我的资料：${meShown} · ${{ online: "服务器在线", connecting: "正在连接服务器", offline: "服务器离线" }[connection]}（昵称、头像、负责什么在 AMO 平台的「账号」里改）`} aria-label="我的资料" onClick={() => setDialog({ kind: "settings", part: "profile" })}>
                <Avatar name={me} />
                <span className={`me-dot ${connection}`} />
              </button>
            </>
          }
        >
          {rail.map(([v, label, icon, n]) => (
            <RailItem key={v} label={label} icon={icon} badge={n} current={view === v} onClick={() => switchView(v)} />
          ))}
        </Rail>
        {view === "cowork" ? (
          // 协作's 子会话 and 白板 float over its whole page (list, 群聊, 信息栏), one set per 协作.
          <FloatArea key={coworkId ?? ""} className="cowork-page">
            {list}
            <main className="main-col">{main}</main>
          </FloatArea>
        ) : (
          <>
            {listShown && list}
            <main className="main-col">{main}</main>
          </>
        )}
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
          onLogout={onLogout}
          onOpenFile={(id) => setDialog({ kind: "file", id, scripts: settings.flowScripts !== false && !!flowDoc && /\.html?$/i.test(flowDoc.name) })}
        />
      )}
      {dialog?.kind === "sendFiles" && availability === "ok" && (
        <SendDialog
          session={session}
          members={members.filter((m) => !hidden.has(m.name) || m.name === dialog.to)}
          to={dialog.to}
          onClose={() => setDialog(null)}
          onSent={() => {
            setDialog(null);
            setView("transfers");
            setTransferFilter("out");
            toast("已发出，对方确认后开始上传");
          }}
          toast={toast}
        />
      )}
      {dialog?.kind === "cowork" && <NewCoworkDialog session={session} onClose={() => setDialog(null)} onMade={(id) => (setDialog(null), showCowork(id), toast("协作发起了：在信息栏里补目标，大家再把各自的 AI 拉进来"))} />}
      {dialog?.kind === "help" && <HelpDialog section={dialog.section} onClose={() => setDialog(null)} />}
      {dialog?.kind === "file" && <FileViewer session={session} fileId={dialog.id} scripts={dialog.scripts} onClose={() => setDialog(null)} toast={toast} />}
      {toastText && <div className="toast">{toastText}</div>}
      <MenuHost />
    </div>
    </RefsContext.Provider>
    </PeopleContext.Provider>
  );
}

function SessionRow({ thread, me, current, onOpen, limits, toast }: { thread: Thread; me: string; current: boolean; onOpen: (id: string) => void; limits?: { aiLateMinutes: number; aiStuckMinutes: number }; toast?: (t: string) => void }) {
  const r = thread.request!;
  const s = sessionStatus(thread, me, Date.now(), limits);
  const at = r.state === "returned" ? (r.returnedAt ?? thread.updatedAt) : thread.updatedAt;
  return (
    <button
      type="button"
      className={`srow ${thread.unread ? "unread" : ""}`}
      aria-current={current ? "true" : undefined}
      onClick={() => onOpen(thread.id)}
      onContextMenu={toast && ((e) => openMenu(e, [{ label: "复制引用", hint: "贴进聊天或 AI 会话：人看到标题，AI 认得 thread:<id>", onClick: () => copyRef(requestRef(thread), `中转会话「${thread.title}」`, toast) }]))}
    >
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

/** 「刚刚在线」 / 「3 分钟前在线」. */
const seenText = (ms: number) => (ms < 60_000 ? "刚刚在线" : `${waitedText(ms)}前在线`);

function PersonView(props: { name: string; session: Session; threads: Thread[]; availability: TransferAvailability; onChat: (name: string) => void; onAsk?: (name: string) => void; onSendFiles: (name: string) => void; onOpen: (id: string) => void; onOpenChat: (id: string) => void }) {
  const me = props.session.me.name;
  const { members, connection } = useSession(props.session);
  const m = members.find((x) => x.name === props.name);
  const between = props.threads.filter((t) => t.kind === "request" && !ofCowork(t) && t.members.includes(props.name) && t.members.includes(me) && props.name !== me);
  const live = between.filter((t) => t.request!.state !== "done");
  // Their devices (layout A's member page): the ones a send can go to, online first.
  const [devices, setDevices] = useState<RelayDevice[] | null>(null);
  useEffect(() => {
    if (props.availability !== "ok") return;
    let gone = false;
    setDevices(null);
    props.session.client
      .transferDevices()
      .then((d) => !gone && setDevices(d.filter((x) => x.account === props.name).sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen)))
      .catch(() => !gone && setDevices([]));
    return () => {
      gone = true;
    };
  }, [props.session, props.name, props.availability]);
  const state = connection === "offline" ? "在线状态未知" : m?.online ? "在线" : "不在线";
  return (
    <section className="view person-view">
      <header className="page-head person-head">
        <Avatar name={props.name} big />
        <div className="head-main">
          <h1 className="head-title">
            <Who name={props.name} />
            {props.name === me ? "（我）" : ""}
          </h1>
          <div className="head-meta">
            {m?.role || "（没写负责什么）"} · {state}
          </div>
        </div>
        {props.name !== me && (
          <div className="head-actions">
            <button type="button" onClick={() => props.onChat(props.name)}>
              私聊
            </button>
            {props.availability === "ok" && (
              <button type="button" onClick={() => props.onSendFiles(props.name)} title="发文件或文件夹到对方的设备，对方确认后开始传">
                发文件
              </button>
            )}
            {props.onAsk && (
              <button type="button" className="primary" onClick={() => props.onAsk!(props.name)}>
                发起会话
              </button>
            )}
          </div>
        )}
      </header>
      <div className="pane">
        {props.availability === "ok" && (
          <>
            <h3>
              设备 <span className="muted tiny">登录过中转客户端的，发文件时能选</span>
            </h3>
            <div className="devs">
              {devices === null && <span className="muted tiny">正在读设备…</span>}
              {devices?.map((d) => (
                <span key={d.id} className="dev">
                  <span className={`dot ${d.online ? "on" : ""}`} />
                  {d.name} · {d.online ? "在线" : d.lastSeen ? seenText(Date.now() - d.lastSeen) : "不在线"}
                </span>
              ))}
              {devices?.length === 0 && <span className="muted tiny">还没有。对方登录一次桌面客户端就有了。</span>}
            </div>
          </>
        )}
        {props.name !== me && (
          <>
            <h3>和你之间进行中的会话 · {live.length}</h3>
            {live.map((t) => (
              <SessionRow key={t.id} thread={t} me={me} current={false} onOpen={props.onOpen} />
            ))}
            {!live.length && <div className="muted tiny">没有。</div>}
            <SharedGroups session={props.session} name={props.name} onOpen={props.onOpenChat} />
          </>
        )}
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
