import { resolve } from "node:path";
import { isCommon, type Workspace, asyncAnswerText, composeAnnotationRefs, composeRoleUpdate, formContent, type Attachment, type SessionOptions, type ApprovalDecision, type Id, type QuestionAnswer, type QuestionReply, type Session, type SessionItem, type TerminalAttach } from "@amo-studio/protocol";
import type { SendMode } from "../../runtime/runtime.js";
import type { TerminalHandle } from "../../terminal/launcher.js";
import { HostError, optionValue, boundedText, TERMINAL_TOKEN_ENV } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";
import { roleUpdate } from "../guide/role.js";
import { fillDefaults, readModelPrefs } from "../../core/model-prefs.js";

/** Most images one message can carry. */
const MAX_MESSAGE_IMAGES = 10;

/** Sessions: conversation, approvals, branches, archive, names and options, terminals. */
export class SessionsFeature extends Feature {
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
  async sendMessage(sessionId: Id, text: string, attachments: readonly Id[] = [], annotations: readonly Id[] = []): Promise<{ mode: SendMode }> {
    this.requireSession(sessionId);
    const referenced = annotations.length ? this.f.review.referencedAnnotations(sessionId, annotations) : null;
    if (referenced) {
      const result = await this.sendMessage(sessionId, composeAnnotationRefs(text ?? "", referenced.refs), attachments);
      referenced.markSent();
      return result;
    }
    const images = this.images(attachments);
    if (!text?.trim() && !images.length) throw new HostError("bad_request", "text is required");
    const update = this.roleUpdate(sessionId);
    const result = await this.wrap(() => this.runtime.sendMessage(sessionId, composeRoleUpdate(text ?? "", update.lines), images));
    update.told();
    return result;
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

  /** What changed about the session's role since it was last told; nothing for one that cannot hear it. */
  private roleUpdate(sessionId: Id): { lines: string[]; told: () => void } {
    const none = { lines: [], told: () => undefined };
    const s = this.store.getSession(sessionId);
    if (!s || s.kind === "sub" || s.archivedAt) return none;
    try {
      return roleUpdate(this.host, sessionId);
    } catch {
      return none;
    }
  }

  async interrupt(sessionId: Id): Promise<void> {
    this.requireSession(sessionId);
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
  async startPeer(fromSessionId: Id, input: { text?: unknown; model?: unknown; title?: unknown; report?: unknown; workspace?: unknown; permission?: unknown; effort?: unknown }): Promise<Session> {
    const from = this.requireSession(fromSessionId);
    if (from.kind === "sub") throw new HostError("bad_request", "子 agent 不能开 AMO 会话：交给你的主会话来开。");
    if (!from.taskId) throw new HostError("bad_request", "你是专题会话，没有自己的任务：开任务要用 task_plan_propose 提案。");
    const task = this.requireTask(from.taskId);
    if (task.archivedAt) throw new HostError("read_only", "这个任务已归档，不能再开会话");
    const text = boundedText(input.text, "text", 20_000);
    const title = input.title === undefined || input.title === null || input.title === "" ? null : boundedText(input.title, "title", 100);
    const picked = typeof input.model === "string" && input.model.trim() ? await this.peerModel(input.model.trim()) : { profileId: from.profileId };
    const profileId = picked.profileId;
    const report = input.report === true;
    const workspace = input.workspace === undefined || input.workspace === null || input.workspace === "" ? this.requireLiveWorkspace(task.workspaceId) : this.workspaceByRef(input.workspace);
    let options: SessionOptions | undefined = picked.model ? { model: picked.model } : undefined;
    if (input.permission !== undefined && input.permission !== null && input.permission !== "") {
      const level = PERMISSION_LEVELS.find((l) => l === input.permission);
      if (!level) throw new HostError("bad_request", `permission must be one of: ${PERMISSION_LEVELS.join(", ")}`);
      options = { ...options, permission: PERMISSIONS[this.f.requireProfile(profileId).runtime][level] };
    }
    if (input.effort !== undefined && input.effort !== null && input.effort !== "") {
      if (typeof input.effort !== "string") throw new HostError("bad_request", "effort must be text, e.g. high");
      options = { ...options, effort: await this.peerEffort(profileId, picked.model, input.effort.trim()) };
    }
    const elsewhere = workspace.id !== task.workspaceId;
    const message = [
      `【由本任务的会话「${from.title || "未命名会话"}」开启】`,
      ...(elsewhere ? [`（你在项目「${isCommon(workspace) ? "公共目录" : workspace.name}」的文件夹 ${workspace.path} 里工作，和任务本身的项目不同。）`] : []),
      text,
      "",
      report
        ? `（这个会话是同一任务里的另一个会话（${from.id}）通过 AMO Studio 开的。每一轮做完后，你最后的回复会自动转给它（被人停下或出错时也会告诉它）；中途要告诉它什么，用 mailbox_send 给会话 ${from.id}。）`
        : `（这个会话是同一任务里的另一个会话（${from.id}）通过 AMO Studio 开的。要告诉它什么，用 mailbox_send 给会话 ${from.id}。）`,
    ].join("\n");
    const started = await this.f.tasks.startSession({ taskId: task.id, topicId: null }, workspace, { profileId, text: message, ...(options ? { options } : {}) });
    // 委派 (10-22): the session list shows it under the caller; otherwise it is a main session like any other.
    this.store.setSessionStartedBy(started.id, from.id);
    const session = report ? this.store.setSessionReportTo(started.id, from.id) : this.store.getSession(started.id)!;
    this.publish({ type: "session.upserted", session });
    const named = title ? await this.renameSession(session.id, title).catch(() => session) : session;
    // A quick turn may have ended before the session was marked.
    if (report) this.checkReport(this.requireSession(named.id));
    return named;
  }

  /**
   * session_start's effort (2026-10-26, an agent could not set it): checked against the model the new session will run
   * (the person's default in 设置 → 模型, else the CLI's), as its CLI names them; unchecked when the list cannot be had.
   */
  private async peerEffort(profileId: Id, chosen: string | undefined, want: string): Promise<string> {
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
   * session_start's model (2026-10-26: 「@ 开子会话」 picks a model of an account, not only the account): a model
   * profile as amo_whoami names it; or "<profile>/<model>", one of that profile's models by id or name; or a model's id
   * or name in any profile's list (the first profile that has it).
   */
  private async peerModel(ref: string): Promise<{ profileId: Id; model?: string }> {
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
  private workspaceByRef(ref: unknown): Workspace {
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
      if (e.type === "session.upserted" && e.session.reportTo) this.checkReport(e.session);
    });
  }

  private checkReport(s: Session): void {
    if (!s.reportTo || s.archivedAt || !(s.status === "idle" || s.status === "completed" || s.status === "error")) return;
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
    void this.sendMessage(to, text).catch(() => {
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
const PERMISSIONS: Record<Session["runtime"], Record<(typeof PERMISSION_LEVELS)[number], string>> = {
  codex: { "read-only": "read-only", write: "workspace-write", full: "full-auto" },
  claude: { "read-only": "plan", write: "acceptEdits", full: "bypassPermissions" },
  dsh: { "read-only": "read-only", write: "workspace-write", full: "full-access" },
};

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
