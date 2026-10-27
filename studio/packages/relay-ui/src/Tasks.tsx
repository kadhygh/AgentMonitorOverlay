import { useEffect, useState } from "react";
import { Avatar, timeText, waitedText } from "./bits.js";
import { Dialog } from "./Dialog.js";
import { DropZone, FileRow, FileViewer, PickFiles, useUpload } from "./Files.js";
import { copyText, shell } from "./env.js";
import { Markdown } from "./Markdown.js";
import { errorText } from "./Messages.js";
import { useSession, type Session } from "./session.js";
import { SessionView } from "./SessionView.js";
import { ARCHIVABLE, TASK_STATUSES, taskPrompt, type TaskEvent, type TaskSession, type TaskStatus, type TaskView, type TeamSettings, type ThreadView } from "./shared.js";

// Team tasks (stage 2b, plans/relay-tasks.md), in AMO Studio's shapes: a board of cards in four columns (Studio
// board.css), a task page with its list on the left — 概要, 记录, the sessions under it (Studio task.css) — and the
// dialogs: 流转 (also 接手任务 from a session), a new task, 流程速查 and the team's settings.

export type TaskFilter = { kind: "mine" } | { kind: "created" } | { kind: "all" } | { kind: "holder"; name: string };
export const filterLabel = (f: TaskFilter) => (f.kind === "mine" ? "我手里的" : f.kind === "created" ? "我创建的" : f.kind === "all" ? "全部任务" : `${f.name} 手里的`);
export const matches = (t: TaskView, f: TaskFilter, me: string) => (f.kind === "mine" ? t.holder === me : f.kind === "created" ? t.creator === me : f.kind === "holder" ? t.holder === f.name : true);

const stChip = (s: TaskStatus) => <span className={`chip st-${s}`}>{s}</span>;

export function Board({ session, filter, onOpen, toast }: { session: Session; filter: TaskFilter; onOpen: (id: string) => void; toast: (t: string) => void }) {
  const { tasks } = useSession(session);
  const me = session.me.name;
  const [showArchived, setShowArchived] = useState(false);
  const list = tasks.filter((t) => matches(t, filter, me));
  const archived = list.filter((t) => t.archived).length;
  return (
    <section className="view board-wrap">
      <div className="board-head">
        <h1>{filterLabel(filter)}</h1>
        <span className="grow" />
        {archived > 0 && (
          <button type="button" className="tb-btn small" onClick={() => setShowArchived(!showArchived)}>
            {showArchived ? "收起已归档" : `已归档 ${archived}`}
          </button>
        )}
      </div>
      <div className="board">
        {TASK_STATUSES.map((st) => {
          const col = list.filter((t) => t.status === st && (!t.archived || showArchived));
          return (
            <section key={st} className="column" aria-label={st}>
              <div className="column-head">
                <span className="column-name">{st}</span>
                <span className="column-count">{col.length}</span>
              </div>
              {col.map((t) => (
                <TaskCard key={t.id} task={t} me={me} onOpen={onOpen} onArchive={() => void archive(session, t, toast)} />
              ))}
              {!col.length && <div className="empty-col">没有</div>}
            </section>
          );
        })}
      </div>
    </section>
  );
}

async function archive(session: Session, t: TaskView, toast: (t: string) => void, archived = true) {
  try {
    await session.client.archiveTask(t.id, archived);
    toast(archived ? "已归档：看板右上角「已归档」里能找到" : "已放回看板");
  } catch (err) {
    toast(errorText(err));
  }
}

function TaskCard({ task, me, onOpen, onArchive }: { task: TaskView; me: string; onOpen: (id: string) => void; onArchive: () => void }) {
  const live = task.sessions.filter((s) => s.state !== "done");
  const mine = live.filter((s) => s.waitingOn === me).length;
  return (
    <div className={`card ${task.holder === me ? "mine" : ""} ${task.archived ? "archived" : ""}`} role="button" tabIndex={0} onClick={() => onOpen(task.id)} onKeyDown={(e) => e.key === "Enter" && onOpen(task.id)}>
      <div className="card-where">
        <Avatar name={task.holder} small />
        <span className="card-holder">{task.holder === me ? "在我手里" : `在 ${task.holder} 手里`}</span>
        {task.unseen && <span className="chip attn">刚交给你</span>}
      </div>
      <div className="card-title">{task.title}</div>
      <div className={`card-status ${mine ? "attn" : ""}`}>
        <span className={`dot ${mine ? "attn" : live.length ? "run" : ""}`} />
        {live.length ? `${live.length} 个会话进行中${mine ? ` · ${mine} 个等你` : ""}` : "没有进行中的会话"}
      </div>
      <div className="card-meta">
        <span>
          {task.creator} 创建 · {timeText(task.createdAt)}
        </span>
        <span className="grow" />
        {!task.archived && ARCHIVABLE.includes(task.status) && (
          <button
            type="button"
            className="small"
            onClick={(e) => {
              e.stopPropagation();
              onArchive();
            }}
          >
            归档
          </button>
        )}
        {task.archived && <span className="chip">已归档</span>}
      </div>
    </div>
  );
}

/** 概要, 记录, or a session under the task (its id). */
export type TaskPane = "overview" | "log" | string;

export function TaskPage(props: {
  session: Session;
  task: TaskView;
  pane: TaskPane;
  onPane: (p: TaskPane) => void;
  onBack: () => void;
  toast: (t: string) => void;
  onNewSession: (taskId: string) => void;
  onTransfer: (task: TaskView, thread?: ThreadView) => void;
}) {
  const { session, task, toast } = props;
  const { threads, members, settings } = useSession(session);
  const me = session.me.name;
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [editing, setEditing] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const { upload, busy: uploading } = useUpload(session, { taskId: task.id }, toast);

  // 记录: loaded with the page and again whenever the task moves.
  useEffect(() => {
    let alive = true;
    session.client
      .task(task.id)
      .then((r) => alive && setEvents(r.events))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [session, task.id, task.updatedAt]);
  // On screen with the window in front: a hand-over to me is seen.
  useEffect(() => {
    if (!task.unseen) return;
    const see = () => document.hasFocus() && session.seeTask(task.id);
    see();
    window.addEventListener("focus", see);
    return () => window.removeEventListener("focus", see);
  }, [session, task.id, task.unseen]);

  const copyPrompt = async () => {
    const hookup = shell ? await shell.mcp().catch(() => null) : null;
    await copyText(taskPrompt(task, events, { me, role: session.me.role, members, cli: hookup?.cli, flow: settings.flow }));
    toast("已复制任务提示词：任务内容 + 团队流程 + 用法，贴给 AI 就能开始");
  };

  const decisions = events.filter((e) => e.kind === "decision");
  const open = task.sessions.filter((s) => s.state !== "done");
  let content;
  if (props.pane === "overview") {
    content = (
      <div className="pane">
        {editing ? (
          <TaskEditor session={session} task={task} onDone={() => setEditing(false)} toast={toast} />
        ) : (
          <>
            <h3>
              说明
              <button type="button" className="link tiny" onClick={() => setEditing(true)}>
                编辑
              </button>
            </h3>
            {task.description.trim() ? <Markdown source={task.description} /> : <div className="muted tiny">还没写说明。</div>}
          </>
        )}
        <h3>决策</h3>
        {decisions.map((e) => (
          <div key={e.id} className="box-row dec">
            ✓ {e.text}
            <span className="grow" />
            <span className="muted tiny">
              {e.actor} · {timeText(e.at)}
            </span>
          </div>
        ))}
        {!decisions.length && <div className="hint">还没有。会话里的回复（逐条回答和结论）会自动记到这里。</div>}
        <h3>
          文件
          <PickFiles small label={uploading ? "上传中…" : "上传文件"} disabled={uploading} onFiles={(fl) => void upload(fl)} />
        </h3>
        {task.files.map((f) => (
          <FileRow key={f.id} file={f} onOpen={setViewing} />
        ))}
        <div className="hint">把文件拖到这页上传（最多 20 MB）；AI 用 relay_file_put 传本机文件。同名再传就是新版本，打开文件可以批注。</div>
        <h3>进行中的会话</h3>
        {open.map((s) => (
          <button key={s.id} type="button" className="box-row" onClick={() => props.onPane(s.id)}>
            <b>{s.title}</b>
            <span className="muted tiny">
              {s.from}
              {s.byAi ? " 的 AI" : ""} → {s.to}
            </span>
            <span className="grow" />
            <span className="muted tiny">{briefState(s)}</span>
          </button>
        ))}
        {!open.length && <div className="muted tiny">没有。点左边「会话」旁的 ＋ 在这个任务下发一个。</div>}
      </div>
    );
  } else if (props.pane === "log") {
    content = (
      <div className="pane">
        <h3>记录</h3>
        <ul className="log">
          {[...events].reverse().map((e) => (
            <li key={e.id}>
              <span className="t">{timeText(e.at)}</span>
              <span>
                {e.kind === "decision" ? (
                  <div className="d">决策：{e.text}</div>
                ) : (
                  <>
                    {e.actor}
                    {e.via.kind === "ai" && !e.text.startsWith("的 AI") ? " 的 AI" : ""} {e.text}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  } else {
    const thread = threads.find((t) => t.id === props.pane);
    const brief = task.sessions.find((s) => s.id === props.pane);
    content = thread ? (
      <SessionView key={thread.id} session={session} thread={thread} toast={toast} embedded onTakeover={(t) => props.onTransfer(task, t)} />
    ) : (
      <div className="placeholder">
        <h2>{brief?.title ?? "会话"}</h2>
        <p>
          这是 {brief?.from} 和 {brief?.to} 之间的会话，{brief ? briefState(brief) : ""}。内容只有他们两人能看；结论会记进这个任务的决策。
        </p>
      </div>
    );
  }

  const navRow = (p: TaskPane, label: string, n?: number) => (
    <button type="button" className="nav-row" aria-current={props.pane === p ? "true" : undefined} onClick={() => props.onPane(p)}>
      <span className="name">{label}</span>
      {n !== undefined && <span className="count">{n}</span>}
    </button>
  );
  return (
    <section className="view">
      <header className="page-head">
        <div className="head-main">
          <div className="page-crumb">
            <button type="button" className="link" onClick={props.onBack}>
              任务
            </button>{" "}
            / {task.creator} 创建
          </div>
          <h1 className="head-title">{task.title}</h1>
          <div className="head-meta">
            {stChip(task.status)}
            <span>
              在 <b>{task.holder}</b> 手里
            </span>
            {task.archived && <span className="chip">已归档</span>}
          </div>
        </div>
        <div className="head-actions">
          <button type="button" onClick={() => void copyPrompt()} title="任务内容 + 团队流程 + 用法，贴给 AI 就能开始">
            复制任务提示词
          </button>
          {task.archived ? (
            <button type="button" onClick={() => void archive(session, task, toast, false)}>
              放回
            </button>
          ) : (
            ARCHIVABLE.includes(task.status) && (
              <button type="button" onClick={() => void archive(session, task, toast)}>
                归档
              </button>
            )
          )}
          <button type="button" className="primary" onClick={() => props.onTransfer(task)}>
            流转…
          </button>
        </div>
      </header>
      <div className="task-body">
        <aside className="session-list">
          {navRow("overview", "概要")}
          {navRow("log", "记录", events.length)}
          <div className="nav-label">
            会话<span className="count">{task.sessions.length}</span>
            <span className="rule" />
            <button type="button" className="x small-x" title="在这个任务下新建会话" onClick={() => props.onNewSession(task.id)}>
              ＋
            </button>
          </div>
          {task.sessions.map((s) => (
            <button key={s.id} type="button" className="srow" aria-current={props.pane === s.id ? "true" : undefined} onClick={() => props.onPane(s.id)}>
              <div className="srow-top">
                <span className={`dot ${s.state === "done" ? "done" : s.waitingOn === me ? "attn" : "run"}`} />
                <span className="srow-title">{s.title}</span>
                {s.byAi && <span className="tag ai">AI</span>}
              </div>
              <div className="srow-meta">
                <span className={`t ${s.waitingOn === me && s.state !== "done" ? "warn" : ""}`}>{briefState(s)}</span>
              </div>
            </button>
          ))}
          {!task.sessions.length && <div className="nav-empty">还没有会话。</div>}
        </aside>
        <DropZone className="content" onFiles={(fl) => void upload(fl)}>
          {content}
        </DropZone>
      </div>
      {viewing && <FileViewer session={session} fileId={viewing} onClose={() => setViewing(null)} toast={toast} />}
    </section>
  );
}

function briefState(s: TaskSession): string {
  if (s.state === "done") return "已完成";
  if (s.state === "open") return `在 ${s.to} 手里`;
  return `已返回给 ${s.from}${s.byAi ? " 的 AI" : ""}`;
}

function TaskEditor({ session, task, onDone, toast }: { session: Session; task: TaskView; onDone: () => void; toast: (t: string) => void }) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await session.client.updateTask(task.id, { title: title.trim(), description, status });
      onDone();
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="form editor">
      <label>
        标题
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        说明（Markdown）
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={10} />
      </label>
      <label>
        状态 <span className="muted tiny">（换人用「流转…」）</span>
        <select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
          {TASK_STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
      <div className="dialog-foot">
        <button type="button" onClick={onDone}>
          取消
        </button>
        <button type="button" className="primary" disabled={busy || !title.trim()} onClick={() => void save()}>
          保存
        </button>
      </div>
    </div>
  );
}

/** 流转 — or 接手任务 from a session (`thread`): then the session is answered (when it needs a reply) or closed too. */
export function TransferDialog({ session, task, thread, onClose, toast }: { session: Session; task: TaskView; thread?: ThreadView; onClose: () => void; toast: (t: string) => void }) {
  const me = session.me.name;
  const { members } = useSession(session);
  const [to, setTo] = useState(thread ? me : task.holder);
  const [status, setStatus] = useState<TaskStatus>(thread ? "开发中" : task.status);
  const [reason, setReason] = useState("");
  const [withSession, setWithSession] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const r = thread?.request;
  const asker = r ? `${r.from}${r.byAi ? " 的 AI" : ""}` : "";
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await session.client.transferTask(task.id, { to, status, reason: reason.trim(), threadId: thread?.id, closeSession: thread ? withSession : undefined });
      onClose();
      toast(t.holder === me ? `「${t.title}」现在在你手里` : `已流转给 ${t.holder}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={thread ? "接手任务" : "流转任务"} onClose={onClose}>
      <p className="dim small" style={{ margin: 0 }}>
        「{task.title}」现在在 {task.holder} 手里，{task.status}。会写进任务记录，新的持有人会在待处理里收到。
      </p>
      <div className="form" style={{ marginTop: 0 }}>
        <div className="fgrid">
          <label>
            交给
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {members.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                  {m.name === me ? "（我）" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            新状态
            <select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
              {TASK_STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          原因
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="写清楚为什么、接下来谁做什么" autoFocus />
        </label>
        {thread && r && (
          <label className="check">
            <input type="checkbox" checked={withSession} onChange={(e) => setWithSession(e.target.checked)} />
            {r.to === me && r.needsReply ? `同时回复会话「${thread.title}」，告诉 ${asker} 我已接手（会话回到发起方，由对方标记完成）` : `同时结束会话「${thread.title}」`}
          </label>
        )}
        {error && <div className="notice error">{error}</div>}
        <div className="dialog-foot">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => void go()}>
            {thread ? "接手" : "流转"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function NewTaskDialog({ session, onClose, onMade }: { session: Session; onClose: () => void; onMade: (id: string) => void }) {
  const me = session.me.name;
  const { members } = useSession(session);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [holder, setHolder] = useState(me);
  const [status, setStatus] = useState<TaskStatus>("开发中");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await session.client.createTask({ title: title.trim(), description, holder, status });
      onMade(t.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="新建团队任务" onClose={onClose} wide>
      <div className="form" style={{ marginTop: 0 }}>
        <label>
          标题
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="比如：加特林" autoFocus />
        </label>
        <label>
          说明 <span className="muted tiny">（Markdown：要做什么、目标、范围；以后可以改）</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={6} />
        </label>
        <div className="fgrid">
          <label>
            持有人
            <select value={holder} onChange={(e) => setHolder(e.target.value)}>
              {members.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                  {m.name === me ? "（我）" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            状态
            <select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
              {TASK_STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="muted tiny">建好后可以传文件进来，再点「复制任务提示词」贴给 AI 初审。</div>
        {error && <div className="notice error">{error}</div>}
        <div className="dialog-foot">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy || !title.trim()} onClick={() => void make()}>
            新建
          </button>
        </div>
      </div>
    </Dialog>
  );
}

const COMMANDS: Array<[string, string]> = [
  ["初审任务", "用 amo-relay 的 relay_task_get 读任务 <taskId> 和附件，按团队流程初审；需要别人确认的点，用 relay_session_open 在这个任务下发会话（带 taskId），问题里带上推进方式。"],
  ["取回回复", "用 relay_queue 看有没有返回给我的会话，用 relay_session_get 取回复和批注，按团队流程继续；处理完用 relay_session_reply 继续追问（then: \"ask\"）或标记完成（then: \"done\"）。"],
  ["送去终审", "开发完成后用 relay_task_transfer 把任务流转给程序终审，状态写「待处理」，原因里写清改了什么、在哪个分支。"],
];

/** 流程速查: phrases to paste into an AI or a reply — 推进方式 and the like, the usual commands, the whole flow. */
export function FlowDialog({ settings, onClose, toast }: { settings: TeamSettings; onClose: () => void; toast: (t: string) => void }) {
  const kw = (label: string, text: string) => (
    <div className="kw" key={label}>
      <div className="tx">
        {label}
        {label !== text && <small>{text.length > 120 ? `${text.slice(0, 120)}…` : text}</small>}
      </div>
      <button type="button" className="small" onClick={() => void copyText(text).then(() => toast("已复制"))}>
        复制
      </button>
    </div>
  );
  return (
    <Dialog title="流程速查" onClose={onClose} wide>
      <p className="dim small" style={{ margin: 0 }}>
        推进时随手复制，贴给 AI 或写进回复。内容在「设置」里改，全队共用。
      </p>
      <div className="kw-group">推进方式和常用说法</div>
      {settings.keywords.map((k) => kw(k, k))}
      {!settings.keywords.length && <div className="muted tiny">还没有，在设置里加。</div>}
      <div className="kw-group">常用指令（贴给 AI）</div>
      {COMMANDS.map(([l, t]) => kw(l, t))}
      <div className="kw-group">团队流程</div>
      {kw("整段团队流程", settings.flow)}
      <div className="dialog-foot">
        <button type="button" className="primary" onClick={onClose}>
          好
        </button>
      </div>
    </Dialog>
  );
}

export function SettingsDialog({ session, onClose, toast }: { session: Session; onClose: () => void; toast: (t: string) => void }) {
  const { settings } = useSession(session);
  const [flow, setFlow] = useState(settings.flow);
  const [keywords, setKeywords] = useState(settings.keywords.join("\n"));
  const [late, setLate] = useState(String(settings.aiLateMinutes));
  const [stuck, setStuck] = useState(String(settings.aiStuckMinutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await session.client.saveSettings({
        flow,
        keywords: keywords
          .split("\n")
          .map((k) => k.trim())
          .filter(Boolean),
        aiLateMinutes: Number(late),
        aiStuckMinutes: Number(stuck),
      });
      onClose();
      toast("设置已保存，全队都会用新的");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="设置" onClose={onClose} wide>
      <p className="dim small" style={{ margin: 0 }}>
        团队共用，任何人都能改。
      </p>
      <div className="form" style={{ marginTop: 0 }}>
        <label>
          团队流程 <span className="muted tiny">（放进 MCP 说明、复制用法、复制任务提示词）</span>
          <textarea value={flow} onChange={(e) => setFlow(e.target.value)} rows={8} />
        </label>
        <label>
          流程速查里的推进方式和常用说法 <span className="muted tiny">（一行一条）</span>
          <textarea value={keywords} onChange={(e) => setKeywords(e.target.value)} rows={4} />
        </label>
        <div className="fgrid">
          <label>
            回复到了，AI 多少分钟没取回就高亮
            <input type="number" min={1} max={1440} value={late} onChange={(e) => setLate(e.target.value)} />
          </label>
          <label>
            AI 取回后多少分钟没动作算卡住
            <input type="number" min={1} max={1440} value={stuck} onChange={(e) => setStuck(e.target.value)} />
          </label>
        </div>
        {error && <div className="notice error">{error}</div>}
        <div className="dialog-foot">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
            保存
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/** A task handed to me, in 待处理. */
export function HandedRow({ task, current, onOpen }: { task: TaskView; current: boolean; onOpen: (id: string) => void }) {
  const h = task.handoff!;
  return (
    <button type="button" className="srow unread" aria-current={current ? "true" : undefined} onClick={() => onOpen(task.id)}>
      <div className="srow-top">
        <span className="dot attn" />
        <span className="srow-title">任务交给你：{task.title}</span>
        <span className="srow-time">{waitedText(Date.now() - h.at)}</span>
      </div>
      <div className="srow-meta">
        <span className="t warn">
          {h.by} 流转 · {h.status}
          {h.reason ? ` · ${h.reason}` : ""}
        </span>
      </div>
    </button>
  );
}
