import { EventEmitter } from "node:events";
import type { ApprovalDecision, Attachment, Id, McpApply, ProfileChoices, QuestionReply, Session, SlashCommandList, SlashCommandResult } from "@amo-studio/protocol";
import type { RuntimeEvents, SendMode, SendOptions, SessionRuntimeApi } from "../../runtime/runtime.js";
import { HostError } from "../../core/shared.js";
import type { RemoteCopies } from "./copies.js";

// 远程, step 2 (2026-10-29): "remote" as one more way a session runs, beside Codex, Claude and DSH. This runtime sends
// the sessions of copies (runtime "remote") to the paired device they run on. What a copy cannot do here (Git Review, a
// terminal, its model) is refused with a reason the person can read. Since 2026-11-05 (plans/host-structure.md
// 8a) it is registered in the RuntimeRouter like the others — HostService does it — instead of wrapping the router and
// asking of every call whether its session is a copy: only copies' sessions and models reach it.

const no = (what: string) => new HostError("read_only", `远程任务的会话不能在这台电脑上${what}：任务在授权它的电脑上运行，那边才能做`);

export class RemoteRuntime extends EventEmitter<RuntimeEvents> implements SessionRuntimeApi {
  constructor(private readonly copies: () => RemoteCopies) {
    super();
  }

  startSession(): Promise<Session> {
    // New sessions of a copy are started by TasksFeature through RemoteFeature (they need the task's grant).
    throw no("这样开会话");
  }
  /** A copy's models are A's: nothing to pick here (ConfigFeature answers so before it asks a runtime). */
  async choices(profileId: Id): Promise<ProfileChoices> {
    return { profileId, models: [], permissions: [], defaultPermission: "", source: "builtin" };
  }
  setOptions(): Promise<Session> {
    throw no("换模型或权限");
  }
  rename(sessionId: Id, title: string): Promise<Session> {
    return this.copies().renameSession(sessionId, title);
  }
  sendMessage(sessionId: Id, text: string, images: readonly Attachment[] = [], options: SendOptions = {}) {
    return this.copies().send(sessionId, text, images, options);
  }
  /** 立即发送 and 重新发送 (2026-11-02): done on A (the copy's items carry A's ids). */
  sendNow(sessionId: Id, itemId: Id): Promise<void> {
    return this.copies().sendNow(sessionId, itemId);
  }
  resend(sessionId: Id, itemId: Id): Promise<{ mode: SendMode }> {
    return this.copies().resend(sessionId, itemId);
  }
  interrupt(sessionId: Id): Promise<void> {
    return this.copies().interrupt(sessionId);
  }
  /** 分支 of a copy (2026-11-12) goes to A before a runtime is asked (SessionsFeature.fork → RemoteCopies.fork). */
  fork(): Promise<Session> {
    throw no("分支");
  }
  archive(sessionId: Id): Promise<Session[]> {
    return this.copies().archive(sessionId, true);
  }
  unarchive(sessionId: Id): Promise<Session[]> {
    return this.copies().archive(sessionId, false);
  }
  respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void> {
    return this.copies().approve(sessionId, approvalId, decision);
  }
  answerQuestion(sessionId: Id, itemId: Id, reply: QuestionReply): Promise<void> {
    return this.copies().answer(sessionId, itemId, reply);
  }
  attachInfo(): Promise<{ url: string; token: string; threadId: string }> {
    throw no("在终端打开");
  }
  setWriter(): Session {
    throw no("在终端打开");
  }
  handoff(): Promise<{ command: string; cwd: string; env: Record<string, string> }> {
    throw no("交给终端");
  }
  reclaim(): Promise<Session> {
    throw no("收回");
  }
  async listCommands(): Promise<SlashCommandList> {
    return { commands: [] };
  }
  runCommand(): Promise<SlashCommandResult> {
    throw no("运行命令");
  }
  stopBackground(): Promise<void> {
    throw no("停后台命令");
  }
  setWakeChoice(): Promise<Session> {
    throw no("改循环");
  }
  /** A copy's MCP is the computer it runs on's business. */
  async refreshMcp(): Promise<McpApply> {
    return "not-running";
  }
  async mcpStatus(): Promise<null> {
    return null;
  }
}
