import { useState } from "react";
import {
  LOCAL_PERSON,
  LOCAL_VIA_LABEL,
  MATTER_STATUS_LABEL,
  RECEIPT_STATE_LABEL,
  isQueued,
  receiptSummary,
  type Id,
  type LocalPendingView,
  type LocalThread,
  type MailMessage,
  type MailRecipient,
  type Matter,
  type MatterKind,
  type Party,
  type PendingEntry,
  type PendingGroup,
  type PendingSnapshot,
  type Session,
  type StateSnapshot,
} from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { showError, showToast } from "../lib/toast.js";
import { PENDING_KIND_LABEL } from "../pending/pending.js";

// 待我处理 (2026-11-25, plans/collab-framework.md「留言和主控的来往」, the user 11-24: 留言页换成「待我处理」): what used to
// be the task page's 留言 panel. The Host's part is local (GET /api/local-pending): messages waiting for the person to send
// them in (先问 by distance, or an agent's that did not go in by itself), and the 事项 the sessions have going, grouped by
// 事项 and by the task (or topic) they belong to. By default only what is not seen or not handled yet is open; 事项 where
// every message is handled fold away below. The 协作's groups (from the 中转) and each 主控's come from GET /api/pending
// (features/pending, protocol/src/pending.ts, 「协作·Studio 接入」's), the local one is source "local" there.

const KIND_LABEL: Record<MatterKind, string> = { delegate: "委派", notice: "通知", work: "工作", confirm: "确认" };

/** What the names on this page are read from. */
export interface Names {
  sessions: readonly Session[];
  tasks: readonly StateSnapshot["tasks"][number][];
  topics: readonly StateSnapshot["topics"][number][];
}

const firstLine = (title: string | null | undefined, fallback: string) => {
  const line = (title || "").split("\n").map((l) => l.trim()).find((l) => l && !/^【.*】$/.test(l)) ?? "";
  if (!line) return fallback;
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
};

export function taskName(n: Names, id: Id | null | undefined): string {
  return firstLine(n.tasks.find((t) => t.id === id)?.title, "未命名任务");
}

export function sessionName(n: Names, id: Id): string {
  const s = n.sessions.find((x) => x.id === id);
  if (!s) return "会话（已不在）";
  const own = firstLine(s.title, "会话");
  if (s.taskId) return `${taskName(n, s.taskId)} · ${own}`;
  if (s.topicId) return `专题「${firstLine(n.topics.find((t) => t.id === s.topicId)?.title, "未命名专题")}」· ${own}`;
  return own;
}

export function partyName(n: Names, p: Party): string {
  if (p === LOCAL_PERSON || p.startsWith("person:")) return "我";
  const id = p.slice("agent:".length);
  if (id.startsWith("task:")) return `任务「${taskName(n, id.slice(5))}」`;
  if (id.startsWith("topic:")) return `专题「${firstLine(n.topics.find((t) => t.id === id.slice(6))?.title, "未命名专题")}」`;
  return sessionName(n, id);
}

const fromName = (n: Names, m: MailMessage) => (m.fromSessionId ? sessionName(n, m.fromSessionId) : "我");

function toName(n: Names, to: MailRecipient): string {
  if (to.kind === "session") return sessionName(n, to.sessionId);
  if (to.kind === "task") return `任务「${taskName(n, to.taskId)}」`;
  return `专题「${firstLine(n.topics.find((t) => t.id === to.topicId)?.title, "未命名专题")}」`;
}

const time = (iso: string) => {
  const d = new Date(iso);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
};

/** Something in the 事项 is still open for whoever it went to: not withdrawn, and a receipt not 处理了. */
const openMessage = (m: MailMessage) => m.withdrawnAt === undefined && m.state !== "dismissed" && (m.receipts ?? []).some((r) => r.state !== "handled");
/** The 事项 needs a look: it waits on the person, or a message in it is not handled yet. */
export const threadOpen = (t: LocalThread) => !!t.matter?.waitingOn.includes(LOCAL_PERSON) || t.messages.some(openMessage);

async function act(what: () => Promise<unknown>, done?: string) {
  try {
    await what();
    if (done) showToast({ text: done });
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

/** Send a waiting message in, or drop it (a 传话 through its Relay, everything else through its mail). */
export function sendIn(link: HostLink, m: MailMessage, sessionId?: Id) {
  return act(() => (m.relayId ? call(link, "POST /api/relays/:id/deliver", { id: m.relayId }) : call(link, "POST /api/mail/:id/forward", { id: m.id }, sessionId ? { sessionId } : {})), "已送进会话。");
}
export function dropIt(link: HostLink, m: MailMessage) {
  return act(() => (m.relayId ? call(link, "POST /api/relays/:id/dismiss", { id: m.relayId }) : call(link, "PATCH /api/mail/:id", { id: m.id }, { state: "dismissed" })));
}

/** A message waiting for the person: where it comes from and goes, what it says, 送进会话 / 不送. */
export function AskCard({ link, names, mail, sessionId, compact }: { link: HostLink; names: Names; mail: MailMessage; sessionId?: Id; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const run = (f: () => Promise<void>) => {
    setBusy(true);
    void f().finally(() => setBusy(false));
  };
  return (
    <div className={`mail-card unread${compact ? " compact" : ""}`} data-testid="mail-card">
      <span className="mail-route">
        {mail.seq ? `#${mail.seq} · ` : ""}
        {LOCAL_VIA_LABEL[mail.via ?? "mail"]} · 来自 {fromName(names, mail)} → {toName(names, mail.to)}
      </span>
      <span className="mail-text">{mail.text}</span>
      <div className="mail-actions">
        <span className="pending-why">{mail.ask ? "按距离要你先看一眼" : "没有自己送进对话"}</span>
        <span className="spacer" />
        <button type="button" className="btn-ghost small" disabled={busy} title="作为一条消息送进对方的会话（它这一轮做完后读到）" onClick={() => run(() => sendIn(link, mail, sessionId))}>
          送进会话
        </button>
        <button type="button" className="link-btn" disabled={busy} title="不送进去：这条就此作罢，发的一方会知道（传话）或不再等它" onClick={() => run(() => dropIt(link, mail))}>
          不送
        </button>
      </div>
    </div>
  );
}

function MessageRow({ link, names, m }: { link: HostLink; names: Names; m: MailMessage }) {
  const [open, setOpen] = useState(false);
  const receipts = m.receipts ?? [];
  const state = receipts.length === 1 ? RECEIPT_STATE_LABEL[receipts[0]!.state] : receipts.length ? receiptSummary(receipts).text : null;
  const queued = isQueued(m) && !m.ask;
  const withdrawn = m.withdrawnAt !== undefined;
  const long = m.text.length > 280 || m.text.split("\n").length > 5;
  return (
    <li className={`pending-msg${openMessage(m) ? " open" : ""}${withdrawn ? " withdrawn" : ""}`} data-testid="pending-msg">
      <div className="pending-msg-head">
        <span className="pending-seq">#{m.seq ?? "?"}</span>
        <span className="pending-via">{LOCAL_VIA_LABEL[m.via ?? "mail"]}</span>
        <span className="pending-route">
          {fromName(names, m)} → {toName(names, m.to)}
          {m.replyTo ? ` · 回复 #${m.replyTo}` : ""}
        </span>
        <span className="pending-time">{time(m.createdAt)}</span>
        {withdrawn ? (
          <span className="pending-state">× 已撤回</span>
        ) : m.ask ? (
          <span className="pending-state ask">! 等你放行</span>
        ) : state ? (
          <span className={`pending-state${receipts.every((r) => r.state === "handled") ? " done" : ""}`} title="对收的一方：排队 → 送到 → 看过 → 处理了">
            {receipts.every((r) => r.state === "handled") ? "✓ " : "◐ "}
            {state}
          </span>
        ) : null}
        {m.editedAt !== undefined && <span className="pending-state">改过</span>}
      </div>
      {!withdrawn && (
        <div className={`pending-msg-text${long && !open ? " clamped" : ""}`} onClick={() => long && setOpen(!open)} title={long && !open ? "点开看全文" : undefined}>
          {m.text}
        </div>
      )}
      {queued && (
        <div className="mail-actions">
          <span className="pending-why">还在排队：对方这一轮做完才读到</span>
          <button type="button" className="link-btn" onClick={() => void act(() => call(link, "PATCH /api/mail/:id", { id: m.id }, { withdraw: true }), "已撤回。")}>
            撤回
          </button>
        </div>
      )}
    </li>
  );
}

/** One 事项: its number, title, kind and status, whom it waits on, and its messages in order. */
export function ThreadCard({ link, names, thread, startOpen }: { link: HostLink; names: Names; thread: LocalThread; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const m = thread.matter;
  const messages = [...thread.messages].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  // A message still waiting for the person to let it in is theirs to send or drop above, not to mark handled.
  const unhandled = messages.filter((x) => openMessage(x) && !x.ask);
  const last = messages.at(-1);
  return (
    <div className={`pending-thread${threadOpen(thread) ? " open" : ""}`} data-testid="pending-thread">
      <button type="button" className="pending-thread-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="pending-fold">{open ? "▾" : "▸"}</span>
        <span className="pending-no">{m ? `事项 ${m.no}` : "没有事项"}</span>
        <span className="pending-title">{m?.title ?? last?.text.slice(0, 40) ?? ""}</span>
        {m && <span className="pending-chip">{KIND_LABEL[m.kind]}</span>}
        {m && <span className={`pending-chip status-${m.status}`}>{MATTER_STATUS_LABEL[m.status]}</span>}
      </button>
      <div className="pending-thread-sub">
        {m && m.waitingOn.length > 0 && <span>在等：{m.waitingOn.map((p) => partyName(names, p)).join("、")}</span>}
        <span>
          {messages.length} 条消息
          {messages.some((x) => x.ask) ? "，有一条等你放行" : unhandled.length ? `，${unhandled.length} 条还没处理` : "，都处理了"}
        </span>
        {last && <span>最近 {time(last.createdAt)}</span>}
      </div>
      {open && (
        <>
          <ol className="pending-msgs">
            {messages.map((x) => (
              <MessageRow key={x.id} link={link} names={names} m={x} />
            ))}
          </ol>
          {m && <ThreadActions link={link} matter={m} unhandled={unhandled} />}
        </>
      )}
    </div>
  );
}

function ThreadActions({ link, matter, unhandled }: { link: HostLink; matter: Matter; unhandled: MailMessage[] }) {
  return (
    <div className="mail-actions pending-thread-actions">
      {unhandled.length > 0 && (
        <button
          type="button"
          className="btn-ghost small"
          title="把这件事项里还没处理的消息都标成处理了（AI 不会再把它们列为待处理）"
          onClick={() => void act(() => call(link, "POST /api/mail/marks", {}, { ids: unhandled.map((x) => x.id), mark: "handled" }))}
        >
          都标成处理了
        </button>
      )}
      <button type="button" className="link-btn" title="这件事到此为止：关闭事项，里面的消息都算处理了" onClick={() => void act(() => call(link, "PATCH /api/matters/:id", { id: matter.id }, { status: "closed", note: "人关闭了" }), `事项 ${matter.no} 关闭了。`)}>
        关闭事项
      </button>
    </div>
  );
}

/** The 事项 grouped by the task (or topic) they belong to, in the order of their latest change. */
function byScope(threads: readonly LocalThread[], names: Names): { key: string; title: string; threads: LocalThread[] }[] {
  const groups = new Map<string, { key: string; title: string; threads: LocalThread[] }>();
  for (const t of threads) {
    const scope = t.matter?.scopeId ?? "";
    const task = names.tasks.find((x) => x.id === scope);
    const topic = task ? null : names.topics.find((x) => x.id === scope);
    const title = task ? `任务「${firstLine(task.title, "未命名任务")}」` : topic ? `专题「${firstLine(topic.title, "未命名专题")}」` : "别处";
    const g = groups.get(scope) ?? { key: scope, title, threads: [] };
    g.threads.push(t);
    groups.set(scope, g);
  }
  return [...groups.values()];
}

/** Where an item of another source opens: the 中转 client for a 协作's, the task page here for a session or task. */
function openEntry(link: HostLink, entry: PendingEntry, onOpenTask: (taskId: Id, sessionId?: Id) => void) {
  const o = entry.open;
  if (o.kind === "relay") return act(() => call(link, "POST /api/cowork/open-in-relay", {}, { target: o.target }));
  if (o.kind === "session" && o.taskId) onOpenTask(o.taskId, o.sessionId);
  else if (o.kind === "task") onOpenTask(o.taskId);
  return Promise.resolve();
}

const since = (ms: number) => time(new Date(ms).toISOString());

/** One group of GET /api/pending that is not this computer's own (a 协作's): its items, 打开 and the two marks. */
function SourceGroup({ link, group, onOpenTask }: { link: HostLink; group: PendingGroup; onOpenTask(taskId: Id, sessionId?: Id): void }) {
  const mark = (keys: string[], m: "seen" | "handled") => act(() => call(link, "POST /api/pending/mark", {}, { group: group.id, keys, mark: m }));
  return (
    <section className="pending-section" aria-label={group.title} data-testid="pending-group">
      <h3>
        {group.title}
        <span className="pending-count">{group.items.length}</span>
      </h3>
      {group.note && <p className="pending-hint">{group.note}</p>}
      <ul className="pending-entries">
        {group.items.map((i) => (
          <li key={i.key} className="pending-entry" data-testid="pending-entry">
            <div className="pending-msg-head">
              <span className="pending-via">{PENDING_KIND_LABEL[i.kind]}</span>
              {i.matter && <span className="pending-no">事项 {i.matter.no}</span>}
              <span className="pending-route">{i.from ?? ""}</span>
              <span className="pending-time">{since(i.since)}</span>
            </div>
            <div className="pending-msg-text">{i.text}</div>
            <div className="mail-actions">
              <button type="button" className="btn-ghost small" onClick={() => void openEntry(link, i, onOpenTask)}>
                {i.open.kind === "relay" ? "在中转里打开" : "打开"}
              </button>
              {group.canMark && (
                <>
                  <button type="button" className="link-btn" onClick={() => void mark([i.key], "seen")}>
                    看过了
                  </button>
                  <button type="button" className="link-btn" onClick={() => void mark([i.key], "handled")}>
                    处理了
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The page (top bar 「待我处理」): every group of GET /api/pending (protocol/src/pending.ts) — the person's own first, each
 * 协作's from the 中转 and this computer's (「本机」, drawn in full from GET /api/local-pending: messages to let in, the
 * 事项 with their messages) — then, folded, what waits on each 主控 session here, with 「让它现在看一遍」.
 */
export function PendingPage({ link, names, snap, view, onOpenTask }: { link: HostLink; names: Names; snap: PendingSnapshot; view: LocalPendingView; onOpenTask(taskId: Id, sessionId?: Id): void }) {
  const [showDone, setShowDone] = useState(false);
  const [showLeads, setShowLeads] = useState(false);
  const live = view.threads.filter(threadOpen);
  const done = view.threads.filter((t) => !threadOpen(t));
  const others = snap.groups.filter((g) => g.for.kind === "person" && g.source !== "local");
  const mineLocal = snap.groups.find((g) => g.for.kind === "person" && g.source === "local");
  // What waits on the person in a 事项 here (not a message to let in: those are the cards above).
  const waiting = (mineLocal?.items ?? []).filter((i) => !i.key.startsWith("ask:"));
  const leads = snap.groups.filter((g) => g.for.kind === "session");
  const nothing = !view.asks.length && !live.length && !others.length && !waiting.length;
  return (
    <div className="pending-page" data-testid="pending-page">
      <header className="pending-page-head">
        <h2>待我处理</h2>
        <span className="pending-page-sum">
          {snap.mine ? `${snap.mine} 条要你处理` : "没有要你处理的"} · {live.length ? `本机 ${live.length} 件事项有没处理完的消息` : "本机事项里的消息都处理了"}
        </span>
      </header>
      {snap.problems.map((p) => (
        <div key={p.source} className="pending-problem" data-testid="pending-problem">
          ! {p.source === "cowork" ? "协作" : "本机"}：{p.text}
        </div>
      ))}
      {nothing && <div className="placeholder">现在没有要你处理的。会话之间的留言、传话、派活和结果都在事项里，协作里 @ 你、在等你的也在这里；有要你放行或还没处理的会出现在这里。</div>}
      {others.map((g) => (
        <SourceGroup key={g.id} link={link} group={g} onOpenTask={onOpenTask} />
      ))}
      {view.asks.length > 0 && (
        <section className="pending-section" aria-label="等你放行">
          <h3>
            本机 · 等你放行<span className="pending-count">{view.asks.length}</span>
          </h3>
          <p className="pending-hint">离得远的任务发来的（别的专题、没有专题，或对方任务设了「先问我」），还有没自己送进对话的：点「送进会话」它才进去。</p>
          {view.asks.map((m) => (
            <AskCard key={m.id} link={link} names={names} mail={m} />
          ))}
        </section>
      )}
      {waiting.length > 0 && mineLocal && <SourceGroup link={link} group={{ ...mineLocal, title: "本机 · 在等你", note: "", items: waiting }} onOpenTask={onOpenTask} />}
      {live.length > 0 && (
        <section className="pending-section" aria-label="进行中的事项">
          <h3>本机 · 进行中的事项</h3>
          {byScope(live, names).map((g) => (
            <div key={g.key} className="pending-group">
              <div className="pending-group-title">{g.title}</div>
              {g.threads.map((t) => (
                <ThreadCard key={t.matter?.id ?? t.messages[0]?.id} link={link} names={names} thread={t} startOpen={g.threads.length <= 3} />
              ))}
            </div>
          ))}
        </section>
      )}
      {done.length > 0 && (
        <section className="pending-section folded" aria-label="都处理了的事项">
          <button type="button" className="pending-fold-btn" aria-expanded={showDone} onClick={() => setShowDone(!showDone)} data-testid="pending-done-toggle">
            {showDone ? "▾" : "▸"} 消息都处理了、还没关闭的事项（{done.length}）
          </button>
          {showDone &&
            byScope(done, names).map((g) => (
              <div key={g.key} className="pending-group">
                <div className="pending-group-title">{g.title}</div>
                {g.threads.map((t) => (
                  <ThreadCard key={t.matter?.id ?? t.messages[0]?.id} link={link} names={names} thread={t} startOpen={false} />
                ))}
              </div>
            ))}
        </section>
      )}
      {leads.length > 0 && (
        <section className="pending-section folded" aria-label="主控的待处理">
          <button type="button" className="pending-fold-btn" aria-expanded={showLeads} onClick={() => setShowLeads(!showLeads)} data-testid="pending-leads-toggle">
            {showLeads ? "▾" : "▸"} 各主控会话的待处理（{leads.length}）：Studio 每 2 分钟替它们看一次，有新的才叫它
          </button>
          {showLeads &&
            leads.map((g) => (
              <div key={g.id} className="pending-line static" data-testid="pending-lead">
                <span className="pending-title">
                  {g.title}
                  {g.note ? ` · ${g.note}` : ""}
                </span>
                <span className="pending-chip">{g.items.length} 条</span>
                <button
                  type="button"
                  className="link-btn"
                  title="现在就让它看一遍它的待处理（它在忙就等这一轮做完）"
                  onClick={() => void act(() => call(link, "POST /api/pending/patrol", {}, { sessionIds: [g.for.kind === "session" ? g.for.sessionId : ""] }), "已让它看一遍。")}
                >
                  让它现在看一遍
                </button>
              </div>
            ))}
        </section>
      )}
    </div>
  );
}

/**
 * The task page's side column (in place of 留言): what waits for the person about this task — messages to send in
 * (送进会话 puts a message for the task into the session in front) — and a line per open 事项, with the way to the page.
 * 传话 waiting for the person have their own banner over the conversation, so they are not repeated here.
 */
export function PendingPanel({ link, names, view, current, onOpenAll }: { link: HostLink; names: Names; view: LocalPendingView; current: Session | null; onOpenAll(): void }) {
  const asks = view.asks.filter((m) => !m.relayId);
  const live = view.threads.filter(threadOpen);
  if (!asks.length && !live.length) return null;
  return (
    <section className="mail-panel" aria-label="待我处理">
      <div className="anno-head">
        <span className="anno-title">待我处理</span>
        <span className="anno-count" data-testid="mail-count">
          {asks.length}
        </span>
        <span className="spacer" />
        <button type="button" className="link-btn" onClick={onOpenAll} data-testid="pending-open-all">
          全部 →
        </button>
      </div>
      {asks.map((m) => (
        <AskCard key={m.id} link={link} names={names} mail={m} {...(m.to.kind === "task" && current && !current.archivedAt && current.taskId === m.to.taskId ? { sessionId: current.id } : {})} compact />
      ))}
      {live.map((t) => (
        <button key={t.matter?.id ?? t.messages[0]?.id} type="button" className="pending-line" onClick={onOpenAll} data-testid="pending-line">
          <span className="pending-no">{t.matter ? `事项 ${t.matter.no}` : "消息"}</span>
          <span className="pending-title">{t.matter?.title ?? ""}</span>
          {t.matter && <span className="pending-chip">{MATTER_STATUS_LABEL[t.matter.status]}</span>}
        </button>
      ))}
    </section>
  );
}
