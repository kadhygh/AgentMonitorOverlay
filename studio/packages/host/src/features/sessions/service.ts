import { resolve } from "node:path";
import { formContent, type SessionOptions, type ApprovalDecision, type Id, type QuestionAnswer, type QuestionReply, type Session, type SessionItem, type TerminalAttach } from "@amo-studio/protocol";
import type { SendMode } from "../../runtime/runtime.js";
import type { TerminalHandle } from "../../terminal/launcher.js";
import { HostError, optionValue, boundedText, TERMINAL_TOKEN_ENV } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

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
    return this.wrap(() => this.runtime.setOptions(sessionId, next));
  }

  items(sessionId: Id, afterSeq = 0): SessionItem[] {
    this.requireSession(sessionId);
    return this.store.listItems(sessionId, afterSeq);
  }

  /** `attachments`: ids of uploaded images to send along; with some, the text may be empty. */
  async sendMessage(sessionId: Id, text: string, attachments: readonly Id[] = []): Promise<{ mode: SendMode }> {
    this.requireSession(sessionId);
    if (attachments.length > MAX_MESSAGE_IMAGES) throw new HostError("bad_request", `at most ${MAX_MESSAGE_IMAGES} images per message`);
    const images = [...new Set(attachments)].map((id) => {
      try {
        return this.f.attachments.get(id);
      } catch {
        throw new HostError("bad_request", `attachment ${id} not found`);
      }
    });
    if (!text?.trim() && !images.length) throw new HostError("bad_request", "text is required");
    return this.wrap(() => this.runtime.sendMessage(sessionId, text ?? "", images));
  }

  async interrupt(sessionId: Id): Promise<void> {
    this.requireSession(sessionId);
    await this.wrap(() => this.runtime.interrupt(sessionId));
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
      (reply.action === "answer" && (item.source === "claude-ask" || item.source === "codex-input")) ||
      (reply.action === "submit" && item.source === "mcp-form") ||
      ((reply.action === "approve" || reply.action === "revise") && item.source === "plan-review");
    if (!fits) throw new HostError("bad_request", `a ${item.source} question cannot take "${reply.action}"`);
    if (reply.action === "submit") {
      const checked = formContent(item.form ?? [], reply.values);
      if ("error" in checked) throw new HostError("bad_request", checked.error);
    }
    await this.wrap(() => this.runtime.answerQuestion(sessionId, itemId, reply), "conflict");
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
}

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
