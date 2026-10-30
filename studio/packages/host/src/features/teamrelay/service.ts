import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { RELAY_TEXT_MAX, TEAM_SEND_FILES_MAX, type Id, type TeamSend, type TeamThread } from "@amo-studio/protocol";
import { RelayClient, RelayClientError, newRepliesText, takeSession, threadAsText, type Thread, type Via } from "@amo-studio/relay/light";
import { newId } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

// 会话里用中转 (2026-10-30, plans/relay-in-sessions.md): a session asks someone on the team to confirm something through
// AMO 中转, as the person (the platform's login), marked as their AI's. Every send waits for the person first — in auto
// mode too, since it goes to a real person — like a 主控's 传话; unless the person turned that off (设置 → 功能 → 中转,
// 2026-10-30), then it goes at once. Each message carries the session's mark (Via.conv,
// `studio:<device>:<session>`): when the session comes back, this computer takes the new part and sends it into that
// session (queued while it works), so the conversation goes on by itself.

const SENDS_KEY = "teamrelay.sends";
const THREADS_KEY = "teamrelay.threads";
/** How long a decided send stays listed. */
const DECIDED_SHOWN_MS = 24 * 3600_000;
const FILE_MAX = 20 * 1024 * 1024;
const VIA_CLIENT = "AMO Studio";
export const TEAM_NOT_SIGNED_IN = "要先在 AMO 平台里登录团队服务器，才能用中转找人。";

type Questions = TeamSend["questions"];

export class TeamRelayFeature extends Feature {
  private running = false;
  private abort: AbortController | null = null;
  private scanning: Promise<void> | null = null;
  /** The newest 中转 message seen: the long wait wakes on anything after it. */
  private lastSeq = 0;
  /** Tests: shorter pauses. */
  pauseMs = { signedOut: 10_000, failed: 30_000, wait: 25_000 };

  // ---- who and where

  /** The 中转 client as the person, and this computer's mark prefix. */
  private relay(): { client: RelayClient; me: string; prefix: string } {
    const login = this.f.remote.teamLogin();
    if (!login) throw new HostError("bad_request", TEAM_NOT_SIGNED_IN);
    return { client: new RelayClient(login.account.server, login.account.key), me: login.account.name, prefix: `studio:${login.deviceId}:` };
  }

  private via(prefix: string, sessionId: Id): Via {
    return { kind: "ai", client: VIA_CLIENT, conv: `${prefix}${sessionId}` };
  }

  /** A 中转 call; its refusals and an unreachable server become errors the agent and the person can read. */
  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof HostError) throw err;
      if (err instanceof RelayClientError) throw new HostError("bad_request", err.message);
      throw new HostError("runtime_error", `连不上团队服务器：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- what sessions ask to send

  sends(): TeamSend[] {
    const since = Date.now() - DECIDED_SHOWN_MS;
    return this.allSends().filter((s) => s.state === "pending" || Date.parse(s.decidedAt ?? s.createdAt) > since);
  }

  private allSends(): TeamSend[] {
    try {
      return JSON.parse(this.store.getKv(SENDS_KEY)?.value ?? "[]") as TeamSend[];
    } catch {
      return [];
    }
  }

  private requireSend(id: Id): TeamSend {
    const send = this.allSends().find((s) => s.id === id);
    if (!send) throw new HostError("not_found", `send ${id} not found`);
    return send;
  }

  private saveSend(send: TeamSend): TeamSend {
    const rest = this.allSends().filter((s) => s.id !== send.id);
    this.store.setKv(SENDS_KEY, JSON.stringify([...rest, send].slice(-200)));
    this.publish({ type: "teamsend.upserted", send });
    return send;
  }

  /** team_ask: a new 中转 session for someone to confirm; waits for the person. */
  async requestAsk(sessionId: Id, input: { to?: unknown; title?: unknown; body?: unknown; questions?: unknown; files?: unknown }): Promise<TeamSend> {
    const { client, me } = this.relay();
    const to = text(input.to, "to");
    const title = text(input.title, "title").slice(0, 200);
    const body = text(input.body, "body");
    if (body.length > RELAY_TEXT_MAX) throw new HostError("bad_request", `body is limited to ${RELAY_TEXT_MAX} characters`);
    if (to === me) throw new HostError("bad_request", `你用的就是 ${me} 的身份：要问 ${me} 本人，直接在对话里问。`);
    const members = await this.call(() => client.members());
    if (!members.some((m) => m.name === to)) throw new HostError("bad_request", `团队里没有「${to}」。能找的人：${members.filter((m) => m.name !== me).map((m) => m.name).join("、") || "（还没有别人）"}`);
    const files = localFiles(input.files);
    return this.asked(this.saveSend({ id: newId("tsend"), sessionId, kind: "ask", to, title, threadId: null, body, questions: questions(input.questions), files, state: "pending", createdAt: new Date().toISOString(), decidedAt: null }));
  }

  /** team_followup: asks again in a 中转 session this session sent; waits for the person. */
  async requestFollowup(sessionId: Id, input: { threadId?: unknown; body?: unknown; questions?: unknown }): Promise<TeamSend> {
    const thread = await this.ownThread(sessionId, input.threadId);
    const body = text(input.body, "body");
    if (body.length > RELAY_TEXT_MAX) throw new HostError("bad_request", `body is limited to ${RELAY_TEXT_MAX} characters`);
    return this.asked(this.saveSend({ id: newId("tsend"), sessionId, kind: "followup", to: thread.request!.to, title: thread.title, threadId: thread.id, body, questions: questions(input.questions), files: [], state: "pending", createdAt: new Date().toISOString(), decidedAt: null }));
  }

  /** A new send waits for the person, or goes now when they turned the asking off (a failure is then the tool's answer). */
  private asked(send: TeamSend): Promise<TeamSend> | TeamSend {
    return this.f.config.teamAutoSend() ? this.deliver(send.id, false) : send;
  }

  /** The person said send it. */
  send(id: Id): Promise<TeamSend> {
    return this.deliver(id, true);
  }

  /** Sends it; `tell`: a failure is also said in the session (it is not waiting on the answer). */
  private async deliver(id: Id, tell: boolean): Promise<TeamSend> {
    const pending = this.requireSend(id);
    if (pending.state !== "pending") throw new HostError("conflict", "this send was decided already");
    try {
      const { client, prefix } = this.relay();
      const via = this.via(prefix, pending.sessionId);
      const asked = pending.questions.length ? pending.questions : undefined;
      if (pending.kind === "followup") {
        const out = await this.call(() => client.send(pending.threadId!, { kind: "text", body: pending.body, pass: true, questions: asked, via }));
        this.track(out.thread, pending.sessionId);
        return this.saveSend({ ...this.requireSend(id), state: "sent", decidedAt: new Date().toISOString() });
      }
      const out = await this.call(() => client.ask({ to: pending.to, title: pending.title, body: pending.body, questions: asked, via }));
      this.track(out.thread, pending.sessionId);
      // Sent: a file that does not go along is said, not a failed send.
      const missed: string[] = [];
      for (const file of pending.files) {
        try {
          await client.upload({ threadId: out.thread.id }, basename(file), readFileSync(file), "", { ai: true });
        } catch (err) {
          missed.push(`${basename(file)}（${err instanceof Error ? err.message : String(err)}）`);
        }
      }
      const error = missed.length ? `会话发出了，这些文件没传上：${missed.join("、")}` : undefined;
      if (error) this.tell(pending.sessionId, `【中转】${error}。threadId ${out.thread.id}。`);
      return this.saveSend({ ...this.requireSend(id), state: "sent", threadId: out.thread.id, decidedAt: new Date().toISOString(), ...(error ? { error } : {}) });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const failed = this.saveSend({ ...this.requireSend(id), state: "failed", decidedAt: new Date().toISOString(), error });
      if (tell) this.tell(pending.sessionId, `【中转】${what(pending)}没发出去：${error}`);
      return failed;
    }
  }

  dismiss(id: Id): TeamSend {
    const pending = this.requireSend(id);
    if (pending.state !== "pending") throw new HostError("conflict", "this send was decided already");
    const dismissed = this.saveSend({ ...pending, state: "dismissed", decidedAt: new Date().toISOString() });
    this.tell(pending.sessionId, `【中转】${what(pending)}，人没让发出去。需要的话改一改再发，或者直接在对话里问人。`);
    return dismissed;
  }

  /** team_done: closes a 中转 session this session sent (no asking: it only ends it), with a last word if given. */
  async done(sessionId: Id, input: { threadId?: unknown; note?: unknown }): Promise<{ threadId: string }> {
    const thread = await this.ownThread(sessionId, input.threadId);
    const { client, prefix } = this.relay();
    const via = this.via(prefix, sessionId);
    const note = typeof input.note === "string" ? input.note.trim() : "";
    if (note) await this.call(() => client.send(thread.id, { kind: "text", body: note, via }));
    const out = await this.call(() => client.session(thread.id, "done", { via }));
    this.track(out.thread, sessionId);
    return { threadId: thread.id };
  }

  /** team_session: a 中转 session in full; reading it counts as fetched, so the reply is not sent in again. */
  async read(threadId: unknown): Promise<string> {
    const { client } = this.relay();
    const { thread, messages } = await this.call(() => client.messages(text(threadId, "threadId"), 0, { ai: true }));
    return threadAsText(thread, messages);
  }

  async members(): Promise<Array<{ name: string; nick: string; role: string; online: boolean }>> {
    const { client, me } = this.relay();
    return (await this.call(() => client.members())).filter((m) => m.name !== me).map((m) => ({ name: m.name, nick: m.nick, role: m.role, online: m.online }));
  }

  /** A 中转 session the caller sent (it carries the caller's mark), fresh from the server. */
  private async ownThread(sessionId: Id, threadId: unknown): Promise<Thread> {
    const id = text(threadId, "threadId");
    const { client, me, prefix } = this.relay();
    const { thread } = await this.call(() => client.messages(id, Number.MAX_SAFE_INTEGER));
    const r = thread.request;
    if (!r || r.from !== me || r.conv !== `${prefix}${sessionId}`) throw new HostError("bad_request", `中转会话 ${id} 不是你这个会话发的：只能追问、收尾自己发的。`);
    return thread;
  }

  // ---- the sessions sent, as last seen

  threads(): TeamThread[] {
    try {
      return JSON.parse(this.store.getKv(THREADS_KEY)?.value ?? "[]") as TeamThread[];
    } catch {
      return [];
    }
  }

  private saveThreads(next: TeamThread[]): void {
    const before = this.store.getKv(THREADS_KEY)?.value ?? "[]";
    const value = JSON.stringify(next.slice(-300));
    if (value === before) return;
    this.store.setKv(THREADS_KEY, value);
    this.publish({ type: "teamthreads.changed", threads: next.slice(-300) });
  }

  private view(thread: Thread, sessionId: Id, was: TeamThread | undefined): TeamThread {
    const r = thread.request!;
    const state = r.state === "done" ? "done" : r.state === "returned" ? "returned" : "open";
    const since = state === "returned" ? (r.returnedAt ?? thread.updatedAt) : was && was.state === state ? was.since : thread.updatedAt;
    return { threadId: thread.id, sessionId, title: thread.title, to: r.to, state, since, deliveredAt: was?.deliveredAt ?? null };
  }

  private track(thread: Thread, sessionId: Id): void {
    const list = this.threads();
    const was = list.find((t) => t.threadId === thread.id);
    this.saveThreads([...list.filter((t) => t.threadId !== thread.id), this.view(thread, sessionId, was)]);
  }

  /** The caller's 中转 sessions, in words (team_sessions). */
  sessionLines(sessionId: Id): string {
    const mine = this.threads().filter((t) => t.sessionId === sessionId);
    if (!mine.length) return "这个会话还没有发过中转会话。";
    const ago = (ms: number) => waited(Date.now() - ms);
    return mine
      .map((t) => `- ${t.title} · 发给 ${t.to} · ${t.state === "open" ? `等 ${t.to} 回复（已等 ${ago(t.since)}）` : t.state === "returned" ? "回到你这边了" : "已完成"} · threadId ${t.threadId}`)
      .join("\n");
  }

  // ---- replies back into their sessions

  /** Starts watching 中转 for replies (host-process.ts); a no-op until the platform has a login. */
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (!this.f.remote.teamLogin()) {
          await this.pause(this.pauseMs.signedOut);
          continue;
        }
        await this.scan();
        const { client } = this.relay();
        this.abort = new AbortController();
        const got = await client.wait({ after: this.lastSeq, timeoutMs: this.pauseMs.wait, signal: this.abort.signal });
        for (const m of got) this.lastSeq = Math.max(this.lastSeq, m.seq);
      } catch {
        if (this.running) await this.pause(this.pauseMs.failed);
      }
    }
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.abort = new AbortController();
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      this.abort.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    });
  }

  /** One look at 中转: refresh what the sessions sent, and send what came back into its session. Never two at once. */
  scan(): Promise<void> {
    this.scanning ??= this.scanOnce().finally(() => (this.scanning = null));
    return this.scanning;
  }

  private async scanOnce(): Promise<void> {
    if (!this.f.remote.teamLogin()) return;
    const { client, me, prefix } = this.relay();
    const all = await client.threads();
    for (const t of all) this.lastSeq = Math.max(this.lastSeq, t.lastSeq);
    const before = this.threads();
    const mine = all.filter((t) => t.request && t.request.from === me && t.request.conv?.startsWith(prefix));
    const next = new Map(before.map((t) => [t.threadId, t]));
    for (const t of mine) next.set(t.id, this.view(t, t.request!.conv!.slice(prefix.length), before.find((b) => b.threadId === t.id)));

    // Back with me for the AI, not taken yet: by session, into it, several as one message.
    const due = mine.filter((t) => t.request!.state === "returned" && t.request!.waitingOn === me && t.request!.handler === "ai" && t.request!.pickedAt === null);
    const bySession = new Map<Id, Thread[]>();
    for (const t of due) {
      const sessionId = t.request!.conv!.slice(prefix.length);
      if (!this.canHear(sessionId)) continue;
      bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), t]);
    }
    for (const [sessionId, threads] of bySession) {
      const parts: string[] = [];
      for (const t of threads) {
        const item = await takeSession(client, me, t.id);
        if (!item) continue;
        parts.push(newRepliesText(item.thread, item, `用 team_session（threadId ${item.thread.id}）`));
        const seen = this.view(item.thread, sessionId, next.get(t.id));
        next.set(t.id, { ...seen, deliveredAt: Date.now() });
      }
      if (!parts.length) continue;
      this.tell(sessionId, `【中转回复】\n\n${parts.join("\n\n---\n\n")}\n\n（AMO Studio 从中转转回来的，你用的是 ${me} 的身份。还没问清楚，用 team_followup 追问；已经敲定，用 team_done 标记完成，再按敲定的方案接着做。）`);
    }
    this.saveThreads([...next.values()]);
  }

  /** A session a reply can go into: there, not archived, not handed to a terminal, not a copy of a remote one. */
  private canHear(sessionId: Id): boolean {
    const s = this.store.getSession(sessionId);
    return !!s && !s.archivedAt && s.writer !== "archived" && s.writer !== "terminal-handoff" && s.runtime !== "remote";
  }

  /** Into the session (queued while it works); a session that is gone just misses it. */
  private tell(sessionId: Id, message: string): void {
    void this.f.sessions.sendMessage(sessionId, message).catch((err: unknown) => console.log(`teamrelay: ${String(err)}`));
  }
}

const what = (s: TeamSend) => (s.kind === "ask" ? `你想发给 ${s.to} 的会话「${s.title}」` : `你在「${s.title}」里给 ${s.to} 的追问`);

function text(value: unknown, name: string): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) throw new HostError("bad_request", `${name} is required`);
  return v;
}

function questions(value: unknown): Questions {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HostError("bad_request", "questions must be a list");
  return value.map((q, i) => {
    const t = typeof q?.text === "string" ? q.text.trim() : "";
    if (!t) throw new HostError("bad_request", `questions[${i}].text is required`);
    const options = Array.isArray(q.options) ? q.options.filter((o: unknown): o is string => typeof o === "string" && !!o.trim()).map((o: string) => o.trim()) : [];
    return options.length ? { text: t, options } : { text: t };
  });
}

function localFiles(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((f) => typeof f !== "string")) throw new HostError("bad_request", "files must be a list of paths");
  const files = [...new Set((value as string[]).map((f) => f.trim()).filter(Boolean))];
  if (files.length > TEAM_SEND_FILES_MAX) throw new HostError("bad_request", `at most ${TEAM_SEND_FILES_MAX} files`);
  for (const f of files) {
    if (!isAbsolute(f)) throw new HostError("bad_request", `文件要写完整路径：${f}`);
    let st;
    try {
      st = statSync(f);
    } catch {
      throw new HostError("bad_request", `找不到文件：${f}`);
    }
    if (!st.isFile()) throw new HostError("bad_request", `不是文件（文件夹要先打包）：${f}`);
    if (st.size > FILE_MAX) throw new HostError("bad_request", `文件太大（最多 20 MB）：${f}`);
  }
  return files;
}

function waited(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} 小时` : `${Math.round(h / 24)} 天`;
}
