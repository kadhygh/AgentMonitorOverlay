import { useEffect, useMemo, useState } from "react";
import { BoardBody } from "./Board.js";
import { agentOf, CoworkComposer, CoworkContext, CoworkMessages, markMine, matterWhy, useCowork, type CoworkCtx } from "./CoworkChat.js";
import { MatterBody, NewMatterDialog } from "./CoworkMatter.js";
import { askStudio, leadMark, patrolMark, studioHere } from "./coworkHandoff.js";
import { agentChip, STATE_LEGEND, STATE_MARK, STATE_WORD } from "./coworkText.js";
import { Avatar, avatarColor, timeText, useDisplayName, usePeople, Who } from "./bits.js";
import { Dialog, Field } from "./Dialog.js";
import { FilesList, FileViewer, PickFiles, useThreadFiles, useUpload } from "./Files.js";
import { FloatTabs, FloatWindow, useFloats } from "./Floats.js";
import { ListRow, ListSection, SideBlock, SidePanel, useSidePanel } from "./Layout.js";
import { Markdown } from "./Markdown.js";
import { lookItems, LOOK_WORD, MATTER_CLS, matterChip, matterLabel, mattersOf, openLine, partyText, pendingSeqs, type LookItem } from "./matterView.js";
import { errorText, useMessages } from "./Messages.js";
import { EMPTY_COWORK_DATA, useSession, type Session } from "./session.js";
import { copyRef, openMenu, openStudio, studioWhere, type MenuItem } from "./RefChips.js";
import { coworkRef } from "./refs.js";
import { AGENT_ROLE_LABEL, listedOthers, personParty, type CoworkAgent, type CoworkDraft, type CoworkGoalVersion, type CoworkListItem, type Matter, type Message } from "./shared.js";

// 协作 (2026-11-23, plans/cowork.md, prototype A's 协作 page; 2026-11-25 the communication plan, plans/collab-framework.md
// 「11-24」 and the board prototype studio/out/cowork-flow/board.html): the list (进行中 / 已结束, unread, 「[@我]」), 发起协作,
// and one 协作 — its 群聊 (over it a line of the open 事项 and whom they wait on) or its 板 (the 事项 computed into frames by
// side), 「要你看 N」 (what is mine to look at: 事项 waiting on me — 等你确认 / 叫你来看 — and the 群聊's 知会), the 信息栏 on
// the right (目标 with its versions, 仓库和分支, 成员 with each AI's role and state, 事项, 已定的事, 文件, 结束 / 重新打开). A 事项
// opens as a window over the 群聊 (several at once, Floats.tsx) or as a drawer on the board. 待处理 sums up what is mine in
// all of them (coworkWaiting).

/** What is mine to look at across my coworks (待我处理; on a service from before 事项: @-s not read and 子会话 waiting on me). */
export function coworkWaiting(s: { coworks: CoworkListItem[]; pending: Session["snapshot"]["pending"]; pendingOk: boolean; mentions: Message[] }, me: string) {
  const open = s.coworks.filter((c) => !c.endedAt);
  if (s.pendingOk) {
    const rows = open.flatMap((c) => lookItems(s.pending[c.id]?.items ?? [], mattersOf(c)).map((item) => ({ cowork: c, item })));
    return { rows, count: rows.length };
  }
  const rows: Array<{ cowork: CoworkListItem; item: LookItem }> = [
    ...open.flatMap((c) => mattersOf(c).filter((m) => m.status === "confirm" && m.waitingOn.includes(personParty(me))).map((m) => ({ cowork: c, item: { kind: "matter", look: "confirm", matter: m, since: m.updatedAt, seqs: [], why: null } as LookItem }))),
    ...s.mentions.flatMap((m) => {
      const c = s.coworks.find((x) => x.id === m.threadId);
      return c ? [{ cowork: c, item: { kind: "notice", seq: m.seq, since: m.createdAt, text: m.body.replace(/\s+/g, " ").slice(0, 80), mark: "handled", why: null, word: "@ 你" } as LookItem }] : [];
    }),
  ];
  return { rows, count: rows.length };
}

/** A cowork's unread (its 群聊 and its 事项) and whether something there @-s me. */
function unreadOf(session: Session, c: CoworkListItem) {
  const ids = new Set([c.id, ...c.sessions.map((s) => s.id), ...(c.matters ?? []).map((m) => m.id)]);
  const st = session.snapshot;
  const unread = st.threads.filter((t) => ids.has(t.id)).reduce((n, t) => n + t.unread, 0);
  const atMe = st.mentions.find((m) => ids.has(m.threadId)) ?? null;
  return { unread, atMe };
}

export function coworkUnreadCount(session: Session): number {
  return session.snapshot.coworks.filter((c) => unreadOf(session, c).unread > 0).length;
}

const coworkInitial = (title: string) => (title.trim() || "协").slice(0, 1);

/** The rows of the list: 进行中, then 已结束. */
export function CoworkList({ session, openId, query, onOpen }: { session: Session; openId: string | null; query: string; onOpen: (id: string) => void }) {
  const st = useSession(session);
  const show = useDisplayName();
  const q = query.trim().toLowerCase();
  const list = st.coworks.filter((c) => !q || c.title.toLowerCase().includes(q) || c.goal.toLowerCase().includes(q) || c.members.some((m) => m.toLowerCase().includes(q)));
  const going = list.filter((c) => !c.endedAt);
  const ended = list.filter((c) => c.endedAt);
  const row = (c: CoworkListItem) => {
    const { unread, atMe } = unreadOf(session, c);
    const g = st.threads.find((t) => t.id === c.id);
    const last = g?.last;
    const decided = (st.coworkData[c.id]?.events ?? []).filter((e) => e.kind === "decision").length;
    const open = mattersOf(c).filter((m) => m.status !== "closed").length;
    const mine = lookItems(st.pending[c.id]?.items ?? [], mattersOf(c)).length;
    const sub = atMe ? (
      <>
        <span className="at-me">[@我]</span> {show(atMe.author)}：{atMe.body.replace(/\s+/g, " ").slice(0, 40)}
      </>
    ) : mine && !c.endedAt ? (
      <>
        <span className="at-me">[要你看 {mine}]</span> {last && last.kind !== "event" ? `${show(last.author)}：${last.body.replace(/\s+/g, " ").slice(0, 30)}` : ""}
      </>
    ) : c.endedAt ? (
      `已结束${decided ? ` · 已定 ${decided} 件` : ""}`
    ) : last && last.kind !== "event" ? (
      `${agentOf(c, last.via.kind === "ai" ? last.via.conv : null)?.name ?? show(last.author)}：${last.body.replace(/\s+/g, " ").slice(0, 40)}`
    ) : (
      [decided ? `已定 ${decided} 件` : "", open ? `${open} 件事项开着` : "", !decided && !open ? `${c.members.length} 人 · ${c.agents.length} 个 AI` : ""].filter(Boolean).join(" · ")
    );
    return (
      <ListRow
        key={c.id}
        className="cowork-row"
        avatar={
          <span className="avatar sq" style={{ background: c.endedAt ? "var(--text-faint)" : avatarColor(c.title) }}>
            {coworkInitial(c.title)}
          </span>
        }
        title={c.title}
        time={timeText(c.updatedAt)}
        sub={sub}
        badge={unread}
        current={c.id === openId}
        unread={unread > 0}
        label={c.title}
        onClick={() => onOpen(c.id)}
      />
    );
  };
  if (!st.coworksOk) return <div className="list-empty">中转服务还是旧版，没有协作。等服务更新后就有。</div>;
  return (
    <>
      <ListSection title="进行中" count={going.length} />
      {going.map(row)}
      {!going.length && <div className="list-empty">{q ? "没有对得上的协作。" : "还没有协作。点「＋ 发起协作」，定好目标和分支，把相关的人拉进来；每个人再把自己的 AI 会话拉进来。"}</div>}
      {ended.length > 0 && <ListSection title="已结束" count={ended.length} />}
      {ended.map(row)}
    </>
  );
}

/** 群聊 or 板 (the user 2026-11-24: the board is the 协作's infinite canvas, the 事项 computed onto it). Kept per computer. */
const VIEW_KEY = "amo-relay-cowork-view";
const savedView = (): "chat" | "board" => {
  try {
    return localStorage.getItem(VIEW_KEY) === "board" ? "board" : "chat";
  } catch {
    return "chat";
  }
};

/**
 * One 协作. `focus` opens a 事项 (from 待处理, a notification, a reference): on the board as its drawer, over the 群聊 as a
 * window; `focus.seq` a 群聊 message (a 知会).
 */
export function CoworkView({ session, cowork, toast, focus, onOpenFile }: { session: Session; cowork: CoworkListItem; toast: (t: string) => void; focus: { sub?: string; seq?: number; n: number } | null; onOpenFile?: (id: string) => void }) {
  const st = useSession(session);
  const show = useDisplayName();
  const floats = useFloats();
  const me = session.me.name;
  const data = st.coworkData[cowork.id] ?? EMPTY_COWORK_DATA;
  const side = useSidePanel("cowork");
  const { messages, error } = useMessages(session, cowork.id);
  const [typing, setTyping] = useState(false);
  const [view, setViewState] = useState<"chat" | "board">(savedView);
  const [boardMatter, setBoardMatter] = useState<{ id: string; n: number } | null>(null);
  const [boardChat, setBoardChat] = useState<{ seq?: number; n: number } | null>(null);
  const [lookOpen, setLookOpen] = useState(false);
  const [dialog, setDialog] = useState<null | "matter" | "people" | "goals">(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<{ seq: number; threadId: string } | null>(null);
  const files = useThreadFiles(session, cowork.id, cowork.updatedAt);
  const { upload, busy: uploading } = useUpload(session, { threadId: cowork.id }, toast);
  const matters = useMemo(() => mattersOf(cowork), [cowork]);
  const pending = st.pending[cowork.id]?.items ?? [];
  const looks = useMemo(() => lookItems(pending, matters), [pending, matters]);
  const toHandle = useMemo(() => pendingSeqs(pending), [pending]);
  const setView = (v: "chat" | "board") => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // private mode: not kept
    }
  };

  // Events: loaded when first opened (the list loads the open ones; an ended one on demand); my 待我处理 here.
  useEffect(() => {
    if (!st.coworkData[cowork.id]) void session.loadCowork(cowork.id).catch(() => undefined);
    if (!st.pending[cowork.id]) void session.loadPending(cowork.id);
  }, [cowork.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const winTitle = (m: Matter) => ({ title: `${matterLabel(m)}：${m.title}`, status: matterChip(m.status).replace(/^[✓!◐○] /, "") });
  // (One just opened may not be in the list yet: its window opens with its title and fills in once it comes.)
  const openMatter = (id: string, title?: string) => {
    if (view === "board") return setBoardMatter((f) => ({ id, n: (f?.n ?? 0) + 1 }));
    // (The list as the session has it now: the 事项 may have come in since this render, its window then has its title at once.)
    const now = session.snapshot.coworks.find((c) => c.id === cowork.id);
    const m = (now ? mattersOf(now) : matters).find((x) => x.id === id);
    if (m || title) floats.open({ id: `matter:${id}`, ...(m ? winTitle(m) : { title: `事项：${title}`, status: "开着" }), size: { w: 540, h: 600 } });
  };
  const openBoard = (matter?: string) => {
    setView("board");
    if (matter) setBoardMatter((f) => ({ id: matter, n: (f?.n ?? 0) + 1 }));
  };
  const openNotice = (seq: number) => {
    setLookOpen(false);
    if (view === "board") return setBoardChat((f) => ({ seq, n: (f?.n ?? 0) + 1 }));
    document.getElementById(`msg-${seq}`)?.scrollIntoView({ block: "center" });
  };
  // A 事项's window title follows its state.
  useEffect(() => {
    for (const m of matters) if (floats.isOpen(`matter:${m.id}`)) floats.setInfo(`matter:${m.id}`, winTitle(m));
  }, [matters]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (focus?.sub) openMatter(focus.sub);
    else if (focus?.seq) openNotice(focus.seq);
  }, [focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctx: CoworkCtx = { session, cowork, data, me, matters, looks, toHandle, openMatter, openBoard, replacing, setReplacing, toast };
  const ended = !!cowork.endedAt;
  const leftover = ended ? [] : (data.drafts ?? []).filter((d) => d.state === "pending" && d.owner === me);
  const decisions = data.events.filter((e) => e.kind === "decision");
  const openCount = matters.filter((m) => m.status !== "closed").length;
  const where = [cowork.repo, cowork.branch].filter(Boolean);

  const pasteToBoard = async (text: string) => {
    try {
      await session.client.coworkBoardOps(cowork.id, [{ op: "add", opId: `o${Date.now().toString(36)}`, item: { kind: "note", text, x: 40 + Math.round(Math.random() * 80), y: -200 - Math.round(Math.random() * 80), w: 220, h: 120 } }]);
      toast("贴到了板上");
    } catch (err) {
      toast(errorText(err));
    }
  };

  const chat = (
    <>
      <OpenStrip />
      <CoworkMessages threadId={cowork.id} messages={messages} error={error} typing={typing} withEvents empty="群里还没有消息。群聊只发进度和 @；具体的事开成事项。" after={leftover.map((d) => <LeftoverDraft key={d.id} draft={d} />)} />
      <div className="cw-dock">
        <FloatTabs />
        <CoworkComposer
          placeholder={`发到「${cowork.title}」… 只发进度和 @；具体的事点「＋ 事项」`}
          onTyping={setTyping}
          disabled={ended ? "协作已结束：重新打开后才能说话（信息栏最下面）。" : null}
          tools={
            <>
              <PickFiles small label={uploading ? "上传中…" : "附加文件"} disabled={uploading} onFiles={(fl) => void upload(fl)} />
              <button type="button" className="small ghost" onClick={() => setDialog("matter")} disabled={ended}>
                开事项
              </button>
              <PasteToBoard onPaste={pasteToBoard} />
            </>
          }
        />
      </div>
    </>
  );

  return (
    <CoworkContext.Provider value={ctx}>
      <div className={`view cowork-view ${view === "board" ? "on-board" : ""}`}>
        <div className="cw-main">
          <div className="page-head">
            <div className="head-main">
              <div className="head-title-row">
                <h1 className="head-title">{cowork.title}</h1>
                <button type="button" className="small ghost head-copy" onClick={() => copyRef(coworkRef(cowork), `协作「${cowork.title}」`, toast)} title="复制一行引用（标题和 cowork:<id>），贴进聊天或 AI 会话里都认得">
                  复制引用
                </button>
              </div>
              <div className="head-meta">
                <span className="page-crumb">{ended ? "已结束的协作" : "协作"}</span>
                {where.length > 0 && (
                  <span>
                    {cowork.repo} {cowork.branch && <code className="branch">{cowork.branch}</code>}
                  </span>
                )}
                <span>
                  {cowork.members.length} 人 + {cowork.agents.length} 个 AI
                </span>
                <span>
                  事项 {matters.length} 件{openCount ? `，开着 ${openCount}` : ""}
                </span>
                <span>已定 {decisions.length} 件</span>
              </div>
            </div>
            <div className="head-actions">
              <div className="seg" role="tablist" aria-label="群聊还是板">
                <button type="button" role="tab" aria-selected={view === "chat"} className={view === "chat" ? "on" : ""} onClick={() => setView("chat")}>
                  群聊
                </button>
                <button type="button" role="tab" aria-selected={view === "board"} className={view === "board" ? "on" : ""} onClick={() => setView("board")}>
                  板
                </button>
              </div>
              <button type="button" className={`cw-look-btn ${looks.length ? "primary" : ""}`} aria-expanded={lookOpen} onClick={() => setLookOpen(!lookOpen)} title="等你确认、叫你来看的事项，和群聊里给你的知会">
                要你看 {looks.length}
              </button>
              {!ended && (
                <button type="button" onClick={() => setDialog("matter")}>
                  ＋ 事项
                </button>
              )}
              {view === "chat" && (
                <button type="button" className="side-toggle" onClick={() => side.setOpen(!side.open)}>
                  {side.open ? "收起信息栏" : "信息栏"}
                </button>
              )}
            </div>
          </div>
          {lookOpen && view === "chat" && <LookPanel className="cw-look-drop" onClose={() => setLookOpen(false)} onNotice={openNotice} />}
          {view === "chat" ? chat : <BoardBody focus={boardMatter} chatFocus={boardChat} lookOpen={lookOpen} setLookOpen={setLookOpen} chat={chat} onNotice={openNotice} />}
        </div>
        {side.open && view === "chat" && (
          <SidePanel label="信息栏" title="协作信息" className="info-panel cw-info" onClose={() => side.setOpen(false)}>
            <InfoPanel files={files} onFiles={(fl) => void upload(fl)} uploading={uploading} onOpenFile={(id) => (onOpenFile ? onOpenFile(id) : setViewing(id))} onPeople={() => setDialog("people")} onGoals={() => setDialog("goals")} onMatter={() => setDialog("matter")} />
          </SidePanel>
        )}
      </div>
      {matters.map((m) => (
        <FloatWindow key={m.id} id={`matter:${m.id}`} className="cw-subwin">
          <MatterBody matter={m} onBoard={() => (floats.close(`matter:${m.id}`), openBoard(m.id))} />
        </FloatWindow>
      ))}
      {dialog === "matter" && <NewMatterDialog onClose={() => setDialog(null)} onMade={(id) => (setDialog(null), openMatter(id, "新事项"))} />}
      {dialog === "people" && <AddPeopleDialog onClose={() => setDialog(null)} />}
      {dialog === "goals" && <GoalsDialog onClose={() => setDialog(null)} />}
      {viewing && <FileViewer session={session} fileId={viewing} onClose={() => setViewing(null)} toast={toast} />}
    </CoworkContext.Provider>
  );
}

/** Over the 群聊: the 事项 still open and whom they wait on (the user 2026-11-24: 群聊顶部列开着的事和等谁确认). */
function OpenStrip() {
  const { matters, cowork, me, openMatter, looks } = useCowork();
  const show = useDisplayName();
  const list = openLine(matters);
  if (!list.length) return null;
  const mine = new Set(looks.flatMap((l) => (l.kind === "matter" ? [l.matter.id] : [])));
  const MAX = 4;
  return (
    <div className="cw-openline" aria-label="开着的事">
      <span className="cw-openline-k">开着的事 {list.length}</span>
      {list.slice(0, MAX).map((m) => (
        <button key={m.id} type="button" className={`cw-openchip st-${MATTER_CLS[m.status]} ${mine.has(m.id) ? "mine" : ""}`} onClick={() => openMatter(m.id)} title={`${matterLabel(m)}「${m.title}」 · ${matterWhy(m, cowork.agents, show, me)}`}>
          <b>{matterLabel(m)}</b> {m.waitingOn.length ? `等${m.waitingOn.map((p) => (p === personParty(me) ? "你" : partyText(p, cowork.agents, show))).join("、")}${m.status === "confirm" ? "确认" : ""}` : matterChip(m.status)}
        </button>
      ))}
      {list.length > MAX && <span className="muted tiny">还有 {list.length - MAX} 件</span>}
    </div>
  );
}

/**
 * 要你看 (2026-11-25, 放法 A): 等你确认 / 叫你来看 的事项, then the 群聊's 知会 (「看过了」 right there). A 事项 opens (on the
 * board: panned to and its drawer); a 知会 shows its message.
 */
export function LookPanel({ className, onClose, onNotice, onMatter }: { className?: string; onClose: () => void; onNotice: (seq: number) => void; onMatter?: (id: string) => void }) {
  const ctx = useCowork();
  const { looks, openMatter, cowork } = ctx;
  const show = useDisplayName();
  return (
    <div className={`cw-lookpanel ${className ?? ""}`} role="region" aria-label="要你看">
      <div className="cw-lookpanel-head">
        <b>要你看</b>
        <span className={`badge ${looks.length ? "" : "quiet"}`}>{looks.length}</span>
        <span className="grow" />
        <button type="button" className="link tiny" onClick={onClose}>
          收起
        </button>
      </div>
      {!looks.length && <div className="muted tiny cw-lookpanel-empty">没有等你的。有事项等你确认、或叫你来看结果时会列在这里。</div>}
      {looks.map((l) =>
        l.kind === "matter" ? (
          <button key={l.matter.id} type="button" className={`cw-lookrow ${l.look}`} data-matter={l.matter.id} onClick={() => (onMatter ?? openMatter)(l.matter.id)}>
            <span className="cw-lookrow-top">
              <span className={`cw-look ${l.look}`}>{LOOK_WORD[l.look]}</span>
              <span className="muted tiny">
                {partyText(l.matter.owner, cowork.agents, show)} · {timeText(l.since)}
              </span>
            </span>
            <b>
              {matterLabel(l.matter)} · {l.matter.title}
            </b>
            {l.why && <span className="muted tiny">{l.why}</span>}
          </button>
        ) : (
          <div key={`n${l.seq}`} className="cw-lookrow notice" data-seq={l.seq}>
            <button type="button" className="cw-lookrow-main" onClick={() => onNotice(l.seq)}>
              <span className="cw-lookrow-top">
                <span className="cw-look notice">群聊 · {l.word}</span>
                <span className="muted tiny">
                  #{l.seq} · {timeText(l.since)}
                </span>
              </span>
              <b>{l.text}</b>
              {l.why && <span className="muted tiny">{l.why}</span>}
            </button>
            <button type="button" className="small" onClick={() => void markMine(ctx, l.mark, [l.seq], "记下了：看过了")}>
              看过了
            </button>
          </div>
        ),
      )}
    </div>
  );
}

/** 贴到白板: the text typed so far (or asked for) as a 便签. */
function PasteToBoard({ onPaste }: { onPaste: (text: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  return (
    <>
      <button type="button" className="small ghost" onClick={() => setOpen(true)}>
        贴到板上
      </button>
      {open && (
        <Dialog
          title="贴到板上"
          onClose={() => setOpen(false)}
          foot={
            <>
              <button type="button" onClick={() => setOpen(false)}>
                取消
              </button>
              <button type="button" className="primary" disabled={!text.trim()} onClick={() => void onPaste(text.trim()).then(() => (setOpen(false), setText("")))}>
                贴上去
              </button>
            </>
          }
        >
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="写在便签上的字（板上所有人和 AI 都看得到）" aria-label="便签的字" autoFocus />
        </Dialog>
      )}
    </>
  );
}

/**
 * An AI's draft kept from before 2026-11-24 (when 「AI 发起 @ 和提问」 went and an AI's @ goes out at once): nothing makes
 * new ones, but one left over in an older 协作 is still its owner's to send or drop, once (the service 2026-11-25).
 */
function LeftoverDraft({ draft }: { draft: CoworkDraft }) {
  const { cowork, session, toast } = useCowork();
  const show = useDisplayName();
  const [busy, setBusy] = useState(false);
  const body = draft.kind === "ask" ? (draft.ask?.body ?? "") : (draft.post?.body ?? "");
  const decide = async (action: "send" | "drop") => {
    setBusy(true);
    try {
      await session.client.decideCoworkDraft(cowork.id, draft.id, { action });
      await session.loadCowork(cowork.id);
      toast(action === "drop" ? "这份草稿不发了" : "已发出");
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cw-draft" data-draft={draft.id}>
      <div className="cw-draft-head">
        <span className="tag">以前留下的 AI 草稿</span>
        <b>{agentOf(cowork, draft.agent)?.name ?? "我的 AI"}</b>
        <span className="muted tiny">
          {draft.kind === "ask" ? `想请${show(draft.ask?.to ?? "")}确认「${draft.ask?.title ?? ""}」` : "想发一条"} · 只有你看得到 · {timeText(draft.createdAt)}
        </span>
      </div>
      <div className="msg-body">{body || <span className="muted">（没有正文）</span>}</div>
      <div className="cw-draft-foot">
        <span className="muted tiny">现在 AI 的 @ 和提问直接发出，不再留草稿；这一份还等你定：发出或不发，只能定一次。</span>
        <span className="grow" />
        <button type="button" className="small primary" disabled={busy} onClick={() => void decide("send")}>
          发出
        </button>
        <button type="button" className="small ghost" disabled={busy} onClick={() => void decide("drop")}>
          不发
        </button>
      </div>
    </div>
  );
}

/** An AI's role in words: 主控 / 执行 · 事项 N / 未分角色 (one brought in before roles, the user 2026-11-25). */
export function roleText(a: Pick<CoworkAgent, "role" | "matter">, matters: Matter[]): string {
  if (!a.role || a.role === "unassigned") return "未分角色";
  if (a.role === "worker") {
    const m = matters.find((x) => x.id === a.matter);
    return `执行 · ${m ? matterLabel(m) : "事项"}`;
  }
  return AGENT_ROLE_LABEL[a.role];
}

function InfoPanel(props: { files: ReturnType<typeof useThreadFiles>; onFiles: (fl: FileList) => void; uploading: boolean; onOpenFile: (id: string) => void; onPeople: () => void; onGoals: () => void; onMatter: () => void }) {
  const { session, cowork, data, me, toast, openMatter, matters } = useCowork();
  const show = useDisplayName();
  const people = usePeople();
  const ended = !!cowork.endedAt;
  const [goalEdit, setGoalEdit] = useState<string | null>(null);
  const [whereEdit, setWhereEdit] = useState<{ repo: string; branch: string } | null>(null);
  const [studioWhy, setStudioWhy] = useState<string | null | undefined>(undefined);
  const device = session.snapshot.device?.id ?? null;
  useEffect(() => {
    let alive = true;
    void studioHere(device).then((w) => alive && setStudioWhy(w));
    return () => void (alive = false);
  }, [device]);
  const goals = data.events.filter((e) => e.kind === "goal");
  const lastGoal = goals.at(-1);
  const patch = async (p: Parameters<Session["client"]["updateCowork"]>[1], done: string) => {
    try {
      session.putCowork(await session.client.updateCowork(cowork.id, p));
      toast(done);
      return true;
    } catch (err) {
      toast(errorText(err));
      return false;
    }
  };
  const setRole = async (a: CoworkAgent, role: "lead" | "worker", matter?: string) => {
    try {
      const r = await session.client.setCoworkAgentRole(cowork.id, a.mark, role, matter ?? null);
      session.putCowork(r.cowork);
      toast(`${a.label} 现在是${role === "lead" ? "这一方的主控" : `执行（${matterLabel(matters.find((m) => m.id === matter) ?? { no: 0 })}）`}`);
    } catch (err) {
      toast(errorText(err));
    }
  };
  const roleMenu = (a: CoworkAgent): MenuItem[] => [
    a.role !== "lead" ? { label: "设成主控", hint: "理这一方的流程、派活、和你沟通、改事项状态；一方只有一个", onClick: () => void setRole(a, "lead") } : null,
    null,
    ...matters
      .filter((m) => m.status !== "closed" && !(a.role === "worker" && a.matter === m.id))
      .slice(0, 10)
      .map((m): MenuItem => ({ label: `设成执行：${matterLabel(m)}「${m.title.slice(0, 18)}」`, hint: "只进这一件事项：在里面贴技术事实，不在群聊说话、不改事项", onClick: () => void setRole(a, "worker", m.id) })),
  ];
  const myLead = cowork.agents.find((a) => a.owner === me && a.role === "lead");
  const decisions = data.events.filter((e) => e.kind === "decision");
  const openMatters = matters.filter((m) => m.status !== "closed");
  const closed = matters.filter((m) => m.status === "closed");
  return (
    <>
      <SideBlock
        title="目标说明"
        action={
          !ended &&
          goalEdit == null && (
            <button type="button" className="link tiny" onClick={() => setGoalEdit(cowork.goal)}>
              改
            </button>
          )
        }
      >
        {goalEdit != null ? (
          <div className="cw-edit">
            <textarea value={goalEdit} onChange={(e) => setGoalEdit(e.target.value)} rows={6} aria-label="目标说明" autoFocus />
            <div className="cw-edit-acts">
              <button type="button" className="small" onClick={() => setGoalEdit(null)}>
                取消
              </button>
              <button type="button" className="small primary" onClick={() => void patch({ goal: goalEdit }, "目标改好了，之前的版本都留着").then((ok) => ok && setGoalEdit(null))}>
                保存
              </button>
            </div>
          </div>
        ) : (
          <div className="cw-goal">{cowork.goal ? <Markdown source={cowork.goal} /> : <span className="muted">还没写目标。</span>}</div>
        )}
        <button type="button" className="link tiny cw-goal-hist" onClick={props.onGoals}>
          {goals.length ? `改过 ${goals.length} 次 · 最近：${show(lastGoal!.actor)} ${timeText(lastGoal!.at)}` : "看目标的历史"}
        </button>
      </SideBlock>
      <SideBlock
        title="仓库和分支"
        action={
          !ended &&
          !whereEdit && (
            <button type="button" className="link tiny" onClick={() => setWhereEdit({ repo: cowork.repo, branch: cowork.branch })}>
              改
            </button>
          )
        }
      >
        {whereEdit ? (
          <div className="cw-edit">
            <input value={whereEdit.repo} onChange={(e) => setWhereEdit({ ...whereEdit, repo: e.target.value })} placeholder="仓库，比如 game-client" aria-label="仓库" />
            <input value={whereEdit.branch} onChange={(e) => setWhereEdit({ ...whereEdit, branch: e.target.value })} placeholder="分支，比如 feature/gatling-rate" aria-label="分支" />
            <div className="cw-edit-acts">
              <button type="button" className="small" onClick={() => setWhereEdit(null)}>
                取消
              </button>
              <button type="button" className="small primary" onClick={() => void patch({ repo: whereEdit.repo.trim(), branch: whereEdit.branch.trim() }, "仓库和分支改好了").then((ok) => ok && setWhereEdit(null))}>
                保存
              </button>
            </div>
          </div>
        ) : cowork.repo || cowork.branch ? (
          <div className="cw-where">
            <span>{cowork.repo}</span>
            {cowork.branch && <code className="branch">{cowork.branch}</code>}
          </div>
        ) : (
          <span className="muted tiny">没定。</span>
        )}
      </SideBlock>
      <SideBlock
        title={`成员 ${cowork.members.length} 人 · ${cowork.agents.length} 个 AI`}
        action={
          !ended && (
            <button type="button" className="link tiny" onClick={props.onPeople}>
              ＋ 拉人
            </button>
          )
        }
      >
        <div className="cw-people">
          {cowork.members.map((n) => {
            const m = people.get(n);
            return (
              <div key={n} className="cw-person" data-person={n}>
                <Avatar name={n} small />
                <span className="cw-person-text">
                  <b>
                    <Who name={n} />
                    {n === me ? "（我）" : ""}
                  </b>
                  <span className="muted tiny">{[n === cowork.createdBy ? "发起人" : "", m?.role ?? "", m?.online ? "在线" : "不在线"].filter(Boolean).join(" · ")}</span>
                </span>
                <span className={`dot ${m?.online ? "on" : ""}`} title={m?.online ? "在线" : "不在线"} />
              </div>
            );
          })}
          {cowork.agents.map((a) => {
            // 在 Studio 里打开 (2026-11-23): my own AIs only; one on another computer says so instead.
            const where = studioWhere(a.mark, a.owner, me, device);
            const role = roleText(a, matters);
            return (
              <div key={a.mark} className="cw-person agent" data-agent={a.mark}>
                <span className="avatar ai small">AI</span>
                <span className="cw-person-text">
                  <b>{show(a.owner)} 的 AI</b>
                  <span className="muted tiny">
                    <span className={`cw-role ${a.role ?? "none"}`}>{role}</span>
                    {a.label}
                    {a.owner === me ? " · 我的会话" : ""}
                  </span>
                  <span className="cw-person-acts">
                    {a.owner === me && !ended && (
                      <button type="button" className="link tiny" onClick={(e) => openMenu(e, roleMenu(a))} title="主控理这一方的流程；执行只进一件事项">
                        改角色
                      </button>
                    )}
                    {where === "here" && (
                      <button type="button" className="link tiny cw-to-studio" onClick={() => void openStudio(a.mark, toast)} title="去这台电脑的 Studio 里看这个会话">
                        在 Studio 里打开
                      </button>
                    )}
                    {where === "here" && a.role === "lead" && device && !ended && (
                      <button type="button" className="link tiny" onClick={() => void askStudio(patrolMark(device, cowork.id), "让主控现在看一遍了：它会把待它处理的过一遍", toast)} title="不等下一次巡检（每 2 分钟），现在就替它算一遍待它处理的，有就叫醒它">
                        让主控现在看一遍
                      </button>
                    )}
                    {where === "elsewhere" && <span className="muted tiny cw-elsewhere">在另一台电脑上</span>}
                  </span>
                </span>
                <span className={`cw-chip st-${a.state}`}>{agentChip(a)}</span>
              </div>
            );
          })}
          {!cowork.agents.length && <div className="muted tiny">还没有 AI。在自己的 Studio 会话上点「拉进协作」，或者用下面的按钮在 Studio 里开这一方的主控。</div>}
          {!myLead && !ended && (
            <div className="cw-lead-open">
              <button type="button" className="small primary" disabled={studioWhy !== null || !device} onClick={() => device && void askStudio(leadMark(device, cowork.id), "已交给 Studio：它会新开一个任务，带着目标、已定的事和板，拉进来当你这一方的主控", toast)} title={studioWhy ?? "在这台电脑的 Studio 里新开一个任务，带着目标、已定的事和板，它的会话进来当你这一方的主控"}>
                在我的 Studio 里开这一方的主控
              </button>
              {studioWhy && <span className="muted tiny">{studioWhy}</span>}
            </div>
          )}
        </div>
        <dl className="cw-legend" aria-label="AI 状态的意思">
          {STATE_LEGEND.map(([s, what]) => (
            <div key={s}>
              <dt className={`st-${s}`}>
                {STATE_MARK[s]} {STATE_WORD[s]}
              </dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </SideBlock>
      <SideBlock
        title="事项"
        count={matters.length}
        action={
          !ended && (
            <button type="button" className="link tiny" onClick={props.onMatter}>
              ＋ 开事项
            </button>
          )
        }
      >
        {!matters.length && <span className="muted tiny">还没有。具体的事开成事项：板上按负责方排好，人只在等你确认、叫你来看时才要动手。</span>}
        {[...openMatters, ...closed].map((m) => (
          <button key={m.id} type="button" className={`cw-subrow ${m.status === "closed" ? "closed" : ""}`} data-matter={m.id} onClick={() => openMatter(m.id)}>
            <span className="cw-subrow-no">{matterLabel(m)}</span>
            <span className="cw-subrow-title">{m.title}</span>
            <span className={`cw-state ${MATTER_CLS[m.status]}`}>{matterChip(m.status)}</span>
          </button>
        ))}
      </SideBlock>
      <SideBlock title="已定的事" count={decisions.length}>
        {!decisions.length && <span className="muted tiny">事项的结论记在这里。</span>}
        <ul className="cw-decisions">
          {decisions.map((e) => (
            <li key={e.id}>
              <span>{e.text}</span>
              <span className="muted tiny">
                {agentOf(cowork, e.agent)?.name ?? show(e.actor)} · {timeText(e.at)}
                {e.data?.threadId && (
                  <>
                    {" · "}
                    <button type="button" className="link tiny" onClick={() => openMatter(e.data!.threadId!)}>
                      {(() => {
                        const m = matters.find((x) => x.id === e.data!.threadId);
                        return m ? matterLabel(m) : "事项";
                      })()}
                    </button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </SideBlock>
      <SideBlock title="文件" count={props.files.length}>
        <FilesList session={session} files={props.files} onOpen={props.onOpenFile} onFiles={ended ? undefined : props.onFiles} uploading={props.uploading} />
      </SideBlock>
      <div className="cw-end">
        {ended ? (
          <button type="button" className="small" onClick={() => void patch({ ended: false }, "协作重新打开了")}>
            重新打开协作
          </button>
        ) : (
          <button type="button" className="small" onClick={() => confirm("结束这个协作？结束后不能再发消息、改板、拉 AI，有人重新打开后才行。") && void patch({ ended: true }, "协作结束了")}>
            结束协作
          </button>
        )}
        <button
          type="button"
          className="small ghost"
          onClick={() =>
            confirm("退出这个协作？你拉进来的 AI 也会一起离开。") &&
            void session.client.leaveCowork(cowork.id).then(
              () => toast("已退出协作"),
              (err) => toast(errorText(err)),
            )
          }
        >
          退出
        </button>
      </div>
    </>
  );
}

/** 发起协作: title, goal, repository and branch, people. */
export function NewCoworkDialog({ session, onClose, onMade }: { session: Session; onClose: () => void; onMade: (id: string) => void }) {
  const st = useSession(session);
  const me = session.me.name;
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [people, setPeople] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await session.client.createCowork({ title: title.trim(), goal: goal.trim(), repo: repo.trim(), branch: branch.trim(), members: people });
      session.putCowork(c);
      void session.loadCowork(c.id).catch(() => undefined);
      onMade(c.id);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="发起协作"
      sub="几个人带着各自的 AI 一起推进一件事"
      onClose={onClose}
      wide
      foot={
        <>
          {error && <span className="error tiny">{error}</span>}
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy || !title.trim()} onClick={() => void make()}>
            发起
          </button>
        </>
      }
    >
      <Field label="标题">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="比如：加特林射速调整" autoFocus />
      </Field>
      <Field label="目标" hint="所有人都能改，每一版都留着；边界情况没定的先走 AI 建议的默认值">
        <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={4} placeholder="要做成什么样，定了的写进哪份文档" />
      </Field>
      <div className="cw-two">
        <Field label="仓库">
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="game-client" />
        </Field>
        <Field label="分支">
          <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feature/gatling-rate" />
        </Field>
      </div>
      <Field label="拉人" hint="他们进来后再把自己这一方的主控拉进来">
        <div className="cw-pick-people">
          {listedOthers(st.members, me).map((m) => (
            <label key={m.name} className={`cw-pick ${people.includes(m.name) ? "on" : ""}`}>
              <input type="checkbox" checked={people.includes(m.name)} onChange={(e) => setPeople((p) => (e.target.checked ? [...p, m.name] : p.filter((x) => x !== m.name)))} />
              <Avatar name={m.name} small />
              <Who name={m.name} />
              {m.role && <span className="muted tiny">{m.role}</span>}
            </label>
          ))}
        </div>
      </Field>
      <p className="muted tiny">AI 碰到闸门（判红的改动、改已定的口径、合进 master、动别人的东西、对外发布）会开一件「等人确认」的事项来问你，其他时候直接做。闸门由 AI 自己判断，Studio 拦不住。</p>
    </Dialog>
  );
}

function AddPeopleDialog({ onClose }: { onClose: () => void }) {
  const { session, cowork, toast } = useCowork();
  const st = useSession(session);
  const [people, setPeople] = useState<string[]>([]);
  // Not 测试 or turned-off accounts (2026-11-23): they stay listed if already in it.
  const rest = listedOthers(st.members, session.me.name).filter((m) => !cowork.members.includes(m.name));
  const add = async () => {
    try {
      session.putCowork(await session.client.addCoworkMembers(cowork.id, people));
      toast(`拉进了 ${people.join("、")}`);
      onClose();
    } catch (err) {
      toast(errorText(err));
    }
  };
  return (
    <Dialog
      title="拉人进协作"
      sub="群聊和所有事项他们都能看到，包括之前的"
      onClose={onClose}
      foot={
        <>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={!people.length} onClick={() => void add()}>
            拉进来
          </button>
        </>
      }
    >
      {!rest.length && <p className="muted">团队里的人都在了。</p>}
      <div className="cw-pick-people">
        {rest.map((m) => (
          <label key={m.name} className={`cw-pick ${people.includes(m.name) ? "on" : ""}`}>
            <input type="checkbox" checked={people.includes(m.name)} onChange={(e) => setPeople((p) => (e.target.checked ? [...p, m.name] : p.filter((x) => x !== m.name)))} />
            <Avatar name={m.name} small />
            <Who name={m.name} />
          </label>
        ))}
      </div>
    </Dialog>
  );
}

function GoalsDialog({ onClose }: { onClose: () => void }) {
  const { session, cowork } = useCowork();
  const show = useDisplayName();
  const [goals, setGoals] = useState<CoworkGoalVersion[] | null>(null);
  useEffect(() => {
    void session.client.coworkGoals(cowork.id).then(setGoals, () => setGoals([]));
  }, [session, cowork.id]);
  const list = useMemo(() => [...(goals ?? [])].reverse(), [goals]);
  return (
    <Dialog title="目标的每一版" sub={cowork.title} onClose={onClose} wide>
      {!goals && <p className="muted">加载中…</p>}
      {list.map((g, i) => (
        <div key={g.id} className="cw-goalver">
          <div className="muted tiny">
            {i === 0 ? "现在的 · " : ""}
            {show(g.by)}
            {g.via.kind === "ai" ? " 的 AI" : ""} · {timeText(g.at)}
          </div>
          <div className="cw-goal">{g.goal ? <Markdown source={g.goal} /> : <span className="muted">（空）</span>}</div>
        </div>
      ))}
    </Dialog>
  );
}

/** 待处理's rows for what is mine in the 协作 (2026-11-25): 等你确认 / 叫你来看 的事项 and the 群聊's 知会, per 协作. */
export function CoworkWaitingRows({ session, onOpen }: { session: Session; onOpen: (coworkId: string, focus?: { sub?: string; seq?: number }) => void }) {
  const st = useSession(session);
  const show = useDisplayName();
  const w = coworkWaiting(st, session.me.name);
  if (!w.count) return null;
  return (
    <>
      <ListSection title="协作里要你看" count={w.count} />
      {w.rows.map(({ cowork, item }) =>
        item.kind === "matter" ? (
          <ListRow
            key={`${cowork.id}:${item.matter.id}`}
            className={`cw-wait ${item.look}`}
            avatar={<span className="avatar sq small">事</span>}
            title={`${LOOK_WORD[item.look]} · ${matterLabel(item.matter)} ${item.matter.title}`}
            time={timeText(item.since)}
            sub={`${cowork.title} · ${partyText(item.matter.owner, cowork.agents, show)} 开的`}
            onClick={() => onOpen(cowork.id, { sub: item.matter.id })}
          />
        ) : (
          <ListRow key={`${cowork.id}:n${item.seq}`} className="cw-wait at" avatar={<span className="avatar sq small">@</span>} title={`${item.word} · ${item.text.slice(0, 30)}`} time={timeText(item.since)} sub={`${cowork.title} 的群聊 · #${item.seq}`} onClick={() => onOpen(cowork.id, { seq: item.seq })} />
        ),
      )}
    </>
  );
}
