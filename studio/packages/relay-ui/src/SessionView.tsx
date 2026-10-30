import { useEffect, useMemo, useState } from "react";
import { FileChip, FileViewer, PickFiles, useThreadFiles, useUpload } from "./Files.js";
import { sessionStatus, waitedText } from "./bits.js";
import { copyText } from "./env.js";
import { Composer, MessageList, errorText, useMessages } from "./Messages.js";
import { useSession, type Session } from "./session.js";
import { newRepliesText, sinceLastWord, threadAsText, VERDICT_LABEL, type Answer, type FileNote, type Question, type RelayFile, type SessionAction, type ThreadView, type Verdict } from "./shared.js";
import { writeUsageFile } from "./usageFile.js";

// A session (stage 2a): someone — often their AI — asks a person to handle one thing. It is always in someone's hands:
// the person asked answers it one question at a time and returns it (回复并返回); back with the asker, their AI takes it
// up by itself, or the asker does (我来处理), and asks again (继续追问) or closes it (标记完成). A session that needs a
// reply — every one from an AI — cannot be closed by the person asked.

export function SessionView(props: {
  session: Session;
  thread: ThreadView;
  toast: (text: string) => void;
  /** Shown inside its task's page: no crumb. */
  embedded?: boolean;
  /** 接手任务… for a session under a task. */
  onTakeover?: (thread: ThreadView) => void;
  onOpenTask?: (taskId: string) => void;
}) {
  const { session, thread, toast } = props;
  const { settings, tasks } = useSession(session);
  const me = session.me.name;
  const r = thread.request!;
  const { messages, error } = useMessages(session, thread.id);
  const [againOpen, setAgainOpen] = useState(false);
  const status = sessionStatus(thread, me, Date.now(), settings);
  const task = r.taskId ? tasks.find((t) => t.id === r.taskId) : undefined;
  const takeover = r.taskId && props.onTakeover && r.to === me && r.state !== "done" ? () => props.onTakeover!(thread) : undefined;
  const questions = messages?.find((m) => m.kind === "request")?.questions ?? [];
  // The open round (the request's, or a follow-up's); none after a plain follow-up, which is answered in words.
  const askQuestions = r.askSeq == null ? null : (messages?.find((m) => m.seq === r.askSeq)?.questions ?? []);
  const lastQuestions = [...(messages ?? [])].reverse().find((m) => m.kind !== "reply" && m.questions?.length)?.questions ?? questions;
  const asker = `${r.from}${r.byAi ? " 的 AI" : ""}`;
  const myTurn = r.waitingOn === me && r.state !== "done";
  const files = useThreadFiles(session, thread.id, thread.updatedAt);
  const [viewing, setViewing] = useState<string | null>(null);
  const { upload, busy: uploading } = useUpload(session, { threadId: thread.id }, toast);

  const act = async (action: SessionAction, done: string) => {
    try {
      await session.client.session(thread.id, action);
      toast(done);
    } catch (err) {
      toast(errorText(err));
    }
  };
  const copyAll = async () => {
    if (!messages) return;
    // Back with me: my AI ended its turn after asking, so the reply goes over by hand, with what to do next.
    if (r.from === me && r.state === "returned") {
      const usage = await writeUsageFile(session);
      await copyText(`${r.to} 回复了你发的会话（threadId ${thread.id}），内容在下面。按回复接着推进：还没问清楚，就在这个会话里追问；已经敲定，就把会话标记完成，再按敲定的方案改文档、继续开发。${usage ? `命令见 ${usage.file}。` : ""}\n\n${threadAsText(thread, messages)}`);
      toast("已复制回复，贴给你的 AI（原来的对话或新对话都行）");
      return;
    }
    await copyText(threadAsText(thread, messages));
    toast("已复制整个会话（含逐条回答），可以贴给 AI");
  };
  // 复制新回复 (2026-10-30, the user): pasted back into the conversation that asked, the AI has seen the earlier rounds —
  // only what came after my last word (mine or my AI's), with the questions it answers.
  const sinceMine = useMemo(() => (messages ? sinceLastWord(messages, me) : null), [messages, me]);
  const copyNew = async () => {
    if (!sinceMine) return;
    const usage = await writeUsageFile(session);
    await copyText(newRepliesText(thread, sinceMine, `用 relay_session_get 或命令行 relay replies ${thread.id}${usage ? `，命令见 ${usage.file}` : ""}`));
    toast("已复制新回复，贴回原来的对话");
  };
  const copyPickup = async () => {
    await copyText(`用 AMO 中转取会话 ${thread.id} 的回复（命令行 relay replies ${thread.id}，或 MCP 的 relay_session_get），按回复接着推进：没问清楚就追问（send --then ask / relay_session_reply then="ask"），已经敲定就标记完成（--then done / then="done"）。`);
    toast("已复制取回指令，贴给任何 agent 都行");
  };

  let dock;
  if (myTurn && r.to === me && r.state === "open" && askQuestions === null) {
    // A follow-up in words: answered in words, like a chat.
    dock = (
      <Composer
        session={session}
        threadId={thread.id}
        pass
        sendLabel={`回复并返回给 ${asker}`}
        placeholder={`回答 ${asker} 的追问…（发出后会话回到对方手里）`}
        hint={r.needsReply ? "直接用话回答就行" : "直接用话回答；不用回的话也可以标记完成"}
        onSent={() => toast(`已返回给 ${asker}`)}
        extra={
          <>
            {takeover && (
              <button type="button" onClick={takeover}>
                接手任务…
              </button>
            )}
            {!r.needsReply && (
              <button type="button" onClick={() => void act("done", "会话已完成")}>
                标记完成
              </button>
            )}
          </>
        }
      />
    );
  } else if (myTurn && r.to === me && r.state === "open") {
    dock = <ReplyForm session={session} thread={thread} questions={askQuestions ?? []} files={files} onOpenFile={setViewing} onDone={() => toast(`已返回给 ${asker}`)} onMarkDone={() => void act("done", "会话已完成")} onTakeover={takeover} />;
  } else if (r.to === me && againOpen) {
    dock = <ReplyForm session={session} thread={thread} questions={lastQuestions} files={files} onOpenFile={setViewing} again onDone={() => (setAgainOpen(false), toast(`已再次返回给 ${asker}`))} onCancel={() => setAgainOpen(false)} />;
  } else if (myTurn && r.state === "returned" && r.handler === "person") {
    dock = <FollowUp session={session} thread={thread} onDone={() => void act("done", "会话已完成")} toast={toast} />;
  } else if (myTurn && r.state === "returned") {
    dock = (
      <div className="dock">
        <div className="acts">
          <span className="why">这个会话由你的 AI 接着处理；要自己处理，点上面的「我来处理」</span>
        </div>
      </div>
    );
  } else if (r.state !== "done") {
    dock = (
      <Composer
        session={session}
        threadId={thread.id}
        placeholder={`补充内容给 ${r.waitingOn === r.to ? r.to : r.from}…（会话仍在对方手里）`}
        hint={status.text}
        sendLabel="补充"
        extra={
          <>
            {r.to === me && r.status === "answered" && (
              <button type="button" onClick={() => setAgainOpen(true)}>
                再回复一次
              </button>
            )}
            {r.from === me && (
              <button type="button" onClick={() => void act("done", "会话已撤回并完成")} title="不用对方再处理了">
                撤回并标记完成
              </button>
            )}
          </>
        }
      />
    );
  } else {
    dock = (
      <div className="dock">
        <div className="acts">
          <span className="why">已完成</span>
          <button type="button" onClick={() => void act("reopen", `已重新打开，会话回到 ${r.to} 手里`)}>
            重新打开
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className="view" aria-label={thread.title}>
      <header className="page-head">
        <div className="head-main">
          {!props.embedded && (
            <div className="page-crumb">
              待处理
              {!props.onOpenTask ? null : task ? (
                <>
                  {" / "}
                  <button type="button" className="link" onClick={() => props.onOpenTask?.(task.id)}>
                    任务 · {task.title}
                  </button>
                </>
              ) : (
                " / 单独会话"
              )}
            </div>
          )}
          <h1 className="head-title">{thread.title}</h1>
          <div className="head-meta">
            <span>
              {asker} → {r.to}
            </span>
            <span className={`chip ${status.warn ? "attn" : ""}`}>{status.text}</span>
            {r.verdict && <span className={`chip v-${r.verdict}`}>{VERDICT_LABEL[r.verdict]}</span>}
            {r.needsReply && <span className="chip">需要回复</span>}
          </div>
        </div>
        <div className="head-actions">
          <button type="button" onClick={() => void copyAll()} title="复制整个会话（含逐条回答），贴给 AI">
            复制给 AI
          </button>
        </div>
      </header>
      <AiBand thread={thread} me={me} limits={settings} onPickup={() => void copyPickup()} onCopy={() => void copyAll()} onCopyNew={sinceMine ? () => void copyNew() : undefined} onAct={(a, t) => void act(a, t)} />
      {(files.length > 0 || r.state !== "done") && (
        <div className="atts">
          <span className="muted tiny">附件</span>
          {files.map((f) => (
            <FileChip key={f.id} file={f} onOpen={setViewing} />
          ))}
          {!files.length && <span className="muted tiny">没有</span>}
          {r.state !== "done" && <PickFiles small label={uploading ? "上传中…" : "＋ 附加文件"} disabled={uploading} onFiles={(fl) => void upload(fl)} />}
        </div>
      )}
      {viewing && <FileViewer session={session} fileId={viewing} onClose={() => setViewing(null)} toast={toast} />}
      <MessageList messages={messages} error={error} me={me} questions={questions} empty="还没有消息" />
      {dock}
    </section>
  );
}

const agoText = (ms: number) => (ms < 60_000 ? "刚刚" : `${waitedText(ms)}前`);

/** Back with me and handled by my AI: copy it over to it, has it taken it, is it stuck — and ways to take it myself. */
function AiBand({ thread, me, limits, onPickup, onCopy, onCopyNew, onAct }: { thread: ThreadView; me: string; limits: { aiLateMinutes: number; aiStuckMinutes: number }; onPickup: () => void; onCopy: () => void; onCopyNew: (() => void) | undefined; onAct: (a: SessionAction, toast: string) => void }) {
  const r = thread.request!;
  if (r.from !== me || r.state !== "returned" || r.waitingOn !== me) return null;
  if (r.handler === "person") {
    if (!r.byAi) return null;
    return (
      <div className="aiband">
        你已从 AI 手里接手，这个会话之后由你处理；AI 再碰它时会被告知。
        <span className="grow" />
        <button type="button" className="small" onClick={() => onAct("toAi", "已交还给 AI")}>
          交还给 AI
        </button>
      </div>
    );
  }
  const now = Date.now();
  const tools = (
    <>
      {onCopyNew && (
        <button type="button" className="small primary" onClick={onCopyNew} title="只复制你上次发言之后的回复和接下来怎么做，贴回原来的对话">
          复制新回复
        </button>
      )}
      <button type="button" className={onCopyNew ? "small" : "small primary"} onClick={onCopy} title="复制整个会话和接下来怎么做，贴给新对话">
        复制整个会话
      </button>
      <button type="button" className="small" onClick={onPickup} title="一行提示词，贴给 agent，它自己去取这条回复并继续">
        复制取回指令
      </button>
      <button type="button" className="small" onClick={() => onAct("handle", "你接手了：可以继续追问或标记完成")}>
        我来处理
      </button>
    </>
  );
  if (r.pickedAt && now - r.pickedAt <= limits.aiStuckMinutes * 60_000) {
    return (
      <div className="aiband">
        ✓ 你的 AI 已取回回复（{waitedText(now - r.pickedAt)}前），正在处理，之后会继续追问或标记完成。
        <span className="grow" />
        <button type="button" className="small" onClick={() => onAct("handle", "你接手了：可以继续追问或标记完成")}>
          我来处理
        </button>
      </div>
    );
  }
  if (r.pickedAt) {
    return (
      <div className="aiband warn">
        ! 你的 AI 取回回复后 {waitedText(now - r.pickedAt)}没有动作，可能卡住了（对话结束了，或者在等你）。
        <span className="grow" />
        {tools}
      </div>
    );
  }
  return (
    <div className="aiband warn">
      ! {r.to} 回复了（{agoText(now - (r.returnedAt ?? now))}）。贴回原来的对话用「复制新回复」，开新对话用「复制整个会话」，你的 AI 会接着推进。
      <span className="grow" />
      {tools}
    </div>
  );
}

function ReplyForm(props: {
  session: Session;
  thread: ThreadView;
  questions: Question[];
  files: RelayFile[];
  onOpenFile: (id: string) => void;
  again?: boolean;
  onDone: () => void;
  onMarkDone?: () => void;
  onCancel?: () => void;
  onTakeover?: () => void;
}) {
  const { session, thread, questions } = props;
  const me = session.me.name;
  // My notes on this session's files: sent along with the reply unless unticked.
  const [myNotes, setMyNotes] = useState<FileNote[]>([]);
  const [attach, setAttach] = useState(true);
  const notesKey = props.files.map((f) => `${f.id}:${f.notes}`).join(",");
  useEffect(() => {
    let alive = true;
    void Promise.all(props.files.map((f) => session.client.notes(f.id).catch(() => [] as FileNote[]))).then((all) => {
      if (!alive) return;
      const seen = new Set<string>();
      setMyNotes(all.flat().filter((n) => n.author === me && !seen.has(n.id) && seen.add(n.id)));
    });
    return () => {
      alive = false;
    };
  }, [session, notesKey, me]); // eslint-disable-line react-hooks/exhaustive-deps
  const r = thread.request!;
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answers = useMemo<Answer[]>(
    () =>
      questions
        .map((q) => ({ questionId: q.id, choice: choice[q.id] || undefined, text: texts[q.id]?.trim() || undefined }))
        .filter((a) => a.choice || a.text),
    [questions, choice, texts],
  );
  const sendNotes = attach ? myNotes.map((n) => n.id) : [];
  const empty = !answers.length && !note.trim() && !verdict && !sendNotes.length;

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await session.client.send(thread.id, { kind: "reply", answers, body: note.trim(), verdict: verdict ?? undefined, notes: sendNotes.length ? sendNotes : undefined });
      props.onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dock reply-form">
      <div className="dock-head">
        <b>{props.again ? "再回复一次" : "处理这个会话"}</b>
        <span className="muted tiny">逐条回答（不需要的可以空着）→ 写说明 → 选结论</span>
      </div>
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
            <input value={texts[q.id] ?? ""} onChange={(e) => setTexts((t) => ({ ...t, [q.id]: e.target.value }))} placeholder={q.options ? "补充说明，或写自己的答案" : "你的回答"} />
          </div>
        </div>
      ))}
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="补充说明（支持 Markdown）" rows={2} />
      <div className="dock-foot">
        <div className="verdicts">
          {(Object.keys(VERDICT_LABEL) as Verdict[]).map((v) => (
            <button key={v} type="button" className={`small vbtn v-${v} ${verdict === v ? "on" : ""}`} onClick={() => setVerdict(verdict === v ? null : v)}>
              {VERDICT_LABEL[v]}
            </button>
          ))}
        </div>
        {props.files.length > 0 && (
          <>
            <label className="check tiny">
              <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
              附上我的批注（{myNotes.length}）
            </label>
            <button type="button" className="link tiny" onClick={() => props.onOpenFile(props.files[0]!.id)}>
              打开附件批注
            </button>
          </>
        )}
        {error && <span className="error tiny">{error}</span>}
      </div>
      <div className="acts">
        <span className="why">{r.needsReply ? `${r.byAi ? "AI 发来的会话一定要回复" : "发起人要求回复"}；完成由发起方标记` : "不需要回复的话，也可以直接标记完成"}</span>
        {props.onCancel && (
          <button type="button" onClick={props.onCancel}>
            取消
          </button>
        )}
        {props.onTakeover && (
          <button type="button" onClick={props.onTakeover} title="把任务流转到你手里，弹窗里写状态和原因">
            接手任务…
          </button>
        )}
        {!r.needsReply && props.onMarkDone && (
          <button type="button" onClick={props.onMarkDone}>
            标记完成
          </button>
        )}
        <button type="button" className="primary" disabled={busy || empty} onClick={() => void send()}>
          回复并返回给 {r.from}
          {r.byAi ? " 的 AI" : ""}
        </button>
      </div>
    </div>
  );
}

/** The asker's turn: ask again in words (answered in words), or add a new round of questions to answer one by one. */
function FollowUp({ session, thread, onDone, toast }: { session: Session; thread: ThreadView; onDone: () => void; toast: (t: string) => void }) {
  const r = thread.request!;
  const [text, setText] = useState("");
  const [qs, setQs] = useState<Array<{ text: string; options: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const round = qs
    .filter((q) => q.text.trim())
    .map((q) => {
      const options = q.options
        .split(/[,，/、]/)
        .map((o) => o.trim())
        .filter(Boolean);
      return options.length ? { text: q.text.trim(), options } : { text: q.text.trim() };
    });
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await session.client.send(thread.id, { kind: "text", body: text.trim(), pass: true, questions: round.length ? round : undefined });
      setText("");
      setQs([]);
      toast(round.length ? `已追问 ${round.length} 个问题，会话回到 ${r.to} 手里` : `已追问，会话回到 ${r.to} 手里`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dock followup">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.preventDefault(), void send())}
        placeholder={`继续追问 ${r.to}…（发出后会话回到对方手里）`}
        rows={2}
      />
      {qs.length > 0 && (
        <div className="qs">
          {qs.map((q, i) => (
            <div key={i} className="q-row">
              <span className="rq-n">{i + 1}</span>
              <input value={q.text} onChange={(e) => setQs((l) => l.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} placeholder="问题" autoFocus={i === qs.length - 1} />
              <input className="opts" value={q.options} onChange={(e) => setQs((l) => l.map((x, j) => (j === i ? { ...x, options: e.target.value } : x)))} placeholder="选项，用逗号隔开（可不填）" />
              <button type="button" className="x" title="去掉这个问题" onClick={() => setQs((l) => l.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="acts">
        <span className="why">
          {error ? <span className="error">{error}</span> : round.length ? `对方会看到这 ${round.length} 个新问题，逐条回答` : "直接用话追问，对方用话回答；也可以加几个逐条回答的问题"}
        </span>
        <button type="button" className="link" onClick={() => setQs((l) => [...l, { text: "", options: "" }])}>
          ＋ 加逐条回答的问题
        </button>
        <button type="button" onClick={onDone}>
          标记完成
        </button>
        <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => void send()}>
          继续追问
        </button>
      </div>
    </div>
  );
}
