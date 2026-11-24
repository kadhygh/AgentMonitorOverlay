import { useEffect, useMemo, useState, type ReactNode } from "react";
import { canHandToStudio, toMySession } from "./coworkHandoff.js";
import { agentOf, CoworkComposer, CoworkMessages, markMine, matterWhy, useCowork } from "./CoworkChat.js";
import { timeText, useDisplayName, useListed } from "./bits.js";
import { Dialog, Field } from "./Dialog.js";
import { basisOf, confirmParts, inferredCount, LOOK_WORD, MATTER_CLS, matterChip, matterLabel, partyText, sideText, type LookItem } from "./matterView.js";
import { copyRef } from "./RefChips.js";
import { matterRef } from "./refs.js";
import { errorText, useMessages } from "./Messages.js";
import { GATE_LABEL, MATTER_STATUS_LABEL, personParty, RelayClientError, type Answer, type GateKind, type Matter, type MatterKind, type MatterPatch, type Party, type Question } from "./shared.js";

// A 事项 opened (2026-11-25, plans/collab-framework.md「11-24」, prototype studio/out/cowork-flow/board.html's drawer): over the
// 群聊 as a window, on the board as a drawer. What it is and where it stands — 事项 N, its state, 负责方, whom it waits on
// and why; when it waits on me, 「等你确认」 (a 闸门: 变化 / 例子 / 不确认会怎样 / 来源, 「确认」 or 「有问题，回一句」) or
// 「叫你来看」 (「看过了」); 事项信息 (卡在哪 and 结论 a person changes, 依赖, 闸门, 绑定); its messages folded shut until opened
// (opening them is 看过); 状态变化. A person closes it with a conclusion or opens it again; 转到我的会话 takes it to my Studio.

export function MatterBody({ matter: m, onBoard, onClose }: { matter: Matter; onBoard?: () => void; onClose?: () => void }) {
  const ctx = useCowork();
  const { session, cowork, me, toast, looks, matters, openMatter } = ctx;
  const show = useDisplayName();
  const thread = session.snapshot.threads.find((t) => t.id === m.id);
  const look = looks.find((l): l is Extract<LookItem, { kind: "matter" }> => l.kind === "matter" && l.matter.id === m.id);
  const [open, setOpen] = useState<{ messages: boolean; info: boolean; history: boolean }>({ messages: false, info: false, history: false });
  // 看过 once it is opened: its messages unfolded, or it is mine to look at and I opened it (what is shown is its text).
  const { messages, error } = useMessages(session, m.id, open.messages || !!look);
  const [typing, setTyping] = useState(false);
  const [dialog, setDialog] = useState<null | "close">(null);
  const ended = !!cowork.endedAt;
  const first = messages?.find((x) => x.kind === "request") ?? messages?.[0];
  const round = useMemo<Question[]>(() => [...(messages ?? [])].reverse().find((x) => x.kind !== "reply" && x.questions?.length)?.questions ?? [], [messages]);
  const request = thread?.request;
  const askedMe = !!request && request.to === me && request.from !== me && request.state !== "done" && request.waitingOn === me;
  const inferred = inferredCount(messages ?? []);
  const live = (messages ?? []).filter((x) => x.kind !== "event" && !x.withdrawnAt).length;
  const device = session.snapshot.device?.id ?? null;
  const [studio, setStudio] = useState(false);
  useEffect(() => {
    let alive = true;
    void canHandToStudio(device, m.id).then((v) => alive && setStudio(v));
    return () => void (alive = false);
  }, [device, m.id]);

  const patch = async (p: MatterPatch, done: string) => {
    try {
      session.putMatter(cowork.id, await session.client.patchMatter(cowork.id, m.id, { base: m.version, ...p }));
      toast(done);
      return true;
    } catch (err) {
      toast(err instanceof RelayClientError && err.status === 409 ? `${matterLabel(m)} 刚被别人改过，看一眼现在的再改` : errorText(err));
      return false;
    }
  };
  const hand = async () => {
    if (!thread || !messages) return;
    try {
      const r = await toMySession(device, cowork, thread, messages);
      toast(r.sent ? "在 Studio 里选一个会话（或新开一个任务）接手它" : `${r.why ? `${r.why}。` : ""}已复制这件事项的全文，贴进你的 Studio 会话`);
    } catch (err) {
      toast(errorText(err));
    }
  };
  const gateText = m.gate ? GATE_LABEL[m.gate] : m.kind === "confirm" ? "闸门" : null;

  return (
    <div className="cw-sub cw-matter" data-matter={m.id}>
      <div className="cw-sub-head">
        <div className="cw-matter-crumb muted tiny">
          {matterLabel(m)}
          {gateText ? ` · 闸门${m.gate ? `：${gateText}` : ""}` : ""} · {cowork.title}
          {onClose && (
            <button type="button" className="link tiny cw-matter-x" onClick={onClose}>
              关闭 ×
            </button>
          )}
        </div>
        {onClose && <h2 className="cw-matter-title">{m.title}</h2>}
        <div className="cw-sub-meta">
          <span className={`cw-state ${MATTER_CLS[m.status]}`}>{matterChip(m.status)}</span>
          <span>负责 {sideText(m, cowork.agents, show)}</span>
          <span className="muted">{matterWhy(m, cowork.agents, show, me)}</span>
          {inferred > 0 && <span className="tag cw-basis inferred">! 用了 {inferred} 条「我的判断」</span>}
        </div>
        <div className="cw-sub-acts">
          <button type="button" className="small" onClick={() => void hand()} title={studio ? "到这台电脑的 Studio 里选一个会话（或新开一个任务）接手：全文送进去，那个会话也拉进这个协作" : "这台电脑上没有开着的 Studio：复制全文，贴进你的会话"}>
            转到我的会话
          </button>
          {onBoard && (
            <button type="button" className="small" onClick={onBoard}>
              在板上看
            </button>
          )}
          <button type="button" className="small ghost" onClick={() => copyRef(matterRef(m, cowork.id), `${matterLabel(m)}「${m.title}」`, toast)} title="复制一行引用（事项编号、标题和它的协作），贴进聊天或 AI 会话里都认得">
            复制引用
          </button>
          {!ended &&
            (m.status === "closed" ? (
              <button type="button" className="small" onClick={() => void patch({ status: "doing", note: "重新打开" }, `${matterLabel(m)} 重新打开了`)}>
                重新打开
              </button>
            ) : (
              <button type="button" className="small" onClick={() => setDialog("close")}>
                关闭…
              </button>
            ))}
        </div>
        {m.conclusion && (
          <div className="cw-conclusion">
            <b>结论</b> {m.conclusion}
          </div>
        )}
      </div>
      <div className="cw-matter-scroll">
        {look && !ended && (askedMe && look.look === "confirm" ? <ConfirmBox matter={m} first={first ?? null} questions={round} /> : <LookBox look={look} />)}
        <Fold title="事项信息" open={open.info} onToggle={() => setOpen((o) => ({ ...o, info: !o.info }))}>
          <MatterInfo matter={m} onPatch={patch} onOpen={openMatter} all={matters} />
        </Fold>
        <Fold title={`事项里的消息 · ${messages ? live : "…"}`} open={open.messages} onToggle={() => setOpen((o) => ({ ...o, messages: !o.messages }))} className="cw-fold-msgs">
          <CoworkMessages threadId={m.id} messages={messages} error={error} typing={typing} empty="还没有消息。" />
          {m.status !== "closed" && !ended && <CoworkComposer threadId={m.id} placeholder="在这件事项里说…（只送到相关的主控和执行；@ 谁就叫醒谁）" onTyping={setTyping} />}
        </Fold>
        <Fold title={`状态变化 · ${m.history.length}`} open={open.history} onToggle={() => setOpen((o) => ({ ...o, history: !o.history }))}>
          <ol className="cw-history">
            {[...m.history].reverse().map((h, i) => (
              <li key={i}>
                <span className="muted tiny">{timeText(h.at)}</span> {partyText(h.by, cowork.agents, show)}：{h.from ? `${MATTER_STATUS_LABEL[h.from]} → ` : "开了，"}
                {MATTER_STATUS_LABEL[h.to]}
                {h.note ? `（${h.note}）` : ""}
              </li>
            ))}
          </ol>
        </Fold>
      </div>
      {dialog === "close" && <CloseDialog matter={m} onClose={() => setDialog(null)} onDone={(conclusion) => void patch({ status: "closed", ...(conclusion ? { conclusion } : {}), note: "关闭" }, conclusion ? "关了，结论记进了「已定的事」" : `${matterLabel(m)} 关了`).then((ok) => ok && setDialog(null))} />}
    </div>
  );
}

function Fold({ title, open, onToggle, children, className }: { title: string; open: boolean; onToggle: () => void; children: ReactNode; className?: string }) {
  return (
    <section className={`cw-fold-sec ${open ? "open" : ""} ${className ?? ""}`}>
      <button type="button" className="cw-fold-head" aria-expanded={open} onClick={onToggle}>
        <span aria-hidden="true">{open ? "▾" : "▸"}</span> {title}
      </button>
      {open && <div className="cw-fold-body">{children}</div>}
    </section>
  );
}

/**
 * 等你确认 (a 闸门 asked of me): its text in parts — 变化, 例子, 不确认会怎样, 来源 — then 「确认」 (a reply: back to the one
 * who asked, the 事项 goes on) or 「有问题，回一句」. A round with questions is answered one by one.
 */
function ConfirmBox({ matter: m, first, questions }: { matter: Matter; first: { body: string; via: { kind: string; conv?: string }; author: string } | null; questions: Question[] }) {
  const { session, cowork, toast, me } = useCowork();
  const show = useDisplayName();
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parts = first ? confirmParts(first.body) : null;
  const asker = first ? (first.via.kind === "ai" ? (agentOf(cowork, first.via.conv) ? partyText(`agent:${first.via.conv}`, cowork.agents, show) : `${show(first.author)} 的 AI`) : show(first.author)) : "";
  const basis = first && first.via.kind === "ai" ? basisOf(first as Parameters<typeof basisOf>[0]) : null;
  const reply = async (body: string, answers?: Answer[]) => {
    setBusy(true);
    try {
      await session.client.send(m.id, { kind: "reply", body, answers });
      // Answering it handles what was asked of me here (else it would stay in 要你看 as 「叫你来看」).
      await session.client.markCowork(cowork.id, { mark: "handled", matter: m.id }).catch(() => undefined);
      toast(`已回复，回到 ${asker || "问的人"} 手里`);
      setAsking(null);
    } catch (err) {
      toast(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const row = (k: string, v: ReactNode) => (
    <div className="cw-confirm-row">
      <span className="cw-confirm-k">{k}</span>
      <div className="cw-confirm-v">{v}</div>
    </div>
  );
  return (
    <div className="cw-confirm" role="region" aria-label="等你确认">
      <div className="cw-confirm-head">
        等你确认 · {show(me)}
        {m.gate ? ` · 闸门：${GATE_LABEL[m.gate]}` : ""}
      </div>
      {parts ? (
        <>
          {parts.rest && row("说明", parts.rest)}
          {parts.change && row("变化", parts.change)}
          {parts.example && row("例子", parts.example)}
          {parts.ifNot && row("不确认会怎样", parts.ifNot)}
          {row(
            "来源",
            <>
              {basis?.kind === "inferred" && <span className="tag cw-basis inferred">! 我的判断</span>} {parts.source ?? `${asker} 问的`}
            </>,
          )}
        </>
      ) : (
        first && <div className="cw-confirm-text">{first.body}</div>
      )}
      {questions.length > 0 ? (
        <AnswerForm questions={questions} busy={busy} onSend={(answers, body) => void reply(body, answers)} />
      ) : asking === null ? (
        <div className="cw-confirm-acts">
          <button type="button" className="primary" disabled={busy} onClick={() => void reply("确认。")}>
            确认
          </button>
          <button type="button" disabled={busy} onClick={() => setAsking("")}>
            有问题，回一句
          </button>
        </div>
      ) : (
        <div className="cw-confirm-ask">
          <textarea value={asking} onChange={(e) => setAsking(e.target.value)} rows={3} placeholder="哪里不对、要改成什么（回到问的人手里）" aria-label="有问题，回一句" autoFocus />
          <div className="cw-edit-acts">
            <button type="button" className="small" onClick={() => setAsking(null)}>
              取消
            </button>
            <button type="button" className="small primary" disabled={busy || !asking.trim()} onClick={() => void reply(asking.trim())}>
              回过去
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** 叫你来看: it waits on me (to look at a result) or something in it is to me — 「看过了」 marks those 处理了. */
function LookBox({ look }: { look: Extract<LookItem, { kind: "matter" }> }) {
  const ctx = useCowork();
  return (
    <div className={`cw-confirm look`} role="region" aria-label={LOOK_WORD[look.look]}>
      <div className="cw-confirm-head">{LOOK_WORD[look.look]}</div>
      <div className="muted tiny">{look.seqs.length ? `里面有 ${look.seqs.length} 条是给你的（#${look.seqs.join("、#")}），打开「事项里的消息」看。` : "这件事项在等你：看一眼结果，有话就在事项里说。"}</div>
      {look.seqs.length > 0 && (
        <div className="cw-confirm-acts">
          <button type="button" className="primary" onClick={() => void markMine(ctx, "handled", look.seqs, "记下了：看过了")}>
            看过了
          </button>
        </div>
      )}
    </div>
  );
}

function AnswerForm({ questions, busy, onSend }: { questions: Question[]; busy: boolean; onSend: (answers: Answer[], body: string) => void }) {
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const answers: Answer[] = questions.map((q) => ({ questionId: q.id, choice: choice[q.id] || undefined, text: texts[q.id]?.trim() || undefined })).filter((a) => a.choice || a.text);
  return (
    <div className="reply-form cw-answer">
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
        <span className="why">回答后回到问的人手里</span>
        <button type="button" className="primary" disabled={busy || !answers.length} onClick={() => onSend(answers, "")}>
          回答
        </button>
      </div>
    </div>
  );
}

/** 事项信息: what a person may change here is 卡在哪 and 结论 (the rest is the 主控's, the user 2026-11-24). */
function MatterInfo({ matter: m, onPatch, onOpen, all }: { matter: Matter; onPatch: (p: MatterPatch, done: string) => Promise<boolean>; onOpen: (id: string) => void; all: Matter[] }) {
  const { cowork, me } = useCowork();
  const show = useDisplayName();
  const [edit, setEdit] = useState<null | { key: "blocker" | "conclusion"; text: string }>(null);
  const ended = !!cowork.endedAt;
  const field = (key: "blocker" | "conclusion", label: string, value: string | null, empty: string) => (
    <div className="cw-info-row">
      <dt>{label}</dt>
      <dd>
        {edit?.key === key ? (
          <div className="cw-edit">
            <textarea value={edit.text} onChange={(e) => setEdit({ key, text: e.target.value })} rows={key === "conclusion" ? 3 : 2} aria-label={label} autoFocus />
            <div className="cw-edit-acts">
              <button type="button" className="small" onClick={() => setEdit(null)}>
                取消
              </button>
              <button type="button" className="small primary" onClick={() => void onPatch({ [key]: edit.text.trim() || null }, key === "conclusion" ? (edit.text.trim() ? "结论记下了，也进了「已定的事」" : "结论去掉了") : edit.text.trim() ? "记下了卡在哪" : "不卡了").then((ok) => ok && setEdit(null))}>
                保存
              </button>
            </div>
          </div>
        ) : (
          <>
            {value ?? <span className="muted">{empty}</span>}
            {!ended && (
              <button type="button" className="link tiny" onClick={() => setEdit({ key, text: value ?? "" })}>
                改
              </button>
            )}
          </>
        )}
      </dd>
    </div>
  );
  const agentName = (mark: string) => partyText(`agent:${mark}`, cowork.agents, show);
  return (
    <dl className="cw-minfo">
      <div className="cw-info-row">
        <dt>状态</dt>
        <dd>
          <span className={`cw-state ${MATTER_CLS[m.status]}`}>{matterChip(m.status)}</span>
        </dd>
      </div>
      <div className="cw-info-row">
        <dt>负责</dt>
        <dd>{sideText(m, cowork.agents, show)}</dd>
      </div>
      <div className="cw-info-row">
        <dt>开的人</dt>
        <dd>
          {partyText(m.owner, cowork.agents, show)} · {timeText(m.createdAt)}
        </dd>
      </div>
      <div className="cw-info-row">
        <dt>在等</dt>
        <dd>{m.waitingOn.length ? m.waitingOn.map((p: Party) => (p === personParty(me) ? "你" : partyText(p, cowork.agents, show))).join("、") : <span className="muted">没有在等谁</span>}</dd>
      </div>
      {field("blocker", "卡在哪", m.blocker, "没卡")}
      {field("conclusion", "结论", m.conclusion, "还没定")}
      {m.dependsOn.length > 0 && (
        <div className="cw-info-row">
          <dt>依赖</dt>
          <dd>
            {m.dependsOn.map((d) => {
              const x = all.find((y) => y.id === d);
              return (
                <button key={d} type="button" className="link tiny" onClick={() => onOpen(d)}>
                  {x ? `${matterLabel(x)} ${matterChip(x.status)}` : "（不见了）"}
                </button>
              );
            })}
          </dd>
        </div>
      )}
      {(m.gate || m.kind === "confirm") && (
        <div className="cw-info-row">
          <dt>闸门</dt>
          <dd>{m.gate ? GATE_LABEL[m.gate] : "要人确认"}</dd>
        </div>
      )}
      {(m.bindings.sessions.length > 0 || m.bindings.tasks.length > 0 || m.bindings.commits.length > 0) && (
        <div className="cw-info-row">
          <dt>绑定</dt>
          <dd className="cw-binds">
            {m.bindings.sessions.map((s) => (
              <span key={s} className="tag">
                执行 {agentName(s)}
              </span>
            ))}
            {m.bindings.tasks.map((t) => (
              <span key={t} className="tag">
                任务 {t}
              </span>
            ))}
            {m.bindings.commits.map((c) => (
              <code key={c} className="branch">
                {c.slice(0, 7)}
              </code>
            ))}
          </dd>
        </div>
      )}
    </dl>
  );
}

function CloseDialog({ matter: m, onClose, onDone }: { matter: Matter; onClose: () => void; onDone: (conclusion: string) => void }) {
  const [text, setText] = useState(m.conclusion ?? "");
  return (
    <Dialog
      title={`关闭${matterLabel(m)}`}
      sub={m.title}
      onClose={onClose}
      foot={
        <>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" onClick={() => onDone(text.trim())}>
            关闭
          </button>
        </>
      }
    >
      <p className="muted tiny">关了以后里面的消息都算处理了。写了结论就记进协作的「已定的事」，所有人和 AI 都看得到；也可以不写。</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="定了什么，比如：回落 1.2 秒线性，回落期间不能开火" aria-label="结论" autoFocus />
    </Dialog>
  );
}

/**
 * 开事项 (2026-11-25): a piece of work (负责方, 在等谁) — or 「请人确认」, a question to one person in the 协作 (the 子会话 it
 * was before: it waits on them, 等人确认, and they answer it).
 */
export function NewMatterDialog({ onClose, onMade }: { onClose: () => void; onMade: (id: string) => void }) {
  const { session, cowork, me, toast } = useCowork();
  const listed = useListed(me);
  const show = useDisplayName();
  const people = cowork.members.filter((n) => n === me || listed(n));
  const others = people.filter((n) => n !== me);
  const [mode, setMode] = useState<"work" | "ask">("work");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [side, setSide] = useState(me);
  const [waiting, setWaiting] = useState("");
  const [to, setTo] = useState(others[0] ?? "");
  const [qs, setQs] = useState<Array<{ text: string; options: string }>>([]);
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      if (mode === "ask") {
        const questions = qs.filter((q) => q.text.trim()).map((q) => ({ text: q.text.trim(), options: q.options.trim() ? q.options.split(/[,，、/]/).map((o) => o.trim()).filter(Boolean) : undefined }));
        const r = await session.client.askCowork(cowork.id, { to, title: title.trim(), body: body.trim(), questions: questions.length ? questions : undefined });
        if (r.thread) {
          toast(`开了事项，等 ${show(to)} 确认`);
          onMade(r.thread.id);
        } else onClose();
      } else {
        const kind: MatterKind = "work";
        const r = await session.client.openMatter(cowork.id, { title: title.trim(), body: body.trim() || title.trim(), kind, side, ...(waiting ? { waitingOn: [waiting as Party] } : {}) });
        session.putMatter(cowork.id, r.matter);
        toast(`开了${matterLabel(r.matter)}`);
        onMade(r.matter.id);
      }
    } catch (err) {
      toast(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="开一件事项"
      sub="具体的事在事项里谈：群聊里折叠成一张卡，板上按负责方排好"
      onClose={onClose}
      wide
      foot={
        <>
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy || !title.trim() || (mode === "ask" && !to)} onClick={() => void make()}>
            开
          </button>
        </>
      }
    >
      <div className="bd-refkinds" role="radiogroup" aria-label="哪种事项">
        <button type="button" role="radio" aria-checked={mode === "work"} className={`small ${mode === "work" ? "primary" : ""}`} onClick={() => setMode("work")}>
          要做的事
        </button>
        <button type="button" role="radio" aria-checked={mode === "ask"} className={`small ${mode === "ask" ? "primary" : ""}`} onClick={() => setMode("ask")} disabled={!others.length}>
          请人确认
        </button>
      </div>
      <Field label="标题">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={mode === "ask" ? "比如：过热后射速怎么回落？" : "比如：数值表加字段、导表"} autoFocus />
      </Field>
      <Field label="说明">
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder={mode === "ask" ? "变化：从什么改成什么\n例子：一两个具体的\n不确认会怎样：" : "要做成什么样、做到哪算完（支持 Markdown）"} />
      </Field>
      {mode === "work" ? (
        <div className="cw-two">
          <Field label="负责方" hint="哪一方的主控推进它">
            <select value={side} onChange={(e) => setSide(e.target.value)} aria-label="负责方">
              {people.map((n) => (
                <option key={n} value={n}>
                  {show(n)}
                  {n === me ? "（我这一方）" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="在等谁（可以空着）">
            <select value={waiting} onChange={(e) => setWaiting(e.target.value)} aria-label="在等谁">
              <option value="">没有在等谁</option>
              {others.map((n) => (
                <option key={n} value={personParty(n)}>
                  {show(n)}
                </option>
              ))}
              {cowork.agents
                .filter((a) => a.role !== "worker")
                .map((a) => (
                  <option key={a.mark} value={`agent:${a.mark}`}>
                    {a.role === "lead" ? `${show(a.owner)}的主控` : a.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
      ) : (
        <>
          <Field label="请谁确认">
            <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="请谁确认">
              {others.map((n) => (
                <option key={n} value={n}>
                  {show(n)}
                </option>
              ))}
            </select>
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
        </>
      )}
    </Dialog>
  );
}

export type { GateKind };
