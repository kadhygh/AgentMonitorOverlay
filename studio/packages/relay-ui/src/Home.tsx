import { useCallback, useEffect, useMemo, useState } from "react";
import { copyText, shell } from "./env.js";
import { UpdateBanner } from "./Login.js";
import { useMinuteTick, useSession, type Session } from "./session.js";
import { RelayClientError, usagePrompt, type McpHookup, type ShellInfo, type ThreadView as Thread } from "./shared.js";
import { Avatar, RequestStatus, preview, timeText } from "./bits.js";
import { ThreadView } from "./ThreadView.js";

// After login: the conversations on the left (requests waiting for me first, then the ones I sent, answered ones,
// direct chats, and the people), the open one on the right. The tools for AIs are in the header: 复制用法 (a prompt for
// any agent) and 接入 AI (the MCP hookup for this machine).

const errorText = (err: unknown) => (err instanceof RelayClientError || err instanceof Error ? err.message : String(err));
const UPDATE_CHECK_MS = 10 * 60_000;

export function Home({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const { threads, members, connection } = useSession(session);
  const me = session.me.name;
  useMinuteTick();
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"request" | "ai" | null>(null);
  const [toastText, setToastText] = useState<string | null>(null);
  const [info, setInfo] = useState<ShellInfo | null>(null);

  const toast = useCallback((text: string) => {
    setToastText(text);
    setTimeout(() => setToastText((t) => (t === text ? null : t)), 2200);
  }, []);

  const groups = useMemo(() => {
    const todo = threads.filter((t) => t.request?.to === me && t.request.status === "open");
    const sent = threads.filter((t) => t.request?.from === me);
    const done = threads.filter((t) => t.request?.to === me && t.request.status === "answered");
    const direct = threads.filter((t) => t.kind === "direct");
    return { todo, sent, done, direct };
  }, [threads, me]);
  const open = threads.find((t) => t.id === openId) ?? null;
  const unread = threads.reduce((n, t) => n + t.unread, 0);

  // Open the first thing waiting for me.
  useEffect(() => {
    if (!openId && threads.length) setOpenId((groups.todo[0] ?? threads[0])!.id);
  }, [threads.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => shell?.setUnread(unread), [unread]);

  // Notifications when the window is not looking at it.
  useEffect(
    () =>
      session.onMessage((m) => {
        if (m.author === me || (document.hasFocus() && session.openThread === m.threadId)) return;
        const t = session.snapshot.threads.find((x) => x.id === m.threadId);
        const title = m.kind === "request" ? `${m.author} 发来请求` : m.kind === "reply" ? `${m.author} 回复了` : m.author;
        shell?.notify({ title, body: m.kind === "request" ? (t?.title ?? preview(m)) : preview(m).slice(0, 120), threadId: m.threadId });
      }),
    [session, me],
  );
  useEffect(() => shell?.onOpenThread((id) => setOpenId(id)), []);

  // A newer client while running: offered at the top of the list.
  useEffect(() => {
    if (!shell) return;
    const check = () =>
      void shell!.checkUpdate().then(async (update) => {
        if (update) setInfo({ ...(await shell!.info()), update });
      });
    check();
    const t = setInterval(check, UPDATE_CHECK_MS);
    return () => clearInterval(t);
  }, []);

  const chatWith = async (name: string) => {
    const existing = groups.direct.find((t) => t.members.includes(name));
    if (existing) return setOpenId(existing.id);
    try {
      const t = await session.client.direct(name);
      session.adopt({ ...t, unread: 0, readSeq: 0, last: null });
      setOpenId(t.id);
    } catch (err) {
      toast(errorText(err));
    }
  };

  const copyUsage = async () => {
    const hookup = shell ? await shell.mcp().catch(() => null) : null;
    await copyText(usagePrompt({ me, role: session.me.role, members, cli: hookup?.cli }));
    toast("用法已复制，贴给 agent 就行");
  };

  const others = members.filter((m) => m.name !== me);

  return (
    <div className="home">
      <aside className="side">
        <div className="side-head">
          <Avatar name={me} />
          <div className="who">
            <b>{me}</b>
            <span className="muted tiny">{session.me.role || session.me.service}</span>
          </div>
          <span className={`conn ${connection}`} title={connection === "online" ? "已连接" : connection === "offline" ? "连接断开，正在重连" : "正在连接"} />
          <button type="button" className="link tiny" onClick={onLogout}>
            退出
          </button>
        </div>
        {info?.update && (
          <div className="side-update">
            <UpdateBanner info={info} compact />
          </div>
        )}
        <div className="side-actions">
          <button type="button" className="primary" onClick={() => setDialog("request")}>
            ＋ 新请求
          </button>
          <button type="button" onClick={() => void copyUsage()} title="复制一段说明，贴给任何 agent，它就知道怎么用中转找人确认">
            复制用法
          </button>
          <button type="button" onClick={() => setDialog("ai")} title="让本机的 AI 客户端（Claude Code、Codex…）直接用中转">
            接入 AI
          </button>
        </div>
        <nav className="lists">
          <Group title="待我回答" threads={groups.todo} me={me} openId={openId} onOpen={setOpenId} highlight />
          <Group title="我发出的" threads={groups.sent} me={me} openId={openId} onOpen={setOpenId} />
          <Group title="已回答" threads={groups.done} me={me} openId={openId} onOpen={setOpenId} collapsed />
          <Group title="私聊" threads={groups.direct} me={me} openId={openId} onOpen={setOpenId} />
          <div className="group">
            <div className="group-title">成员 · {others.filter((m) => m.online).length}/{others.length} 在线</div>
            {others.map((m) => (
              <button key={m.name} type="button" className="person" onClick={() => void chatWith(m.name)} title={`和 ${m.name} 私聊`}>
                <Avatar name={m.name} small />
                <span className="person-name">{m.name}</span>
                <span className="muted tiny ellipsis">{m.role}</span>
                <span className={`dot ${m.online ? "on" : ""}`} />
              </button>
            ))}
            {!others.length && <div className="muted tiny pad">还没有其他人。把服务器的地址发给同事，让他们注册。</div>}
          </div>
        </nav>
      </aside>
      <main className="main">
        {open ? (
          <ThreadView key={open.id} session={session} thread={open} toast={toast} />
        ) : (
          <div className="empty">
            <h2>还没有对话</h2>
            <p className="muted">
              点左边的同事开始私聊，或者「＋ 新请求」发一个要对方确认的问题。
              <br />
              想让 AI 自己去问人：点「复制用法」把说明贴给 agent，或者「接入 AI」。
            </p>
          </div>
        )}
      </main>
      {dialog === "request" && (
        <NewRequestDialog
          session={session}
          people={others.map((m) => m.name)}
          onClose={() => setDialog(null)}
          onSent={(id) => (setDialog(null), setOpenId(id), toast("请求已发出"))}
        />
      )}
      {dialog === "ai" && <ConnectAiDialog onClose={() => setDialog(null)} onCopyUsage={() => void copyUsage()} toast={toast} />}
      {toastText && <div className="toast">{toastText}</div>}
    </div>
  );
}

function Group(props: { title: string; threads: Thread[]; me: string; openId: string | null; onOpen: (id: string) => void; highlight?: boolean; collapsed?: boolean }) {
  const [folded, setFolded] = useState(!!props.collapsed);
  if (!props.threads.length) return null;
  const unread = props.threads.reduce((n, t) => n + t.unread, 0);
  return (
    <div className={`group ${props.highlight ? "hl" : ""}`}>
      <button type="button" className="group-title" onClick={() => setFolded(!folded)}>
        {folded ? "▸" : "▾"} {props.title} · {props.threads.length}
        {folded && unread > 0 && <span className="badge">{unread}</span>}
      </button>
      {!folded &&
        props.threads.map((t) => {
          const other = t.members.find((n) => n !== props.me) ?? props.me;
          return (
            <button key={t.id} type="button" className={`item ${t.id === props.openId ? "on" : ""} ${t.unread ? "unread" : ""}`} onClick={() => props.onOpen(t.id)}>
              <div className="item-top">
                <span className="item-title ellipsis">{t.kind === "direct" ? other : t.title}</span>
                <span className="muted tiny">{timeText(t.updatedAt)}</span>
              </div>
              <div className="item-bottom">
                {t.request && (
                  <>
                    <RequestStatus thread={t} me={props.me} />
                    <span className="muted tiny">{t.request.from === props.me ? `→ ${t.request.to}` : `${t.request.from} →`}</span>
                  </>
                )}
                <span className="muted tiny ellipsis grow">{preview(t.last)}</span>
                {t.unread > 0 && <span className="badge">{t.unread}</span>}
              </div>
            </button>
          );
        })}
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

function NewRequestDialog(props: { session: Session; people: string[]; onClose: () => void; onSent: (threadId: string) => void }) {
  const [to, setTo] = useState(props.people[0] ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
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
      const { thread } = await props.session.client.ask({ to, title: title.trim(), body: body.trim(), questions: qs });
      props.onSent(thread.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="新请求" onClose={props.onClose} wide>
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
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话说清要确认什么" autoFocus />
        </label>
        <label>
          正文 <span className="muted tiny">（Markdown；对方看不到你本机的文件，关键内容贴进来）</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7} />
        </label>
        <div className="qs">
          <div className="muted small">要对方逐条回答的问题</div>
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
          <button type="button" className="link" onClick={() => setQuestions((list) => [...list, { text: "", options: "" }])}>
            ＋ 再加一个问题
          </button>
        </div>
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
        <p className="muted">现在也可以点「复制用法」把说明贴给 agent，再把它写好的请求内容手动用「＋ 新请求」发出去。</p>
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
      <p className="muted small">
        接好后，本机的 AI 用你现在登录的身份收发请求：能看到团队成员、给人发请求、取回复。换账号登录后，它跟着换。MCP 由这个客户端自带的运行时启动，本机不用装 Node。
      </p>
      {block("Claude Code", claude, "在终端里运行一次")}
      {block("Codex", toml, "加到 ~/.codex/config.toml")}
      {block("其他客户端", json, "支持 mcpServers JSON 的都可以")}
      <p className="muted small">
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
