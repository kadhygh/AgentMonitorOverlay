import { resolve } from "node:path";
import { inTurn, isCommon, type ModelOption, type SubsessionNote, type SubsessionSetup, type Workspace, asyncAnswerText, composeAnnotationRefs, composeRoleUpdate, formContent, type Attachment, type SessionOptions, type ProfileChoices, type ApprovalDecision, type Id, type QuestionAnswer, type QuestionReply, type Session, type SessionItem, type TerminalAttach } from "@amo-studio/protocol";
import type { SendMode, SendOptions } from "../../runtime/runtime.js";
import type { TerminalHandle } from "../../terminal/launcher.js";
import { HostError, isRemoteCopy, optionValue, boundedText, TERMINAL_TOKEN_ENV } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { roleUpdate } from "../guide/role.js";
import { fillDefaults, readModelPrefs } from "../../core/model-prefs.js";
import { SessionInbox } from "./inbox.js";
import { readSetups, rememberSetups } from "./setups.js";

/** Most images one message can carry. */
const MAX_MESSAGE_IMAGES = 10;
/** A message from the person still on its way after this long is written to host.log (sendMessage). */
export const SLOW_SEND_MS = 5000;
/** A session in the middle of a turn: archiving it (closing its process) would cut the turn off (session_archive). */
const busy = (s: Session) => inTurn(s.status);

/** Sessions: conversation, approvals, branches, archive, names and options, terminals. */
export class SessionsFeature extends Feature {
  /** Messages from agents and from Studio: held until the session is free (inbox.ts). */
  readonly inbox = new SessionInbox(this.host);

  /** Terminals that hold a Claude session (handoff); closing one gives the session back. */
  private readonly handoffs = new Map<Id, TerminalHandle>();

  /** One reclaim at a time per session, or the terminal's additions would be imported twice. */
  private readonly reclaiming = new Map<Id, Promise<Session>>();

  /** Renames a session in its own runtime (the stored title follows the runtime's name). */
  renameSession(sessionId: Id, titleIn: unknown): Promise<Session> {
    const s = this.requireSession(sessionId);
    if (s.archivedAt) throw new HostError("read_only", "archived sessions cannot be renamed");
    const title = boundedText(titleIn, "title", 100);
    return this.wrap(() => this.runtime.rename(sessionId, title));
  }

  /** Changes some of the session's options; null (or "") clears one back to the profile's default. */
  updateSessionOptions(sessionId: Id, patch: unknown): Promise<Session> {
    const s = this.store.getSession(sessionId);
    if (!s) throw new HostError("not_found", `session ${sessionId} not found`);
    const p = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
    const next: SessionOptions = { ...s.options };
    for (const key of ["model", "effort", "permission"] as const) {
      if (!(key in p)) continue;
      const value = optionValue(p[key], key);
      if (value) next[key] = value;
      else delete next[key];
    }
    if ("fast" in p) {
      if (typeof p.fast === "boolean") next.fast = p.fast;
      else if (p.fast === null) delete next.fast;
      else throw new HostError("bad_request", "fast must be true, false or null");
    }
    return this.wrap(() => this.runtime.setOptions(sessionId, next));
  }

  /** `tail`: only the last that many (0: all), and the questions and approvals still waiting from before them. */
  items(sessionId: Id, afterSeq = 0, tail = 0): SessionItem[] {
    this.requireSession(sessionId);
    if (tail <= 0) return this.store.listItems(sessionId, afterSeq);
    const last = this.store.listLastItems(sessionId, tail);
    const from = last[0]?.seq ?? Infinity;
    const waiting = (["question", "approval"] as const).flatMap((type) => this.store.findItems(sessionId, type, { state: "pending" })).filter((i) => i.seq < from);
    return [...waiting, ...last].sort((a, b) => a.seq - b.seq);
  }

  /**
   * `attachments`: ids of uploaded images to send along. `annotations`: annotations of this session the message refers
   * to (批注1…), written after the text (composeAnnotationRefs) and marked sent. With either, the text may be empty.
   * When the session's place in AMO changed since it was last told (its task joined a topic, was referenced on another
   * canvas, became a 主控…), a short note of what changed goes last (composeRoleUpdate).
   */
  async sendMessage(sessionId: Id, text: string, attachments: readonly Id[] = [], annotations: readonly Id[] = [], options: SendOptions = {}): Promise<{ mode: SendMode }> {
    this.requireSession(sessionId);
    const referenced = annotations.length ? this.f.review.referencedAnnotations(sessionId, annotations) : null;
    if (referenced) {
      const result = await this.sendMessage(sessionId, composeAnnotationRefs(text ?? "", referenced.refs), attachments, [], options);
      referenced.markSent();
      return result;
    }
    const images = this.images(attachments);
    if (!text?.trim() && !images.length) throw new HostError("bad_request", "text is required");
    const update = this.roleUpdate(sessionId);
    // 2026-11-05: a message the person sent right after 停止 (a DSH session) never came back and left no trace; the
    // composer had already cleared it. One that fails, or is still on its way after SLOW_SEND_MS, is written to host.log.
    const started = Date.now();
    const runtime = this.store.getSession(sessionId)?.runtime ?? "?";
    const slow = setTimeout(() => this.log(`${sessionId} (${runtime}): a message from the person is still on its way after ${SLOW_SEND_MS} ms`), SLOW_SEND_MS);
    slow.unref?.();
    let result: { mode: SendMode };
    try {
      result = await this.wrap(() => this.runtime.sendMessage(sessionId, composeRoleUpdate(text ?? "", update.lines), images, options));
    } catch (err) {
      this.log(`${sessionId} (${runtime}): a message from the person failed after ${Date.now() - started} ms: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      clearTimeout(slow);
    }
    if (Date.now() - started >= SLOW_SEND_MS) this.log(`${sessionId} (${runtime}): the message went in after ${Date.now() - started} ms (${result.mode})`);
    update.told();
    // The person wrote: what the inbox held since they stopped the session goes in with it (inbox.ts, pause).
    this.inbox.resume(sessionId);
    return result;
  }

  /** 立即发送 (2026-11-02): a message still waiting is read by the model now (see SessionRuntimeApi.sendNow). */
  async sendNow(sessionId: Id, itemId: Id): Promise<void> {
    this.requireSession(sessionId);
    const item = this.store.getItem(itemId);
    // One held in the inbox (2026-11-04): it goes now, and the running turn gives way to it.
    if (item?.type === "user" && item.sessionId === sessionId && item.delivery === "held") return this.inbox.sendNow(sessionId, itemId);
    const rt = this.runtime;
    if (!rt.sendNow) throw new HostError("bad_request", "this Host cannot send a waiting message now");
    await this.wrap(() => rt.sendNow!(sessionId, itemId));
  }

  /** 重新发送 a message its process never read, with the pictures it had (those still kept here). */
  async resend(sessionId: Id, itemId: Id): Promise<{ mode: SendMode }> {
    this.requireSession(sessionId);
    const item = this.store.getItem(itemId);
    if (item?.type !== "user" || item.sessionId !== sessionId) throw new HostError("not_found", `message ${itemId} not found`);
    const images = (item.images ?? []).flatMap((i) => {
      if (!i.id) return [];
      try {
        return [this.f.attachments.get(i.id)];
      } catch {
        return [];
      }
    });
    const rt = this.runtime;
    if (!rt.resend) throw new HostError("bad_request", "this Host cannot send a message again");
    return this.wrap(() => rt.resend!(sessionId, itemId, images));
  }

  /** The uploaded images a message carries, checked: known ids, at most MAX_MESSAGE_IMAGES. */
  images(attachments: readonly Id[]): Attachment[] {
    if (!Array.isArray(attachments)) throw new HostError("bad_request", "attachments must be a list of ids");
    if (attachments.length > MAX_MESSAGE_IMAGES) throw new HostError("bad_request", `at most ${MAX_MESSAGE_IMAGES} images per message`);
    return [...new Set(attachments)].map((id) => {
      try {
        return this.f.attachments.get(String(id));
      } catch {
        throw new HostError("bad_request", `attachment ${id} not found`);
      }
    });
  }

  /** A message with what changed about the session's role written after it (composeRoleUpdate). */
  withRole(text: string, lines: string[]): string {
    return composeRoleUpdate(text, lines);
  }

  /** What changed about the session's role since it was last told; nothing for one that cannot hear it. */
  roleUpdate(sessionId: Id): { lines: string[]; told: () => void } {
    const none = { lines: [], told: () => undefined };
    const s = this.store.getSession(sessionId);
    // A copy of a remote session (远程 step 2): its own computer tells it what changed there.
    if (!s || s.kind === "sub" || s.archivedAt || isRemoteCopy(s)) return none;
    try {
      return roleUpdate(this.host, sessionId);
    } catch {
      return none;
    }
  }

  /** 停止, the person's (here or from another device): the inbox holds what comes until they write again (2026-11-04, the user). */
  async interrupt(sessionId: Id): Promise<void> {
    this.requireSession(sessionId);
    this.inbox.pause(sessionId);
    await this.wrap(() => this.runtime.interrupt(sessionId));
  }

  /** Stage 15: `{ stopLoop: true }` stops the session's loop; `{ autoContinue }` switches going on after a usage limit. */
  setWakeChoice(sessionId: Id, body: unknown): Promise<Session> {
    const s = this.requireSession(sessionId);
    if (s.archivedAt) throw new HostError("read_only", "archived sessions have no loop");
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const choice: { stopLoop?: boolean; autoContinue?: boolean } = {};
    if (b.stopLoop === true) choice.stopLoop = true;
    else if (typeof b.autoContinue === "boolean") choice.autoContinue = b.autoContinue;
    else throw new HostError("bad_request", "stopLoop: true or autoContinue: boolean is required");
    if (!this.runtime.setWakeChoice) throw new HostError("bad_request", "this Host has no loop");
    return this.wrap(() => this.runtime.setWakeChoice!(sessionId, choice));
  }

  async fork(sessionId: Id, profileId?: Id): Promise<Session> {
    const s = this.requireSession(sessionId);
    if (s.archivedAt) throw new HostError("read_only", "archived sessions cannot be forked");
    if (profileId) this.requireProfile(profileId);
    return this.wrap(() => this.runtime.fork(sessionId, profileId));
  }

  async archive(sessionId: Id): Promise<Session[]> {
    this.requireSession(sessionId);
    return this.wrap(() => this.runtime.archive(sessionId));
  }

  async unarchive(sessionId: Id): Promise<Session[]> {
    this.requireSession(sessionId);
    return this.wrap(() => this.runtime.unarchive(sessionId));
  }

  async respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void> {
    this.requireSession(sessionId);
    if (decision !== "accept" && decision !== "decline") throw new HostError("bad_request", `unknown decision ${String(decision)}`);
    await this.wrap(() => this.runtime.respondApproval(sessionId, approvalId, decision), "conflict");
  }

  /**
   * Answers a pending question item. The reply is checked against the item (its source, its questions, its form)
   * before the runtime sends it on.
   */
  async answerQuestion(sessionId: Id, itemId: Id, body: unknown): Promise<void> {
    this.requireSession(sessionId);
    const item = this.store.getItem(itemId);
    if (!item || item.sessionId !== sessionId || item.type !== "question") throw new HostError("not_found", `question ${itemId} not found`);
    if (item.state !== "pending") throw new HostError("conflict", `question ${itemId} is no longer pending (${item.state})`);
    const reply = questionReply(body);
    const fits =
      reply.action === "dismiss" ||
      (reply.action === "answer" && (item.source === "claude-ask" || item.source === "codex-input" || item.source === "codex-async")) ||
      (reply.action === "submit" && item.source === "mcp-form") ||
      ((reply.action === "approve" || reply.action === "revise") && item.source === "plan-review");
    if (!fits) throw new HostError("bad_request", `a ${item.source} question cannot take "${reply.action}"`);
    if (reply.action === "submit") {
      const checked = formContent(item.form ?? [], reply.values);
      if ("error" in checked) throw new HostError("bad_request", checked.error);
    }
    await this.wrap(() => this.runtime.answerQuestion(sessionId, itemId, reply), "conflict");
    // Codex's async questions: the answer is the person's next message (the turn did not wait for it).
    if (item.source === "codex-async" && reply.action === "answer") await this.sendMessage(sessionId, asyncAnswerText(item.questions ?? [], reply.answers));
  }

  /**
   * Codex: opens the real TUI on the same app-server (`codex --remote … resume`). Both sides keep writing, so the
   * session becomes "terminal-shared". With `launch: false` only the command is returned (tests, copy to clipboard).
   */
  async terminal(sessionId: Id, launch: boolean): Promise<TerminalAttach> {
    const s = this.requireSession(sessionId);
    if (s.archivedAt) throw new HostError("read_only", "archived sessions cannot be opened in a terminal");
    if (s.runtime === "claude") return this.handToTerminal(s, launch);
    const info = await this.wrap(() => this.runtime.attachInfo(sessionId));
    const command = `codex --remote ${info.url} --remote-auth-token-env ${TERMINAL_TOKEN_ENV} resume ${info.threadId}`;
    if (launch) {
      if (!this.options.launcher) throw new HostError("bad_request", "no terminal launcher configured");
      const ws = this.store.getWorkspace(s.workspaceId);
      this.options.launcher.launch({
        command,
        cwd: ws?.path ?? process.cwd(),
        env: { [TERMINAL_TOKEN_ENV]: info.token },
        title: `AMO Studio · ${s.title || "会话"}`,
      });
      this.runtime.setWriter(sessionId, "terminal-shared");
    }
    return { command, envVar: TERMINAL_TOKEN_ENV, launched: launch };
  }

  /**
   * Claude: `claude --resume` in a terminal holds the session alone (two writers would lose turns), so Studio turns
   * read-only and takes the session back when the terminal closes — or at once with "立即收回", which closes it.
   */
  private async handToTerminal(s: Session, launch: boolean): Promise<TerminalAttach> {
    if (!launch) throw new HostError("bad_request", "a Claude session can only be handed to a terminal directly");
    if (s.kind === "sub") throw new HostError("read_only", "a Claude subagent cannot be opened in a terminal");
    const launcher = this.options.launcher;
    if (!launcher) throw new HostError("bad_request", "no terminal launcher configured");
    if (!this.runtime.handoff) throw new HostError("bad_request", "this Host cannot hand Claude sessions to a terminal");
    const plan = await this.wrap(() => this.runtime.handoff!(s.id), "conflict");
    let handle: TerminalHandle | undefined;
    try {
      // The complete environment: nothing Claude-related from the Host's own environment leaks into the terminal.
      handle = launcher.launch({ command: plan.command, cwd: plan.cwd, env: plan.env, envMode: "replace", track: true, title: `AMO Studio · ${s.title || "Claude 会话"}` });
    } catch (err) {
      await this.reclaim(s.id).catch(() => undefined);
      throw err;
    }
    if (handle) {
      this.handoffs.set(s.id, handle);
      handle.onExit(() => {
        if (this.handoffs.get(s.id) !== handle) return;
        this.handoffs.delete(s.id);
        void this.reclaim(s.id).catch(() => undefined);
      });
    }
    return { command: plan.command, envVar: null, launched: true };
  }

  /**
   * Back to workbench-only writing: after closing a Codex TUI, or taking a Claude handoff back (closing its terminal
   * if it is still open, then importing what it added).
   */
  async reclaim(sessionId: Id): Promise<Session> {
    const s = this.requireSession(sessionId);
    if (s.archivedAt) throw new HostError("read_only", "archived sessions cannot be reclaimed");
    const pending = this.reclaiming.get(sessionId);
    if (pending) return pending;
    const run = (async () => {
      const handle = this.handoffs.get(sessionId);
      if (handle?.running) {
        this.handoffs.delete(sessionId);
        const exited = new Promise<void>((r) => handle.onExit(r));
        handle.kill();
        // The terminal's Claude process must be gone before Studio starts its own for the same session id.
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      }
      return this.wrap(() => (this.runtime.reclaim ? this.runtime.reclaim(sessionId) : Promise.resolve(this.runtime.setWriter(sessionId, "workbench"))));
    })();
    this.reclaiming.set(sessionId, run);
    try {
      return await run;
    } finally {
      this.reclaiming.delete(sessionId);
    }
  }

  /**
   * 开会话 (session_start, 2026-10-22): a session of a task starts another main session in the same task, at once (the
   * person chose not to be asked: they watch the task, and can stop it). The model is the caller's unless named. With
   * `report`, each of the new session's turns that ends goes back into the caller's conversation (watchReports).
   * 2026-10-22 (the person's wish, after a task in the common space sent its sessions into the wrong folder):
   * `workspace` runs it in another project (by name, id or path) while it stays the task's; `permission` (read-only /
   * write / full) picks its runtime's matching permission instead of the model's default.
   */
  async startPeer(fromSessionId: Id, input: { text?: unknown; model?: unknown; title?: unknown; report?: unknown; workspace?: unknown; permission?: unknown; effort?: unknown; forPerson?: unknown; setup?: unknown; fast?: unknown }): Promise<Session> {
    const from = this.requireSession(fromSessionId);
    if (from.kind === "sub") throw new HostError("bad_request", "子 agent 不能开 AMO 会话：交给你的主会话来开。");
    if (!from.taskId) throw new HostError("bad_request", "你是专题会话，没有自己的任务：开任务要用 task_plan_propose 提案。");
    const task = this.requireTask(from.taskId);
    if (task.archivedAt) throw new HostError("read_only", "这个任务已归档，不能再开会话");
    const text = boundedText(input.text, "text", 20_000);
    const title = input.title === undefined || input.title === null || input.title === "" ? null : boundedText(input.title, "title", 100);
    if (input.fast !== undefined && input.fast !== null && typeof input.fast !== "boolean") throw new HostError("bad_request", "fast must be true or false");
    if (input.effort !== undefined && input.effort !== null && input.effort !== "" && typeof input.effort !== "string") throw new HostError("bad_request", "effort must be text, e.g. high");
    // 子会话设定 (2026-11-05): what the person set up with @ 开子会话… wins over what the agent writes.
    const setup = this.setupOf(from.id, input.setup);
    let picked: { profileId: Id; model?: string } = setup
      ? { profileId: this.f.requireProfile(setup.profileId).id, ...(setup.model ? { model: setup.model } : {}) }
      : typeof input.model === "string" && input.model.trim()
        ? await this.modelByRef(input.model.trim())
        : { profileId: from.profileId };
    // For the person (2026-10-26: 「本 task 里另起一个 session，我来处理」 came out as one hung under its starter, which
    // Focus leaves to the starter): a session of the task like one they opened, not reporting back.
    const forPerson = input.forPerson === true;
    if (forPerson && input.report === true) throw new HostError("bad_request", "forPerson 的会话是给人自己推进的，结果不回到你这里：去掉 report");
    const report = input.report === true;
    const workspace = input.workspace === undefined || input.workspace === null || input.workspace === "" ? this.requireLiveWorkspace(task.workspaceId) : this.workspaceByRef(input.workspace);
    // 远程 (step 2, 「授权范围」): a task granted to a paired device keeps its sessions in its own project and on the
    // models allowed for remote use (another one is swapped for the default allowed one, and the new session told).
    const remote = this.f.remote.grants.limitDelegation(task.id, { profileId: picked.profileId, elsewhere: workspace.id !== task.workspaceId });
    if (remote?.note) picked = { profileId: remote.profileId };
    const profileId = picked.profileId;
    // 设置 → 子会话's defaults for this model (2026-11-05, the user's choice): used for what the agent leaves out.
    const defaults = remote?.note ? null : this.noteDefaults(profileId, picked.model ?? null);
    let options: SessionOptions | undefined = picked.model ? { model: picked.model } : undefined;
    if (remote?.permission) options = { ...options, permission: remote.permission };
    else {
      const asked = setup?.permission ?? (input.permission === undefined || input.permission === null || input.permission === "" ? undefined : input.permission);
      const want = asked ?? defaults?.permission;
      let level: PermissionLevel | null = null;
      if (want !== undefined) {
        level = PERMISSION_LEVELS.find((l) => l === want) ?? null;
        if (!level) throw new HostError("bad_request", `permission must be one of: ${PERMISSION_LEVELS.join(", ")}`);
      }
      // The person's own choice (a setup, or their default where the agent named none) is not held to the caller's.
      const personChose = !!setup?.permission || (asked === undefined && !!defaults?.permission);
      const permission = await this.peerPermission(from, profileId, level, personChose);
      if (permission) options = { ...options, permission };
    }
    if (!remote?.note) {
      const effort = setup?.effort ?? (typeof input.effort === "string" && input.effort.trim() ? input.effort.trim() : undefined);
      if (effort) options = { ...options, effort: await this.effortFor(profileId, picked.model, effort) };
      else if (defaults?.effort) {
        // A default the model's list no longer has is passed over.
        const fallback = await this.effortFor(profileId, picked.model, defaults.effort).catch(() => null);
        if (fallback) options = { ...options, effort: fallback };
      }
      const agentFast = typeof input.fast === "boolean" ? input.fast : undefined;
      const fast = setup?.fast ?? agentFast ?? defaults?.fast;
      if (fast !== undefined) {
        const runs = await this.modelOption(profileId, picked.model);
        if (runs?.fast) options = { ...options, fast };
        else if (fast && setup?.fast === undefined && agentFast === true) throw new HostError("bad_request", `${this.f.requireProfile(profileId).label}（${runs?.label ?? picked.model ?? "默认型号"}）没有 Fast：去掉 fast 再开`);
      }
    }
    const elsewhere = workspace.id !== task.workspaceId;
    const message = [
      forPerson ? `【本任务的会话「${from.title || "未命名会话"}」应人的要求开启：人会在这里和你一起推进】` : `【由本任务的会话「${from.title || "未命名会话"}」开启】`,
      ...(elsewhere ? [`（你在项目「${isCommon(workspace) ? "公共目录" : workspace.name}」的文件夹 ${workspace.path} 里工作，和任务本身的项目不同。）`] : []),
      ...(remote?.note ? [remote.note] : []),
      text,
      ...(setup?.extra ? ["", `【人对这个子会话补充的话（@${setup.name}）】`, setup.extra] : []),
      "",
      forPerson
        ? `（这个会话是同一任务里的另一个会话（${from.id}）替人通过 AMO Studio 开的，之后听人的。要告诉那个会话什么，用 mailbox_send 给会话 ${from.id}。）`
        : report
          ? `（这个会话是同一任务里的另一个会话（${from.id}）通过 AMO Studio 开的。每一轮做完后，你最后的回复会自动转给它（被人停下或出错时也会告诉它）；中途要告诉它什么，用 mailbox_send 给会话 ${from.id}。）`
          : `（这个会话是同一任务里的另一个会话（${from.id}）通过 AMO Studio 开的。要告诉它什么，用 mailbox_send 给会话 ${from.id}。）`,
    ].join("\n");
    const started = await this.f.tasks.startSession({ taskId: task.id, topicId: null }, workspace, { profileId, text: message, ...(options ? { options } : {}) });
    // 委派 (10-22): the session list shows it under the caller; otherwise it is a main session like any other. One for
    // the person stands on its own, beside the caller.
    if (!forPerson) this.store.setSessionStartedBy(started.id, from.id);
    const session = report ? this.store.setSessionReportTo(started.id, from.id) : this.store.getSession(started.id)!;
    this.publish({ type: "session.upserted", session });
    const named = title ? await this.renameSession(session.id, title).catch(() => session) : session;
    // A quick turn may have ended before the session was marked.
    if (report) this.checkReport(this.requireSession(named.id));
    return named;
  }

  /**
   * 收会话 (session_archive, 2026-11-01, 问题 #6 — the person took the suggestions): a session archives one it started
   * with session_start (startedBy is the caller; one opened forPerson has none, so it stays the person's), unasked, as
   * the session list's 归档 does — branches and subagents with it, and it can be unarchived there. One still in a turn
   * is refused unless `stop` is true: archiving closes its process and would cut the turn off.
   */
  async archivePeer(fromSessionId: Id, input: { sessionId?: unknown; stop?: unknown }): Promise<Session[]> {
    const from = this.requireSession(fromSessionId);
    if (typeof input.sessionId !== "string" || !input.sessionId) throw new HostError("bad_request", "sessionId is required");
    if (input.sessionId === from.id) throw new HostError("bad_request", "不能归档你自己：只能归档你用 session_start 开的会话。");
    const s = this.store.getSession(input.sessionId);
    if (!s || s.startedBy !== from.id || s.taskId !== from.taskId) throw new HostError("bad_request", `会话 ${input.sessionId} 不是你用 session_start 开的，不能归档：只能归档你自己开的会话（人开的、别的会话开的、forPerson 开给人的都不行）。`);
    if (s.archivedAt) throw new HostError("bad_request", `会话 ${s.id} 已经归档了`);
    if (busy(s) && input.stop !== true) throw new HostError("conflict", `会话「${s.title || s.id}」还在跑（${s.status}），归档会打断它这一轮：等它做完再归档，或者带 stop: true 停掉它再归档。`);
    if (busy(s)) await this.interrupt(s.id).catch(() => undefined);
    return this.archive(s.id);
  }

  /**
   * 续发 (session_send, 2026-11-01 — a session running a staged test asked for it: 交付 → 复核 → 发下一阶段 without the
   * person relaying each stage): a session sends another message into one it started with session_start (the same
   * sessions session_archive may take), unasked, marked as from it. One in a turn — running, or waiting on the person —
   * gets it once that turn is over (the session's inbox, 2026-11-04: shown there meanwhile, kept across a restart);
   * several waiting go in together. With report, the turn's report reaches the caller first.
   */
  async sendPeer(fromSessionId: Id, input: { sessionId?: unknown; text?: unknown }): Promise<{ session: Session; delivered: boolean; waiting: number }> {
    const from = this.requireSession(fromSessionId);
    if (typeof input.sessionId !== "string" || !input.sessionId) throw new HostError("bad_request", "sessionId is required");
    if (input.sessionId === from.id) throw new HostError("bad_request", "不能发给你自己：只能发给你用 session_start 开的会话。");
    const s = this.store.getSession(input.sessionId);
    if (!s || s.startedBy !== from.id || s.taskId !== from.taskId) throw new HostError("bad_request", `会话 ${input.sessionId} 不是你用 session_start 开的，不能往里发：只能发给你自己开的会话（人开的、别的会话开的、forPerson 开给人的都不行）。`);
    if (s.archivedAt) throw new HostError("bad_request", `会话 ${s.id} 已经归档了：要接着做就用 session_start 开个新的。`);
    const text = boundedText(input.text, "text", 20_000);
    const { delivered, waiting } = await this.inbox.put(s.id, `【开启你的会话「${from.title || "未命名会话"}」（${from.id}）发来】\n${text}`);
    return { session: this.requireSession(s.id), delivered, waiting };
  }

  /**
   * An agent's effort (session_start, task_plan_propose; 2026-10-26): checked against the model the new session will
   * run (`chosen`, else the person's default in 设置 → 模型, else the CLI's), as its CLI names them; unchecked when the
   * list cannot be had.
   */
  /**
   * 开会话's permission (2026-10-29, the person's decision after a session started with `write` asked them about every
   * read-only command): left out, the new session keeps the caller's own (on the same CLI; on another, that CLI's
   * default); and it is never wider than the caller's — a level that would be is refused, a default that would be is
   * brought down to the caller's level.
   */
  private async peerPermission(from: Session, profileId: Id, level: PermissionLevel | null, personChose = false): Promise<string | undefined> {
    const runtime = this.f.requireProfile(profileId).runtime;
    if (!isPeerRuntime(runtime)) return undefined;
    const choices = await this.f.config.choices(profileId).catch(() => null);
    if (personChose && level) return peerPermission(null, runtime, level, choices);
    const callerPermission = isPeerRuntime(from.runtime) ? from.options.permission || (await this.f.config.choices(from.profileId).catch(() => null))?.defaultPermission || "" : "";
    const caller = isPeerRuntime(from.runtime) && callerPermission ? { runtime: from.runtime, permission: callerPermission } : null;
    return peerPermission(caller, runtime, level, choices);
  }

  /**
   * A session an agent sets up for later (duty_save, 2026-10-31): model, permission and effort as session_start takes
   * them; the permission left out is the caller's own (an unattended session that asks would wait for nobody).
   */
  async optionsFor(fromSessionId: Id, input: { model?: unknown; permission?: unknown; effort?: unknown }): Promise<{ profileId: Id; options: SessionOptions }> {
    const from = this.requireSession(fromSessionId);
    const picked: { profileId: Id; model?: string } = typeof input.model === "string" && input.model.trim() ? await this.modelByRef(input.model.trim()) : { profileId: from.profileId };
    let options: SessionOptions = picked.model ? { model: picked.model } : {};
    let level: PermissionLevel | null = null;
    if (input.permission !== undefined && input.permission !== null && input.permission !== "") {
      level = PERMISSION_LEVELS.find((l) => l === input.permission) ?? null;
      if (!level) throw new HostError("bad_request", `permission must be one of: ${PERMISSION_LEVELS.join(", ")}`);
    }
    const permission = await this.peerPermission(from, picked.profileId, level);
    if (permission) options = { ...options, permission };
    if (typeof input.effort === "string" && input.effort.trim()) options = { ...options, effort: await this.effortFor(picked.profileId, picked.model, input.effort.trim()) };
    return { profileId: picked.profileId, options };
  }

  /** session_start's `setup`: the 子会话设定 of that name sent to the caller (null when none is asked for). */
  private setupOf(fromId: Id, name: unknown): SubsessionSetup | null {
    if (name === undefined || name === null || name === "") return null;
    if (typeof name !== "string") throw new HostError("bad_request", "setup must be the name of a 子会话设定, e.g. 子会话·Opus·high");
    const want = name.trim().replace(/^@/, "");
    const all = readSetups(this.store, fromId);
    const hit = all.find((s) => s.name === want);
    if (hit) return hit;
    throw new HostError(
      "bad_request",
      all.length
        ? `没有叫「${want}」的子会话设定。人发给你的有：${all.map((s) => `「${s.name}」`).join("、")}`
        : `没有叫「${want}」的子会话设定：人还没在发给你的消息里 @ 过子会话。去掉 setup，自己用 model、effort 开。`,
    );
  }

  /**
   * 设置 → 子会话's defaults for a model as a sub-session: its own entry's (the account's entry is the default model's
   * own), else the account's fast and permission (an effort only fits the list of the model it was set for).
   */
  private noteDefaults(profileId: Id, model: string | null): Pick<SubsessionNote, "effort" | "fast" | "permission"> {
    const notes = this.f.config.subsessionNotes().filter((n) => n.profileId === profileId);
    const own = notes.find((n) => (n.model ?? null) === model);
    const account = notes.find((n) => n.model === null);
    const fast = own?.fast ?? account?.fast;
    const permission = own?.permission ?? account?.permission;
    return { ...(own?.effort ? { effort: own.effort } : {}), ...(fast !== undefined ? { fast } : {}), ...(permission ? { permission } : {}) };
  }

  /** The model a session of `profileId` would run (the chosen one, else the profile's default), as its CLI lists it. */
  private async modelOption(profileId: Id, chosen: string | undefined): Promise<ModelOption | undefined> {
    const choices = await this.f.config.choices(profileId).catch(() => null);
    if (!choices?.models.length) return undefined;
    const model = chosen ?? fillDefaults({}, choices, readModelPrefs(this.store)[profileId]).model;
    return choices.models.find((m) => m.id === model) ?? choices.models.find((m) => m.isDefault) ?? choices.models[0];
  }

  /** Keeps 子会话设定 sent with a message to this session (POST /api/sessions/:id/messages, a task's first session). */
  rememberSetups(sessionId: Id, setups: readonly SubsessionSetup[]): void {
    this.requireSession(sessionId);
    for (const s of setups) this.f.requireProfile(s.profileId);
    rememberSetups(this.store, sessionId, setups);
  }

  async effortFor(profileId: Id, chosen: string | undefined, want: string): Promise<string> {
    const choices = await this.f.config.choices(profileId).catch(() => null);
    if (!choices?.models.length) return want;
    const model = chosen ?? fillDefaults({}, choices, readModelPrefs(this.store)[profileId]).model;
    const runs = choices.models.find((m) => m.id === model) ?? choices.models.find((m) => m.isDefault) ?? choices.models[0]!;
    const name = `${this.f.requireProfile(profileId).label}（${runs.label}）`;
    if (!runs.efforts.length) throw new HostError("bad_request", `${name} 没有思考强度可选，去掉 effort 再开`);
    const hit = runs.efforts.find((e) => e.toLowerCase() === want.toLowerCase());
    if (!hit) throw new HostError("bad_request", `${name} 的 effort 只能是：${runs.efforts.join(", ")}`);
    return hit;
  }

  /**
   * An agent's model (session_start, task_plan_propose; 2026-10-26: 「@ 开子会话」 picks a model of an account, not only
   * the account): a model profile as amo_whoami names it; or "<profile>/<model>", one of that profile's models by id or
   * name; or a model's id or name in any profile's list (the first profile that has it).
   */
  async modelByRef(ref: string): Promise<{ profileId: Id; model?: string }> {
    try {
      return { profileId: this.f.profileByRef(ref).id };
    } catch (err) {
      const slash = ref.indexOf("/");
      const named = slash > 0 ? this.f.profiles.find((p) => !p.hidden && [p.id, p.label].some((x) => x.toLowerCase() === ref.slice(0, slash).trim().toLowerCase())) : undefined;
      const want = (named ? ref.slice(slash + 1) : ref).trim().toLowerCase();
      for (const p of named ? [named] : this.f.profiles.filter((x) => !x.hidden)) {
        const choices = await this.f.config.choices(p.id).catch(() => null);
        const m = choices?.models.find((x) => x.id.toLowerCase() === want || x.label.toLowerCase() === want);
        if (m) return m.isDefault ? { profileId: p.id } : { profileId: p.id, model: m.id };
      }
      if (named) throw new HostError("bad_request", `${named.label} 没有型号 ${ref.slice(slash + 1).trim()}`);
      throw err;
    }
  }

  /** A live project (or the common space) by id, name or folder path, as project_context lists them. */
  workspaceByRef(ref: unknown): Workspace {
    if (typeof ref !== "string") throw new HostError("bad_request", "workspace must be a project's name, id or path");
    const want = ref.trim();
    const norm = (p: string) => resolve(p).replace(/[\\/]+$/, "").toLowerCase();
    const live = this.store.listWorkspaces().filter((w) => !w.archivedAt);
    const found = live.find((w) => w.id === want) ?? live.find((w) => w.name.toLowerCase() === want.toLowerCase()) ?? live.find((w) => norm(w.path) === norm(want));
    if (!found) throw new HostError("bad_request", `project ${want} not found; choose one of: ${live.filter((w) => !isCommon(w)).map((w) => w.name).join(", ")}`);
    return found;
  }

  /**
   * session_start's report (2026-10-22, after a session stopped by the person reported a half answer as done and its
   * real end went unreported): each turn of the session that ends is told to the one that started it, once — done
   * (its last reply, or only a line when it already left that session mail during the turn), stopped by the person
   * (no answer yet; the turn that finishes the work reports it), or failed (its error). A turn waiting for the person
   * has not ended. Which turn was told last is kept, so a restart neither repeats nor loses one.
   */
  watchReports(): void {
    this.f.on("event", (e) => {
      if (e.type !== "session.upserted") return;
      if (e.session.reportTo) this.checkReport(e.session);
    });
    // The inbox (session_send's messages among them) after the reports: the caller hears of the turn first.
    this.inbox.watch();
  }

  private checkReport(s: Session): void {
    // A copy of a remote session (远程 step 2) is reported where it runs, never again from here.
    if (isRemoteCopy(s)) return;
    if (!s.reportTo || s.archivedAt || !(s.status === "idle" || s.status === "completed" || s.status === "interrupted" || s.status === "error")) return;
    const [turn] = this.store.findItems(s.id, "turn", {}, { newest: true, limit: 1 });
    if (!turn || turn.type !== "turn" || turn.state === "running") return;
    const key = `report-turn:${s.id}`;
    if (this.store.getKv(key)?.value === turn.id) return;
    this.store.setKv(key, turn.id);
    const to = s.reportTo;
    const name = `「${s.title || "未命名会话"}」（${s.id}）`;
    let text: string;
    if (turn.state === "interrupted") text = `【你开的会话${name}被人停下了，还没有结论】它接着做完后，结果会再转给你。`;
    else if (turn.state === "failed") text = `【你开的会话${name}出错停下了】\n${turn.error ?? "（没有错误信息）"}`;
    else {
      const mailed = this.store.listMail({ sessionId: to }).some((m) => m.fromSessionId === s.id && m.createdAt >= turn.startedAt);
      const [last] = this.store.findItems(s.id, "agent", {}, { newest: true, limit: 1 });
      const reply = last && last.type === "agent" && last.createdAt >= turn.startedAt ? last.markdown.trim() : "";
      const excerpt = reply.length > REPORT_MAX ? `${reply.slice(0, REPORT_MAX)}…（后面省略；完整的用 session_tree 或打开会话看）` : reply;
      text = mailed ? `【你开的会话${name}这一轮做完了，它已经用留言把结果发给你】` : `【你开的会话${name}这一轮做完了】\n${excerpt || "（它没有回复文字）"}`;
    }
    // Into the caller's inbox (2026-11-04): it goes in once the caller is free, rather than into its running turn.
    this.inbox.put(to, text).catch(() => {
      // The caller is gone or archived: it can still read it as mail.
      try {
        this.f.collab.sendMail(s.id, { kind: "session", sessionId: to }, text);
      } catch {
        // Nowhere to report to.
      }
    });
  }
}

/** session_start's permission levels, as each runtime's own permission option. */
const PERMISSION_LEVELS = ["read-only", "write", "full"] as const;
type PermissionLevel = (typeof PERMISSION_LEVELS)[number];
type PeerRuntime = Exclude<Session["runtime"], "remote">;
const PERMISSIONS: Record<PeerRuntime, Record<PermissionLevel, string>> = {
  codex: { "read-only": "read-only", write: "workspace-write", full: "full-auto" },
  // write = 帮我审批 (10-29): 自动接受编辑 asked about every command, read-only ones too — narrower than the caller's
  // 帮我审批 and than Codex's and DSH's write, which run commands in their folder without asking.
  claude: { "read-only": "plan", write: "auto", full: "bypassPermissions" },
  dsh: { "read-only": "read-only", write: "workspace-write", full: "full-access" },
};
/** Each runtime's permission options, narrowest first (for 「不比开它的会话宽」 on the same CLI). */
const PERMISSION_ORDER: Record<PeerRuntime, string[]> = {
  codex: ["read-only", "ask", "workspace-write", "auto-review", "on-request", "full-auto"],
  claude: ["plan", "default", "acceptEdits", "auto", "bypassPermissions"],
  dsh: ["read-only", "workspace-write", "full-access"],
};

function isPeerRuntime(runtime: string): runtime is PeerRuntime {
  return runtime in PERMISSIONS;
}

/** The level a permission amounts to across CLIs: 0 read-only, 1 write (anything between), 2 full. */
function permissionLevel(runtime: PeerRuntime, permission: string): number {
  return permission === PERMISSIONS[runtime]["read-only"] ? 0 : permission === PERMISSIONS[runtime].full ? 2 : 1;
}

/** Whether `permission` (of `runtime`) lets a session do more than the caller's: by order on the same CLI, by level across. */
function widerPermission(runtime: PeerRuntime, permission: string, callerRuntime: PeerRuntime, callerPermission: string): boolean {
  if (runtime === callerRuntime) {
    const order = PERMISSION_ORDER[runtime];
    const [a, b] = [order.indexOf(permission), order.indexOf(callerPermission)];
    if (a >= 0 && b >= 0) return a > b;
  }
  return permissionLevel(runtime, permission) > permissionLevel(callerRuntime, callerPermission);
}

/** 开会话's permission for a session of `runtime` (see SessionService.peerPermission); undefined = the model's default. */
export function peerPermission(caller: { runtime: PeerRuntime; permission: string } | null, runtime: PeerRuntime, level: PermissionLevel | null, choices: Pick<ProfileChoices, "permissions" | "defaultPermission"> | null): string | undefined {
  const usable = (id: string) => !choices || choices.permissions.some((p) => p.id === id && !p.unavailable);
  const forLevel = (l: PermissionLevel) => {
    const id = PERMISSIONS[runtime][l];
    // 帮我审批 needs Anthropic's classifier: a Claude Code session on another endpoint (GLM…) gets 自动接受编辑.
    return usable(id) ? id : runtime === "claude" && l === "write" ? "acceptEdits" : id;
  };
  if (level) {
    const permission = forLevel(level);
    if (caller && widerPermission(runtime, permission, caller.runtime, caller.permission)) {
      const allowed = PERMISSION_LEVELS.filter((l) => !widerPermission(runtime, forLevel(l), caller.runtime, caller.permission));
      throw new HostError("bad_request", `你自己的权限是 ${caller.permission}，开的会话不能比你宽：permission ${allowed.length ? `用 ${allowed.join(" 或 ")}，或者` : ""}不填（沿用你的）`);
    }
    return permission;
  }
  if (!caller) return undefined;
  if (caller.runtime === runtime) return caller.permission;
  const fallback = choices?.defaultPermission;
  if (!fallback || !widerPermission(runtime, fallback, caller.runtime, caller.permission)) return undefined;
  return forLevel(PERMISSION_LEVELS[permissionLevel(caller.runtime, caller.permission)]!);
}

/** How much of the new session's reply a report carries. */
const REPORT_MAX = 4000;

/** Checks the shape of a question reply (the answers' sizes are bounded: they go to the model as they are). */
function questionReply(body: unknown): QuestionReply {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  switch (b.action) {
    case "dismiss":
    case "approve":
      return { action: b.action };
    case "revise":
      return { action: "revise", feedback: boundedText(b.feedback, "feedback", 20_000) };
    case "submit":
      if (!b.values || typeof b.values !== "object" || Array.isArray(b.values)) throw new HostError("bad_request", "values must be an object");
      return { action: "submit", values: b.values as Record<string, unknown> };
    case "answer": {
      if (!Array.isArray(b.answers)) throw new HostError("bad_request", "answers must be a list");
      const answers: QuestionAnswer[] = b.answers.map((a: unknown) => {
        const x = a && typeof a === "object" ? (a as Record<string, unknown>) : {};
        if (typeof x.id !== "string") throw new HostError("bad_request", "every answer needs the id of its question");
        const selected = Array.isArray(x.selected) ? x.selected.filter((l): l is string => typeof l === "string") : [];
        const other = typeof x.other === "string" ? x.other : undefined;
        if (other && other.length > 20_000) throw new HostError("bad_request", "an answer is too long");
        return { id: x.id, selected, ...(other !== undefined ? { other } : {}), ...(x.skipped === true ? { skipped: true } : {}) };
      });
      return { action: "answer", answers };
    }
    default:
      throw new HostError("bad_request", `unknown action ${String(b.action)}`);
  }
}
