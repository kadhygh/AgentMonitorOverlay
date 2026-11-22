import { useEffect, useMemo, useState } from "react";
import { canHandToStudio, toMySession } from "./coworkHandoff.js";
import { agentOf, CoworkComposer, CoworkMessages, DraftCard, subState, useCowork } from "./CoworkChat.js";
import { useDisplayName } from "./bits.js";
import { Dialog } from "./Dialog.js";
import { errorText, useMessages } from "./Messages.js";
import type { Answer, CoworkSession, Question } from "./shared.js";

// A 子会话's window (2026-11-23, plans/cowork.md 第 9 条): floats over the 协作 page, several at once. Its rounds; the
// person asked answers the questions one by one; anyone in the 协作 writes in (插话 — @ an AI to wake it); the asker or
// the person asked settles it (定下结论, into 已定的事); 在白板上看 shows its card; 转到我的会话 takes it to my Studio
// (coworkHandoff.ts: through the shell's 在 Studio 里打开; copied when no Studio here takes it).

export function SubSessionBody({ sub }: { sub: CoworkSession }) {
  const { session, cowork, data, me, toast, openBoard } = useCowork();
  const show = useDisplayName();
  const thread = session.snapshot.threads.find((t) => t.id === sub.id);
  const { messages, error } = useMessages(session, sub.id);
  const [typing, setTyping] = useState(false);
  const [concluding, setConcluding] = useState(false);
  const st = subState(sub, show, me);
  const asker = sub.agent ? (agentOf(cowork, sub.agent)?.name ?? `${show(sub.from)} 的 AI`) : show(sub.from);
  // The questions of the latest round (the request's, or a follow-up's that asked more).
  const round = useMemo<Question[]>(() => [...(messages ?? [])].reverse().find((m) => m.kind !== "reply" && m.questions?.length)?.questions ?? [], [messages]);
  const rounds = (messages ?? []).filter((m) => m.kind === "request" || (m.kind === "text" && m.questions?.length) || m.kind === "reply").length;
  const mayConclude = sub.state !== "done" && !cowork.endedAt && (sub.from === me || sub.to === me);
  const answering = sub.state !== "done" && sub.waitingOn === me && sub.to === me && round.length > 0;
  const drafts = data.drafts.filter((d) => d.state === "pending" && d.threadId === sub.id);
  const device = session.snapshot.device?.id ?? null;
  const [studio, setStudio] = useState(false);
  useEffect(() => {
    let alive = true;
    void canHandToStudio(device, sub.id).then((v) => alive && setStudio(v));
    return () => void (alive = false);
  }, [device, sub.id]);

  const hand = async () => {
    if (!thread || !messages) return;
    try {
      const r = await toMySession(device, cowork, thread, messages);
      toast(r.sent ? "在 Studio 里选一个会话（或新开一个任务）接手它" : `${r.why ? `${r.why}。` : ""}已复制这个子会话的全文，贴进你的 Studio 会话`);
    } catch (err) {
      toast(errorText(err));
    }
  };
  return (
    <div className="cw-sub">
      <div className="cw-sub-head">
        <div className="cw-sub-meta">
          <span>
            {asker} 问 → {show(sub.to)}
          </span>
          <span className={`cw-state ${st.cls}`}>{st.word}</span>
          <span className="muted">{rounds} 轮</span>
        </div>
        <div className="cw-sub-acts">
          <button type="button" className="small primary" onClick={() => void hand()} title={studio ? "到这台电脑的 Studio 里选一个会话（或新开一个任务）接手：全文送进去，那个会话也拉进这个协作" : "这台电脑上没有开着的 Studio：复制全文，贴进你的会话"}>
            转到我的会话
          </button>
          <button type="button" className="small" onClick={() => openBoard(sub.id)}>
            在白板上看
          </button>
          {mayConclude && (
            <button type="button" className="small" onClick={() => setConcluding(true)}>
              定下结论…
            </button>
          )}
        </div>
        {sub.conclusion && (
          <div className="cw-conclusion">
            <b>结论</b> {sub.conclusion}
          </div>
        )}
      </div>
      <CoworkMessages threadId={sub.id} messages={messages} error={error} typing={typing} empty="还没有消息。" after={drafts.map((d) => <DraftCard key={d.id} draft={d} />)} />
      {answering && <AnswerForm threadId={sub.id} questions={round} asker={asker} />}
      {sub.state !== "done" && !cowork.endedAt && <CoworkComposer threadId={sub.id} placeholder="插话或回答…（协作里的人都能看到；@ 谁就叫醒谁，AI 也一样）" onTyping={setTyping} />}
      {concluding && <ConcludeDialog sub={sub} onClose={() => setConcluding(false)} />}
    </div>
  );
}

/** The person asked answers this round's questions one by one (as a reply: back to the asker). */
function AnswerForm({ threadId, questions, asker }: { threadId: string; questions: Question[]; asker: string }) {
  const { session, toast } = useCowork();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const answers: Answer[] = questions.map((q) => ({ questionId: q.id, choice: choice[q.id] || undefined, text: texts[q.id]?.trim() || undefined })).filter((a) => a.choice || a.text);
  const send = async () => {
    setBusy(true);
    try {
      await session.client.send(threadId, { kind: "reply", answers });
      toast(`已回答，回到 ${asker} 手里`);
      setOpen(false);
      setChoice({});
      setTexts({});
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <div className="cw-answer-bar">
        <span>等你回答 {questions.length} 个问题</span>
        <button type="button" className="small primary" onClick={() => setOpen(true)}>
          逐条回答
        </button>
      </div>
    );
  return (
    <div className="dock reply-form cw-answer">
      {questions.map((q, i) => (
        <div key={q.id} className="rq">
          <div className="rq-text">
            <span className="rq-n">{i + 1}</span>
            {q.text}
          </div>
          <div>
            {q.options && (
              <div className="options">
                {q.options.map((o) => (
                  <button key={o} type="button" className={`opt ${choice[q.id] === o ? "on" : ""}`} onClick={() => setChoice((c) => ({ ...c, [q.id]: c[q.id] === o ? "" : o }))}>
                    {o}
                  </button>
                ))}
              </div>
            )}
            <input value={texts[q.id] ?? ""} onChange={(e) => setTexts((t) => ({ ...t, [q.id]: e.target.value }))} placeholder={q.options ? "补充说明，或写自己的答案" : "你的回答"} aria-label={`回答：${q.text}`} />
          </div>
        </div>
      ))}
      <div className="acts">
        <span className="why">回答后回到 {asker} 手里</span>
        <button type="button" onClick={() => setOpen(false)}>
          收起
        </button>
        <button type="button" className="primary" disabled={busy || !answers.length} onClick={() => void send()}>
          回答
        </button>
      </div>
    </div>
  );
}

function ConcludeDialog({ sub, onClose }: { sub: CoworkSession; onClose: () => void }) {
  const { session, cowork, toast } = useCowork();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await session.client.concludeCowork(cowork.id, sub.id, text.trim());
      session.putEvent(r.event);
      toast("结论记进了「已定的事」");
      onClose();
    } catch (err) {
      toast(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="定下结论"
      sub={sub.title}
      onClose={onClose}
      foot={
        <>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => void save()}>
            定下
          </button>
        </>
      }
    >
      <p className="muted tiny">子会话就此结束，结论记进协作的「已定的事」，所有人和 AI 都看得到。</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="定了什么，比如：回落 1.2 秒线性，回落期间不能开火" aria-label="结论" autoFocus />
    </Dialog>
  );
}
