import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { projectWorkspaces, REMOTE_FORK_SINCE, REMOTE_SEND_NOW_SINCE, type ApprovalDecision, type DecisionRequest, type ModelProfile, type Session, type StudioSettings, type SubsessionSetup, type Task, type Topic, type Workspace } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useSessionItems } from "../host/useSessionItems.js";
import { useAnnotations } from "../review/useAnnotations.js";
import { useAnnotationRefs } from "../review/annotationRefs.js";
import { shortModel } from "../lib/profiles.js";
import { sessionModelName, useProfileChoices } from "../lib/choices.js";
import { experimentalOn } from "../lib/features.js";
import { showToast } from "../lib/toast.js";
import { bookmarkPassage } from "../marks/open.js";
import { BookmarkCancelled } from "../marks/NotePrompt.js";
import { FileLinks, type PreviewTarget } from "../files/FileLinks.js";
import type { DeliveryAction } from "../chat/Transcript.js";
import type { CopyStatus } from "../remote/remote.js";
import { Thread } from "./Thread.js";
import type { ReadPlace } from "./readPlace.js";

// One session's conversation and composer with everything they do wired (2026-11-16, split out of TaskPage.tsx): the
// task page's conversation, and the 会话弹窗 window of 脉络's building (tracks/RoundApp.tsx), are the same thing — sending,
// approving, 立即发送, 分支, annotating, bookmarking, a remote task's copy — so they share this, not a copy of it.

/** The session's rows, its annotations (a plan's left out: they go with the plan window's 要修改) and which the next message refers to. */
export function useSessionData(link: HostLink, sessionId: string | null) {
  const { items } = useSessionItems(link, sessionId);
  const allAnnotations = useAnnotations(link, sessionId);
  // A plan's annotations are the plan window's: they go with its 要修改, not from here (2026-11-09).
  const annotations = useMemo(() => {
    const plans = new Set(items.filter((i) => i.type === "question" && i.source === "plan-review").map((i) => i.id));
    return plans.size ? allAnnotations.filter((a) => !plans.has(a.itemId)) : allAnnotations;
  }, [allAnnotations, items]);
  const annotationRefs = useAnnotationRefs(sessionId, annotations);
  return { items, annotations, annotationRefs };
}

export type SessionData = ReturnType<typeof useSessionData>;

/** The runtime a session really runs on: a copy's, as the computer it runs on says (远程分支, 2026-11-12). */
export function sessionRuntime(task: Task, s: Session | null): Session["runtime"] | undefined {
  return s?.runtime === "remote" ? task.remote?.profiles.find((p) => p.id === s.profileId)?.runtime : s?.runtime;
}

/** Why 分支 is greyed on a copy whose computer runs an older Studio (it does not fork from here). */
export function forkOffOf(task: Task, copy: CopyStatus | null): string | undefined {
  return copy && !task.remote?.fork ? `${copy.name} 上的 Studio 要更新到 ${REMOTE_FORK_SINCE} 或更新的版本，才能从这台电脑开分支` : undefined;
}

/** Whether the session can be branched from here (远程分支 2026-11-12: a copy's on the computer it runs on, as its runtime there allows). */
export function canFork(task: Task, copy: CopyStatus | null, session: Session | null): boolean {
  const runtime = sessionRuntime(task, session);
  return !!session && !session.archivedAt && runtime !== "dsh" && !(runtime === "claude" && session.kind === "sub") && !!session.runtimeRef && (copy ? session.kind !== "sub" && copy.state !== "revoked" : session.runtime !== "remote");
}

interface SessionThreadProps {
  link: HostLink;
  task: Task;
  session: Session | null;
  sessions: readonly Session[];
  tasks: readonly Task[];
  workspaces: readonly Workspace[];
  topics: readonly Topic[];
  profiles: readonly ModelProfile[];
  settings: StudioSettings | null | undefined;
  /** 远程: the task is a copy of one another computer granted this one. */
  copy: CopyStatus | null;
  data: SessionData;
  /** Open decisions (all of them; this session's are picked here). */
  decisions: readonly DecisionRequest[];
  busy: boolean;
  /** Runs a Host call; its failure is shown (and `busy` is the caller's while it runs). */
  run<T>(fn: () => Promise<T>): Promise<void>;
  onError(text: string): void;
  /** Another session named in the conversation (a sub-session's row, its report). */
  onJump(sessionId: string): void;
  /** 分支 from a turn: the caller asks from which turn and what the new session is (ForkDialog). */
  onForkTurn(sessionId: string, turnId: string): void;
  /** 在侧栏预览 a file named in the conversation. */
  onPreview(target: PreviewTarget): void;
  /** Over the conversation, in its place (脉络的楼); the composer stays under it. */
  cover?: ReactNode;
  /** The composer is in a 会话弹窗 window: a line in its place says so, and `onShow` brings that window forward. */
  composerAway?: { onShow(): void };
  /** The conversation is a small window of its own (the 会话弹窗): the annotation bubble keeps itself in sight. */
  shortView?: boolean;
  initialScroll?: ReadPlace;
  atPassage?: boolean;
}

export function SessionThread({ link, task, session, sessions, tasks, workspaces, topics, profiles, settings, copy, data, decisions, busy, run, onError, onJump, onForkTurn, onPreview, cover, composerAway, shortView = false, initialScroll, atPassage = false }: SessionThreadProps) {
  const { items, annotations, annotationRefs } = data;
  const profile = (id: string) => profiles.find((p) => p.id === id);
  // The model by name ("GPT-6.1 Sol", "Opus 5.5"), also when it is the profile's default.
  const { choices } = useProfileChoices(link, session?.profileId);
  const modelText = session ? sessionModelName(choices, session.options) : null;
  const forkRuntime = sessionRuntime(task, session);
  const forkOff = forkOffOf(task, copy);
  // 立即发送 likewise (2026-11-12): before, its command never got through the relay; an older one never heard it.
  const sendNowOff = copy && !task.remote?.sendNow ? `${copy.name} 上的 Studio 要更新到 ${REMOTE_SEND_NOW_SINCE} 或更新的版本，才能从这台电脑立即发送` : undefined;
  const forkSessionId = canFork(task, copy, session) ? session!.id : null;
  const forkCall = useRef(onForkTurn);
  forkCall.current = onForkTurn;
  const forkTurn = useCallback((turnId: string) => forkSessionId && forkCall.current(forkSessionId, turnId), [forkSessionId]);

  /** A save from the annotation bubble: true once stored, else the error as a notice (the bubble keeps the draft). */
  async function annotationCall(fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      onError(err instanceof HostApiError ? err.message : String(err));
      return false;
    }
  }
  const approve = (approvalId: string, decision: ApprovalDecision) => (session ? run(() => call(link, "POST /api/approvals/:approvalId", { approvalId }, { sessionId: session.id, decision })) : Promise.resolve());
  async function send(text: string, attachments: string[], now = false, subsessions: SubsessionSetup[] = []): Promise<boolean> {
    if (!session) return false;
    try {
      const referred = annotationRefs.list.map((a) => a.id);
      await call(link, "POST /api/sessions/:id/messages", { id: session.id }, { text, ...(attachments.length ? { attachments } : {}), ...(referred.length ? { annotations: referred } : {}), ...(now ? { now: true } : {}), ...(subsessions.length ? { subsessions } : {}) });
      annotationRefs.sent();
      return true;
    } catch (err) {
      onError(err instanceof HostApiError ? err.message : String(err));
      return false;
    }
  }
  /** 立即发送 a waiting message, 重新发送 one never read (2026-11-02). */
  const deliver = (itemId: string, action: DeliveryAction) => {
    if (!session) return;
    const id = session.id;
    void run(async () => {
      if (action === "now") await call(link, "POST /api/sessions/:id/items/:itemId/send-now", { id, itemId });
      else await call(link, "POST /api/sessions/:id/items/:itemId/resend", { id, itemId });
    });
  };
  const bookmark = (anchor: Parameters<typeof bookmarkPassage>[2]) => {
    if (!session) return;
    bookmarkPassage(link, session.id, anchor)
      .then((r) => {
        const where = topics.find((t) => t.id === r.mark.topicId)?.title ?? "未归专题";
        showToast({ text: r.created ? `书签添加成功：已加到「${where}」` : `这段已经在「${where}」的书签里` });
      })
      .catch((err: unknown) => {
        if (!(err instanceof BookmarkCancelled)) onError(`加书签失败：${err instanceof HostApiError ? err.message : String(err)}`);
      });
  };

  return (
    <FileLinks link={link} workspaceId={session?.workspaceId ?? task.workspaceId} sessionId={session?.id ?? null} onPreview={onPreview} onError={onError} {...(copy ? { remoteTask: task.id } : {})}>
      <Thread
        link={link}
        {...(copy ? { remote: { blocked: copy.blocked, revoked: copy.state === "revoked" } } : {})}
        presets={settings?.presets ?? []}
        session={session}
        {...(task.firstMessage ? { firstMessage: task.firstMessage } : {})}
        {...(session && profile(session.profileId) ? { profile: profile(session.profileId)! } : {})}
        profiles={profiles}
        subsessionNotes={settings?.subsessionNotes ?? []}
        tasks={tasks}
        sessions={sessions}
        // A remote task runs on the other computer: this one's projects mean nothing there.
        {...(copy ? {} : { projects: projectWorkspaces(workspaces) })}
        items={items}
        model={modelText ?? shortModel(session ? profile(session.profileId) : undefined)}
        busy={busy}
        onApprove={(item, decision) => void approve(item.approvalId, decision)}
        onJump={onJump}
        onSend={send}
        onInterrupt={() => session && void run(() => call(link, "POST /api/sessions/:id/interrupt", { id: session.id }))}
        onDelivery={deliver}
        {...(sendNowOff ? { sendNowOff } : {})}
        typingHold={experimentalOn(settings?.experimentalFeatures, "typing-hold")}
        reviewProgress={experimentalOn(settings?.experimentalFeatures, "review-progress")}
        {...(cover ? { cover } : {})}
        {...(composerAway ? { composerAway } : {})}
        shortView={shortView}
        {...(forkSessionId ? { onFork: forkTurn, ...(forkRuntime ? { forkRuntime } : {}), ...(forkOff ? { forkOff } : {}) } : {})}
        onSaveAnnotation={(anchor, note) => annotationCall(() => call(link, "POST /api/sessions/:id/annotations", { id: session!.id }, { ...anchor, note }))}
        onEditAnnotation={(id, note) => annotationCall(() => call(link, "PATCH /api/annotations/:id", { id }, { note }))}
        onDeleteAnnotation={(id) => void run(() => call(link, "DELETE /api/annotations/:id", { id }))}
        onBookmark={bookmark}
        {...(initialScroll !== undefined ? { initialScroll } : {})}
        atPassage={atPassage}
        onError={onError}
        annotations={annotations}
        annotationRefs={annotationRefs}
        decisions={session ? decisions.filter((d) => d.sessionId === session.id) : []}
      />
    </FileLinks>
  );
}
