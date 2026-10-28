import type { ApprovalDecision, Attachment, ChatSettings, HostEvent, Id, QuestionReply, Session, SessionOptions, SlashCommandList, SlashCommandResult } from "@amo-studio/protocol";
import { parseRemoteProfileId } from "@amo-studio/protocol";
import type { SessionRuntimeApi } from "../../runtime/runtime.js";
import type { Store } from "../../store/store.js";
import { HostError } from "../../core/shared.js";
import type { RemoteCopies } from "./copies.js";

// 远程, step 2 (2026-10-29): "remote" as one more way a session runs, beside Codex, Claude and DSH. The Host's features
// call one runtime; this one sends the sessions of copies (runtime "remote") to the paired device they run on, and every
// other session to the runtimes of this computer. What a copy cannot do here (Git Review, a terminal, a branch, its
// model or name, archiving it alone) is refused with a reason the person can read.

const no = (what: string) => new HostError("read_only", `远程任务的会话不能在这台电脑上${what}：任务在授权它的电脑上运行，那边才能做`);

export class RemoteAwareRuntime implements SessionRuntimeApi {
  constructor(
    private readonly store: Store,
    private readonly inner: SessionRuntimeApi,
    private readonly copies: () => RemoteCopies,
  ) {
    // What the runtimes here do not offer, this one does not either (features ask whether a runtime has it).
    const optional = ["usage", "handoff", "reclaim", "listCommands", "runCommand", "stopBackground", "setWakeChoice", "applyChatSettings"] as const;
    for (const k of optional) if (!inner[k]) (this as unknown as Record<string, unknown>)[k] = undefined;
  }

  private remote(sessionId: Id): boolean {
    return this.store.getSession(sessionId)?.runtime === "remote";
  }

  startSession(input: Parameters<SessionRuntimeApi["startSession"]>[0]): Promise<Session> {
    // New sessions of a copy are started by TasksFeature through RemoteFeature (they need the task's grant).
    if (parseRemoteProfileId(input.profileId)) throw no("这样开会话");
    return this.inner.startSession(input);
  }
  choices(profileId: Id) {
    return this.inner.choices(profileId);
  }
  setOptions(sessionId: Id, options: SessionOptions): Promise<Session> {
    if (this.remote(sessionId)) throw no("换模型或权限");
    return this.inner.setOptions(sessionId, options);
  }
  rename(sessionId: Id, title: string): Promise<Session> {
    if (this.remote(sessionId)) throw no("改名");
    return this.inner.rename(sessionId, title);
  }
  sendMessage(sessionId: Id, text: string, images: readonly Attachment[] = []) {
    if (this.remote(sessionId)) return this.copies().send(sessionId, text, images);
    return this.inner.sendMessage(sessionId, text, images);
  }
  interrupt(sessionId: Id): Promise<void> {
    if (this.remote(sessionId)) return this.copies().interrupt(sessionId);
    return this.inner.interrupt(sessionId);
  }
  fork(sessionId: Id, profileId?: Id): Promise<Session> {
    if (this.remote(sessionId)) throw no("分支");
    return this.inner.fork(sessionId, profileId);
  }
  archive(sessionId: Id): Promise<Session[]> {
    if (this.remote(sessionId)) throw no("单独归档（归档整个任务会清掉这台电脑上的副本）");
    return this.inner.archive(sessionId);
  }
  unarchive(sessionId: Id): Promise<Session[]> {
    if (this.remote(sessionId)) throw no("恢复");
    return this.inner.unarchive(sessionId);
  }
  respondApproval(sessionId: Id, approvalId: string, decision: ApprovalDecision): Promise<void> {
    if (this.remote(sessionId)) return this.copies().approve(sessionId, approvalId, decision);
    return this.inner.respondApproval(sessionId, approvalId, decision);
  }
  answerQuestion(sessionId: Id, itemId: Id, reply: QuestionReply): Promise<void> {
    if (this.remote(sessionId)) return this.copies().answer(sessionId, itemId, reply);
    return this.inner.answerQuestion(sessionId, itemId, reply);
  }
  usage(profileId: Id, refresh: boolean) {
    if (parseRemoteProfileId(profileId) || !this.inner.usage) return Promise.resolve(null);
    return this.inner.usage(profileId, refresh);
  }
  attachInfo(sessionId: Id) {
    if (this.remote(sessionId)) throw no("在终端打开");
    return this.inner.attachInfo(sessionId);
  }
  setWriter(sessionId: Id, writer: Session["writer"]): Session {
    if (this.remote(sessionId)) throw no("在终端打开");
    return this.inner.setWriter(sessionId, writer);
  }
  handoff(sessionId: Id) {
    if (this.remote(sessionId)) throw no("交给终端");
    if (!this.inner.handoff) throw new Error("this runtime does not hand sessions to a terminal");
    return this.inner.handoff(sessionId);
  }
  reclaim(sessionId: Id): Promise<Session> {
    if (this.remote(sessionId)) throw no("收回");
    return this.inner.reclaim ? this.inner.reclaim(sessionId) : Promise.resolve(this.inner.setWriter(sessionId, "workbench"));
  }
  async listCommands(sessionId: Id): Promise<SlashCommandList> {
    if (this.remote(sessionId) || !this.inner.listCommands) return { commands: [] };
    return this.inner.listCommands(sessionId);
  }
  runCommand(sessionId: Id, name: string, args: string): Promise<SlashCommandResult> {
    if (this.remote(sessionId)) throw no("运行命令");
    if (!this.inner.runCommand) throw new Error("this runtime has no commands");
    return this.inner.runCommand(sessionId, name, args);
  }
  stopBackground(sessionId: Id, taskId: string): Promise<void> {
    if (this.remote(sessionId)) throw no("停后台命令");
    if (!this.inner.stopBackground) throw new Error("this runtime has no background commands");
    return this.inner.stopBackground(sessionId, taskId);
  }
  setWakeChoice(sessionId: Id, choice: { stopLoop?: boolean; autoContinue?: boolean }): Promise<Session> {
    if (this.remote(sessionId)) throw no("改循环");
    if (!this.inner.setWakeChoice) throw new Error("this runtime has no loop");
    return this.inner.setWakeChoice(sessionId, choice);
  }
  applyChatSettings(settings: ChatSettings): void {
    this.inner.applyChatSettings?.(settings);
  }
  on(event: "event", listener: (e: HostEvent) => void): this;
  on(event: "log", listener: (line: string) => void): this;
  on(event: "event" | "log", listener: ((e: HostEvent) => void) | ((line: string) => void)): this {
    this.inner.on(event as "event", listener as (e: HostEvent) => void);
    return this;
  }
}
