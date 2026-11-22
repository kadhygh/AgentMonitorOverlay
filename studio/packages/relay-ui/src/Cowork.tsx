import { useEffect, useMemo, useState } from "react";
import { BoardBody } from "./Board.js";
import { agentOf, CoworkComposer, CoworkContext, CoworkMessages, DraftCard, subState, useCowork, type CoworkCtx } from "./CoworkChat.js";
import { SubSessionBody } from "./CoworkSession.js";
import { agentChip, STATE_LEGEND, STATE_MARK, STATE_WORD } from "./coworkText.js";
import { Avatar, avatarColor, timeText, useDisplayName, usePeople, Who } from "./bits.js";
import { Check, Dialog, Field } from "./Dialog.js";
import { FilesList, FileViewer, PickFiles, useThreadFiles, useUpload } from "./Files.js";
import { FloatTabs, FloatWindow, useFloats } from "./Floats.js";
import { ListRow, ListSection, SideBlock, SidePanel, useSidePanel } from "./Layout.js";
import { Markdown } from "./Markdown.js";
import { errorText, useMessages } from "./Messages.js";
import { EMPTY_COWORK_DATA, useSession, type Session } from "./session.js";
import type { CoworkDraft, CoworkGoalVersion, CoworkListItem, CoworkSession, Message } from "./shared.js";

// 协作 (2026-11-23, plans/cowork.md, prototype A's 协作 page): the list (进行中 / 已结束, unread, 「[@我]」), 发起协作, and
// one 协作 — its 群聊 in the middle, the 信息栏 on the right (目标 with its versions, 仓库和分支, 成员 with each AI's state,
// 子会话, 已定的事, 文件, 「AI 发起 @ 和提问」, 拉人, 结束 / 重新打开), its 子会话 and 白板 as floating windows over the page
// (Floats.tsx, 第 9 条). 待处理 sums up what waits on me in all of them (coworkWaiting).

/** What waits on me across my coworks: @-s not read, 子会话 waiting on my answer, my AIs' drafts. */
export function coworkWaiting(s: { coworks: CoworkListItem[]; coworkData: Record<string, { drafts: CoworkDraft[] }>; mentions: Message[] }, me: string) {
  const subs = s.coworks.filter((c) => !c.endedAt).flatMap((c) => c.sessions.filter((x) => x.state !== "done" && x.waitingOn === me && x.to === me).map((x) => ({ cowork: c, sub: x })));
  const drafts = s.coworks.flatMap((c) => (s.coworkData[c.id]?.drafts ?? []).filter((d) => d.state === "pending" && d.owner === me).map((d) => ({ cowork: c, draft: d })));
  const mentions = s.mentions.flatMap((m) => {
    const c = s.coworks.find((x) => x.id === m.threadId || x.sessions.some((y) => y.id === m.threadId));
    return c ? [{ cowork: c, message: m }] : [];
  });
  return { subs, drafts, mentions, count: subs.length + drafts.length + mentions.length };
}

/** A cowork's unread (its 群聊 and its 子会话) and whether something there @-s me. */
function unreadOf(session: Session, c: CoworkListItem) {
  const ids = new Set([c.id, ...c.sessions.map((s) => s.id)]);
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
    const open = c.sessions.filter((s) => s.state !== "done").length;
    const sub = atMe ? (
      <>
        <span className="at-me">[@我]</span> {show(atMe.author)}：{atMe.body.replace(/\s+/g, " ").slice(0, 40)}
      </>
    ) : c.endedAt ? (
      `已结束${decided ? ` · 已定 ${decided} 件` : ""}`
    ) : last && last.kind !== "event" ? (
      `${agentOf(c, last.via.kind === "ai" ? last.via.conv : null)?.name ?? show(last.author)}：${last.body.replace(/\s+/g, " ").slice(0, 40)}`
    ) : (
      [decided ? `已定 ${decided} 件` : "", open ? `${open} 个子会话开着` : "", !decided && !open ? `${c.members.length} 人 · ${c.agents.length} 个 AI` : ""].filter(Boolean).join(" · ")
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

/** One 协作: the 群聊, the 信息栏, its 子会话 and 白板 as windows. `focus` opens a 子会话 (from 待处理, a notification). */
export function CoworkView({ session, cowork, toast, focus, onOpenFile }: { session: Session; cowork: CoworkListItem; toast: (t: string) => void; focus: { sub?: string; n: number } | null; onOpenFile?: (id: string) => void }) {
  const st = useSession(session);
  const show = useDisplayName();
  const floats = useFloats();
  const me = session.me.name;
  const data = st.coworkData[cowork.id] ?? EMPTY_COWORK_DATA;
  const side = useSidePanel("cowork");
  const { messages, error } = useMessages(session, cowork.id);
  const [typing, setTyping] = useState(false);
  const [boardFocus, setBoardFocus] = useState<{ session: string; n: number } | null>(null);
  const [dialog, setDialog] = useState<null | "sub" | "people" | "goals">(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const files = useThreadFiles(session, cowork.id, cowork.updatedAt);
  const { upload, busy: uploading } = useUpload(session, { threadId: cowork.id }, toast);

  // Events and drafts: loaded when first opened (the list loads the open ones; an ended one on demand).
  useEffect(() => {
    if (!st.coworkData[cowork.id]) void session.loadCowork(cowork.id).catch(() => undefined);
  }, [cowork.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const subTitle = (s: CoworkSession) => {
    const x = subState(s, show, me);
    return { title: `子会话：${s.title}`, status: x.word.replace(/^[✓!◐○] /, "") };
  };
  // (One just asked may not be in the list yet: its window opens with its title and fills in once it comes.)
  const openSub = (id: string, title?: string) => {
    const s = cowork.sessions.find((x) => x.id === id);
    if (s || title) floats.open({ id: `sub:${id}`, ...(s ? subTitle(s) : { title: `子会话：${title}`, status: "开着" }), size: { w: 520, h: 560 } });
  };
  const openBoard = (sub?: string) => {
    floats.open({ id: `board:${cowork.id}`, title: `白板 · ${cowork.title}`, size: { w: 860, h: 560 } });
    if (sub) setBoardFocus((f) => ({ session: sub, n: (f?.n ?? 0) + 1 }));
  };
  // A 子会话's window title follows its state.
  useEffect(() => {
    for (const s of cowork.sessions) if (floats.isOpen(`sub:${s.id}`)) floats.setInfo(`sub:${s.id}`, subTitle(s));
  }, [cowork.sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (focus?.sub) openSub(focus.sub);
  }, [focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const ctx: CoworkCtx = { session, cowork, data, me, openSub, openBoard, toast };
  const ended = !!cowork.endedAt;
  const decisions = data.events.filter((e) => e.kind === "decision");
  const openSubs = cowork.sessions.filter((s) => s.state !== "done").length;
  const drafts = data.drafts.filter((d) => d.state === "pending" && (d.kind === "ask" || d.threadId === cowork.id || !d.threadId));
  const where = [cowork.repo, cowork.branch].filter(Boolean);

  const pasteToBoard = async (text: string) => {
    try {
      await session.client.coworkBoardOps(cowork.id, [{ op: "add", opId: `o${Date.now().toString(36)}`, item: { kind: "note", text, x: 40 + Math.round(Math.random() * 80), y: 40 + Math.round(Math.random() * 80), w: 220, h: 120 } }]);
      openBoard();
      toast("贴到了白板上");
    } catch (err) {
      toast(errorText(err));
    }
  };

  return (
    <CoworkContext.Provider value={ctx}>
      <div className="view cowork-view">
        <div className="cw-main">
          <div className="page-head">
            <div className="head-main">
              <h1 className="head-title">{cowork.title}</h1>
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
                  {cowork.sessions.length} 个子会话{openSubs ? `（${openSubs} 开着）` : ""}
                </span>
                <span>已定 {decisions.length} 件</span>
              </div>
            </div>
            <div className="head-actions">
              <button type="button" className="primary" onClick={() => openBoard()}>
                打开白板
              </button>
              {!ended && (
                <button type="button" onClick={() => setDialog("sub")}>
                  ＋ 子会话
                </button>
              )}
              <button type="button" className="side-toggle" onClick={() => side.setOpen(!side.open)}>
                {side.open ? "收起信息栏" : "信息栏"}
              </button>
            </div>
          </div>
          <CoworkMessages threadId={cowork.id} messages={messages} error={error} typing={typing} withEvents empty="群里还没有消息。说点什么，或者 @ 某人、某个 AI。" after={drafts.map((d) => <DraftCard key={d.id} draft={d} />)} />
          <div className="cw-dock">
            <FloatTabs />
            <CoworkComposer
              placeholder={`发到「${cowork.title}」… 用 @ 叫人或叫某个 AI；只有被 @ 的 AI 会被唤醒`}
              onTyping={setTyping}
              disabled={ended ? "协作已结束：重新打开后才能说话（信息栏最下面）。" : null}
              tools={
                <>
                  <PickFiles small label={uploading ? "上传中…" : "附加文件"} disabled={uploading} onFiles={(fl) => void upload(fl)} />
                  <button type="button" className="small ghost" onClick={() => setDialog("sub")}>
                    发起子会话
                  </button>
                  <PasteToBoard onPaste={pasteToBoard} />
                </>
              }
            />
          </div>
        </div>
        {side.open && (
          <SidePanel label="信息栏" title="协作信息" className="info-panel cw-info" onClose={() => side.setOpen(false)}>
            <InfoPanel files={files} onFiles={(fl) => void upload(fl)} uploading={uploading} onOpenFile={(id) => (onOpenFile ? onOpenFile(id) : setViewing(id))} onPeople={() => setDialog("people")} onGoals={() => setDialog("goals")} />
          </SidePanel>
        )}
      </div>
      {cowork.sessions.map((s) => (
        <FloatWindow key={s.id} id={`sub:${s.id}`} className="cw-subwin">
          <SubSessionBody sub={s} />
        </FloatWindow>
      ))}
      <FloatWindow id={`board:${cowork.id}`} className="cw-boardwin">
        <BoardBody focus={boardFocus} />
      </FloatWindow>
      {dialog === "sub" && <NewSubDialog onClose={() => setDialog(null)} onMade={(id, title) => (setDialog(null), openSub(id, title))} />}
      {dialog === "people" && <AddPeopleDialog onClose={() => setDialog(null)} />}
      {dialog === "goals" && <GoalsDialog onClose={() => setDialog(null)} />}
      {viewing && <FileViewer session={session} fileId={viewing} onClose={() => setViewing(null)} toast={toast} />}
    </CoworkContext.Provider>
  );
}

/** 贴到白板: the text typed so far (or asked for) as a 便签. */
function PasteToBoard({ onPaste }: { onPaste: (text: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  return (
    <>
      <button type="button" className="small ghost" onClick={() => setOpen(true)}>
        贴到白板
      </button>
      {open && (
        <Dialog
          title="贴到白板"
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
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="写在便签上的字（白板上所有人和 AI 都看得到）" aria-label="便签的字" autoFocus />
        </Dialog>
      )}
    </>
  );
}

function InfoPanel(props: { files: ReturnType<typeof useThreadFiles>; onFiles: (fl: FileList) => void; uploading: boolean; onOpenFile: (id: string) => void; onPeople: () => void; onGoals: () => void }) {
  const { session, cowork, data, me, toast, openSub } = useCowork();
  const show = useDisplayName();
  const people = usePeople();
  const ended = !!cowork.endedAt;
  const [goalEdit, setGoalEdit] = useState<string | null>(null);
  const [whereEdit, setWhereEdit] = useState<{ repo: string; branch: string } | null>(null);
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
  const decisions = data.events.filter((e) => e.kind === "decision");
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
          {cowork.agents.map((a) => (
            <div key={a.mark} className="cw-person agent" data-agent={a.mark}>
              <span className="avatar ai small">AI</span>
              <span className="cw-person-text">
                <b>{show(a.owner)} 的 AI</b>
                <span className="muted tiny">
                  {a.label}
                  {a.owner === me ? " · 我的会话" : ""}
                </span>
              </span>
              <span className={`cw-chip st-${a.state}`}>{agentChip(a)}</span>
            </div>
          ))}
          {!cowork.agents.length && <div className="muted tiny">还没有 AI。在自己的 Studio 会话上点「拉进协作」，那个会话就能在这里回复、写白板。</div>}
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
      <SideBlock title="子会话" count={cowork.sessions.length}>
        {!cowork.sessions.length && <span className="muted tiny">还没有。要和某人确认一件事时，点「＋ 子会话」。</span>}
        {cowork.sessions.map((s) => {
          const x = subState(s, show, me);
          return (
            <button key={s.id} type="button" className="cw-subrow" data-session={s.id} onClick={() => openSub(s.id)}>
              <span className="cw-subrow-title">{s.title}</span>
              <span className={`cw-state ${x.cls}`}>{x.word}</span>
            </button>
          );
        })}
      </SideBlock>
      <SideBlock title="已定的事" count={decisions.length}>
        {!decisions.length && <span className="muted tiny">子会话定下的结论记在这里。</span>}
        <ul className="cw-decisions">
          {decisions.map((e) => (
            <li key={e.id}>
              <span>{e.text}</span>
              <span className="muted tiny">
                {agentOf(cowork, e.agent)?.name ?? show(e.actor)} · {timeText(e.at)}
                {e.data?.threadId && (
                  <>
                    {" · "}
                    <button type="button" className="link tiny" onClick={() => openSub(e.data!.threadId!)}>
                      子会话
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
      <SideBlock title="选项">
        <Check checked={cowork.options.aiInitiate} onChange={(v) => void patch({ options: { aiInitiate: v } }, v ? "AI 现在可以直接 @ 人、发起子会话" : "AI 的 @ 和提问先存草稿，主人确认后才发出")}>
          AI 发起 @ 和提问
        </Check>
        <div className="muted tiny">{cowork.options.aiInitiate ? "开着：AI @ 人、发起子会话直接发出。" : "关着（默认）：AI @ 人、发起子会话先存成草稿，只有它的主人看得到，确认了才发出。"}</div>
      </SideBlock>
      <div className="cw-end">
        {ended ? (
          <button type="button" className="small" onClick={() => void patch({ ended: false }, "协作重新打开了")}>
            重新打开协作
          </button>
        ) : (
          <button type="button" className="small" onClick={() => confirm("结束这个协作？结束后不能再发消息、改白板、拉 AI，有人重新打开后才行。") && void patch({ ended: true }, "协作结束了")}>
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


/** 发起协作: title, goal, repository and branch, people; 「AI 发起 @ 和提问」 off unless ticked. */
export function NewCoworkDialog({ session, onClose, onMade }: { session: Session; onClose: () => void; onMade: (id: string) => void }) {
  const st = useSession(session);
  const me = session.me.name;
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("");
  const [people, setPeople] = useState<string[]>([]);
  const [ai, setAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await session.client.createCowork({ title: title.trim(), goal: goal.trim(), repo: repo.trim(), branch: branch.trim(), members: people, options: { aiInitiate: ai } });
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
      <Field label="拉人" hint="他们进来后再把自己的 AI 会话拉进来">
        <div className="cw-pick-people">
          {st.members
            .filter((m) => m.name !== me)
            .map((m) => (
              <label key={m.name} className={`cw-pick ${people.includes(m.name) ? "on" : ""}`}>
                <input type="checkbox" checked={people.includes(m.name)} onChange={(e) => setPeople((p) => (e.target.checked ? [...p, m.name] : p.filter((x) => x !== m.name)))} />
                <Avatar name={m.name} small />
                <Who name={m.name} />
                {m.role && <span className="muted tiny">{m.role}</span>}
              </label>
            ))}
        </div>
      </Field>
      <Check checked={ai} onChange={setAi}>
        AI 发起 @ 和提问（默认关：AI 要 @ 人、发起子会话时先存草稿，主人确认后才发出）
      </Check>
    </Dialog>
  );
}

function AddPeopleDialog({ onClose }: { onClose: () => void }) {
  const { session, cowork, toast } = useCowork();
  const st = useSession(session);
  const [people, setPeople] = useState<string[]>([]);
  const rest = st.members.filter((m) => !cowork.members.includes(m.name));
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
      sub="群聊和所有子会话他们都能看到，包括之前的"
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

/** ＋ 子会话: a question for someone in the 协作 (everyone sees it and can write in). */
function NewSubDialog({ onClose, onMade }: { onClose: () => void; onMade: (id: string, title: string) => void }) {
  const { session, cowork, me, toast } = useCowork();
  const others = cowork.members.filter((n) => n !== me);
  const [to, setTo] = useState(others[0] ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [qs, setQs] = useState<Array<{ text: string; options: string }>>([]);
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      const questions = qs.filter((q) => q.text.trim()).map((q) => ({ text: q.text.trim(), options: q.options.trim() ? q.options.split(/[,，、/]/).map((o) => o.trim()).filter(Boolean) : undefined }));
      const r = await session.client.askCowork(cowork.id, { to, title: title.trim(), body: body.trim(), questions: questions.length ? questions : undefined });
      if (r.thread) {
        toast(`子会话发给了 ${to}`);
        onMade(r.thread.id, r.thread.title);
      } else onClose();
    } catch (err) {
      toast(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="发起子会话"
      sub="一件要确认的事：在群里折叠成一张卡，协作里的人都能看、能插话"
      onClose={onClose}
      wide
      foot={
        <>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy || !to || !title.trim()} onClick={() => void make()}>
            发起
          </button>
        </>
      }
    >
      <Field label="问谁">
        <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="问谁">
          {others.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Field>
      <Field label="标题">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="比如：过热后射速怎么回落？" autoFocus />
      </Field>
      <Field label="说明">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="背景、列出的几种做法（支持 Markdown）" />
      </Field>
      <Field label="要逐条回答的问题（可以没有）">
        <div className="cw-qs">
          {qs.map((q, i) => (
            <div key={i} className="cw-q">
              <input value={q.text} onChange={(e) => setQs((l) => l.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} placeholder={`问题 ${i + 1}`} aria-label={`问题 ${i + 1}`} />
              <input value={q.options} onChange={(e) => setQs((l) => l.map((x, j) => (j === i ? { ...x, options: e.target.value } : x)))} placeholder="选项，用逗号隔开（可以空着）" aria-label={`问题 ${i + 1} 的选项`} />
            </div>
          ))}
          <button type="button" className="small" onClick={() => setQs((l) => [...l, { text: "", options: "" }])}>
            ＋ 加一个问题
          </button>
        </div>
      </Field>
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

/** 待处理's cards for what waits on me in the 协作 (2026-11-23, prototype A's 待处理): @我的, 等我回的子会话, 等我确认的 AI 草稿. */
export function CoworkWaitingRows({ session, onOpen }: { session: Session; onOpen: (coworkId: string, sub?: string) => void }) {
  const st = useSession(session);
  const show = useDisplayName();
  const w = coworkWaiting(st, session.me.name);
  if (!w.count) return null;
  return (
    <>
      <ListSection title="协作里等我" count={w.count} />
      {w.drafts.map(({ cowork, draft }) => (
        <ListRow
          key={draft.id}
          className="cw-wait draft"
          avatar={<span className="avatar ai small">AI</span>}
          title={draft.kind === "ask" ? `草稿：子会话「${draft.ask?.title ?? ""}」` : `草稿：${(draft.post?.body ?? "").replace(/\s+/g, " ").slice(0, 30)}`}
          time={timeText(draft.createdAt)}
          sub={`等我确认的 AI 草稿 · ${cowork.title} · ${agentOf(cowork, draft.agent)?.name ?? "我的 AI"}`}
          onClick={() => onOpen(cowork.id, draft.threadId && draft.threadId !== cowork.id ? draft.threadId : undefined)}
        />
      ))}
      {w.mentions.map(({ cowork, message }) => (
        <ListRow
          key={message.id}
          className="cw-wait at"
          avatar={<Avatar name={message.author} small />}
          title={`@我 · ${show(message.author)}${message.via.kind === "ai" ? " 的 AI" : ""}`}
          time={timeText(message.createdAt)}
          sub={`${cowork.title}：${message.body.replace(/\s+/g, " ").slice(0, 40)}`}
          onClick={() => onOpen(cowork.id, message.threadId !== cowork.id ? message.threadId : undefined)}
        />
      ))}
      {w.subs.map(({ cowork, sub }) => (
        <ListRow
          key={sub.id}
          className="cw-wait sub"
          avatar={<span className="avatar sq small">子</span>}
          title={sub.title}
          time={timeText(sub.updatedAt)}
          sub={`等我回的子会话 · ${cowork.title} · ${sub.agent ? (agentOf(cowork, sub.agent)?.name ?? "AI") : show(sub.from)} 问`}
          onClick={() => onOpen(cowork.id, sub.id)}
        />
      ))}
    </>
  );
}
