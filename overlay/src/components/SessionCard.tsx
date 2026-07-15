import type { PointerEvent } from "react";
import {
  AlertTriangle,
  Bot,
  CircleCheck,
  Crosshair,
  FileText,
  ListFilter,
  Map as MapIcon,
  Plus,
  RotateCcw,
  Settings2,
  SquareTerminal,
  Unlink2,
} from "lucide-react";
import claudeCliIcon from "../assets/tool-icons/claude-cli.png";
import codexAppIcon from "../assets/tool-icons/codex-app.png";
import codexCliIcon from "../assets/tool-icons/codex-cli.png";
import {
  sessionArchived,
  sessionNeedsReview,
  formatAgo,
} from "../domain/sessionModel";
import {
  canvasPathForOpen,
  isCodexSession,
  notePathForOpen,
  projectName,
  targetBindingForSession,
  targetLabelForSession,
  toolDisplayIdForSession,
  type ToolDisplayId,
} from "../domain/routingModel";
import {
  maintenanceTitleForSession,
  maintenanceToneForSession,
  type LaunchPanelAdapterId,
} from "../domain/workspaceModel";
import type { AgentSession, SessionState } from "../types";

const stateLabel: Record<SessionState, string> = {
  starting: "Starting",
  running: "Running",
  waiting_permission: "Permission",
  waiting_user: "User",
  idle: "Idle",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "Unknown",
};

type ToolDisplay = { label: string; icon: string | null; badge?: string };

const toolDisplay: Record<ToolDisplayId, ToolDisplay> = {
  "codex-cli": {
    label: "Codex CLI",
    icon: codexCliIcon,
    badge: "CLI",
  },
  "codex-app": {
    label: "ChatGPT",
    icon: codexAppIcon,
  },
  "claude-cli": {
    label: "Claude CLI",
    icon: claudeCliIcon,
    badge: "CLI",
  },
  other: {
    label: "Agent",
    icon: null,
  },
};

export function toolDisplayForSession(session: AgentSession) {
  return toolDisplay[toolDisplayIdForSession(session)];
}

function toolDisplayIdForLaunchAdapter(adapterId: LaunchPanelAdapterId): ToolDisplayId {
  return adapterId;
}

function ToolMark({ session }: { session: AgentSession }) {
  const displayId = toolDisplayIdForSession(session);
  const display = toolDisplay[displayId];

  return (
    <span className={`tool-mark tool-${displayId}`} title={display.label}>
      {display.icon ? <img src={display.icon} alt="" aria-hidden="true" /> : <Bot size={18} strokeWidth={2.1} aria-hidden="true" />}
      {display.badge ? <span className="tool-badge">{display.badge}</span> : null}
    </span>
  );
}

export function LaunchToolMark({ adapterId }: { adapterId: LaunchPanelAdapterId }) {
  const displayId = toolDisplayIdForLaunchAdapter(adapterId);
  const display = toolDisplay[displayId];

  return (
    <span className={`launch-tool-mark tool-${displayId}`} title={display.label}>
      {display.icon ? <img src={display.icon} alt="" aria-hidden="true" /> : <Bot size={18} strokeWidth={2.1} aria-hidden="true" />}
      {display.badge ? <span className="tool-badge">{display.badge}</span> : null}
    </span>
  );
}

interface SessionRowContentProps {
  session: AgentSession;
  activating: boolean;
  openingTarget: "note" | "canvas" | null;
  unbindingWindow: boolean;
  archiving: boolean;
  reviewing: boolean;
  dismissing: boolean;
  attentionSignal: boolean;
  attentionVisualActive: boolean;
  onOpenNote: () => void;
  onOpenCanvas: () => void;
  onMarkReviewed: () => void;
  onUnbindWindow: () => void;
  onArchive: () => void;
  onDismiss: () => void;
  onOpenCodexAppTarget: () => void;
  onActivateSession: () => void;
  onResumeSession: () => void;
  onHandleAttention: () => void;
  onOpenLaunchPanel: (x: number, y: number) => void;
  onOpenWorkspacePanel: (x: number, y: number) => void;
  onStartWindowBindDrag: (event: PointerEvent<HTMLButtonElement>) => void;
  windowBindDragging: boolean;
}

export function SessionRowContent({
  session,
  activating,
  openingTarget,
  unbindingWindow,
  archiving,
  reviewing,
  dismissing,
  attentionSignal,
  attentionVisualActive,
  onOpenNote,
  onOpenCanvas,
  onMarkReviewed,
  onUnbindWindow,
  onArchive,
  onDismiss,
  onOpenCodexAppTarget,
  onActivateSession,
  onResumeSession,
  onHandleAttention,
  onOpenLaunchPanel,
  onOpenWorkspacePanel,
  onStartWindowBindDrag,
  windowBindDragging,
}: SessionRowContentProps) {
  const notePath = notePathForOpen(session);
  const canvasPath = canvasPathForOpen(session);
  const managedConnected = Boolean(session.launchId && session.launchState === "connected" && session.windowHint?.titleToken);
  const managedOffline = Boolean(session.launchId && session.launchState === "offline");
  const managedLaunching = Boolean(session.launchId && ["created", "spawning", "waiting_hook", "launching"].includes(session.launchState || ""));
  const windowBound = Boolean(session.windowHint?.hwnd || session.windowHint?.pid || managedConnected);
  const targetBinding = targetBindingForSession(session);
  const targetBound = Boolean(targetBinding);
  const rawTool = String(session.tool || "").toLowerCase();
  const supportsManagedResume = rawTool.includes("codex") || rawTool.includes("claude");
  const canResumeAsManaged =
    supportsManagedResume &&
    !targetBound &&
    !managedConnected &&
    !managedLaunching &&
    (managedOffline || !session.launchId);
  const canOpenCodexAppAlternative = canResumeAsManaged && isCodexSession(session);
  const canUnbindTarget = Boolean(targetBinding && targetBinding.type !== "codex-cli-session");
  const canBindWindow = (!targetBinding || targetBinding.type === "codex-cli-session") && !managedConnected;
  const archived = sessionArchived(session);
  const archiveActionBusy = archiving || dismissing;
  const codexAppAvailable = isCodexSession(session);
  const needsTargetChoice = codexAppAvailable && !targetBound && !managedConnected && !managedOffline && !managedLaunching;
  const noteOpening = openingTarget === "note";
  const canvasOpening = openingTarget === "canvas";
  const waitingForPermission = session.state === "waiting_permission";
  const failed = session.state === "failed";
  const reviewPending = sessionNeedsReview(session);
  const attentionTone = reviewPending ? "review" : waitingForPermission ? "permission" : failed ? "failed" : "attention";
  const display = toolDisplayForSession(session);
  const statusLabel = activating
    ? "Opening"
    : managedLaunching
    ? "Launching"
    : managedOffline
    ? "Offline"
    : reviewPending
    ? "Review"
    : stateLabel[session.state];
  const maintenanceTone = maintenanceToneForSession(session);
  const sessionProjectName = projectName(session.cwd);
  const threadTitle = session.title?.trim() || sessionProjectName;
  const taskTitle = session.taskTitle?.trim() || "";
  const conversationTitle = taskTitle || threadTitle;
  const subtitleLabel = `${sessionProjectName} · ${statusLabel} · ${display.label} · ${formatAgo(session.updatedAt)}`;

  return (
    <span className="session-main">
      <button
        type="button"
        className="card-launch-button"
        title="Launch a new CLI for this project"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenLaunchPanel(event.clientX, event.clientY);
        }}
      >
        <Plus size={13} aria-hidden="true" />
      </button>
      {canResumeAsManaged ? (
        <button
          type="button"
          className={`card-managed-launch-button ${activating ? "is-busy" : ""}`}
          title="Resume this session in a new AMO-managed CLI"
          aria-label={`Resume ${session.title} in a managed CLI`}
          aria-busy={activating}
          disabled={activating}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onResumeSession();
          }}
        >
          <SquareTerminal size={13} aria-hidden="true" />
        </button>
      ) : null}
      {canOpenCodexAppAlternative ? (
        <button
          type="button"
          className={`card-codex-app-launch-button ${activating ? "is-busy" : ""}`}
          title="Open this task in ChatGPT"
          aria-label={`Open ${session.title} in ChatGPT`}
          aria-busy={activating}
          disabled={activating}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenCodexAppTarget();
          }}
        >
          <Bot size={13} aria-hidden="true" />
        </button>
      ) : null}
      {canBindWindow ? (
        <button
          type="button"
          className={`card-bind-drag-button ${windowBindDragging ? "is-dragging" : ""}`}
          title="Drag to a CLI or app window to bind this card"
          aria-label={`Drag ${session.title} to a target window`}
          aria-pressed={windowBindDragging}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onStartWindowBindDrag(event);
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <Crosshair size={13} aria-hidden="true" />
        </button>
      ) : null}
      <button
        type="button"
        className={`card-maintenance-button tone-${maintenanceTone}`}
        title={maintenanceTitleForSession(session)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenWorkspacePanel(event.clientX, event.clientY);
        }}
      >
        <Settings2 size={13} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`card-archive-button ${archiveActionBusy ? "is-busy" : ""} ${archived ? "is-final-hide" : ""}`}
        title={archived ? "Hide this archived card" : "Archive this card"}
        aria-label={archived ? `Hide archived ${session.title}` : `Archive ${session.title}`}
        aria-busy={archiveActionBusy}
        disabled={archiveActionBusy}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (archived) {
            onDismiss();
          } else {
            onArchive();
          }
        }}
      >
        <span aria-hidden="true">A</span>
      </button>
      <span className="session-head">
        <ToolMark session={session} />
        <span className="session-title">
          <span className="session-title-primary">
            {attentionSignal ? (
              <span
                className={`title-attention-beacon tone-${attentionTone} ${
                  attentionVisualActive ? "is-active" : "is-static"
                }`}
                aria-hidden="true"
              />
            ) : null}
            <strong title={conversationTitle}>{conversationTitle}</strong>
          </span>
          {taskTitle ? (
            <span className="session-title-subtitle" title={threadTitle}>
              {threadTitle}
            </span>
          ) : null}
        </span>
        <span className="session-chip-row" title={subtitleLabel}>
          <span className="state-pill">
            <span className="state-dot" aria-hidden="true" />
            <span>{statusLabel}</span>
          </span>
          <span className="session-inline-meta">
            <span className="session-info-project">{sessionProjectName}</span>
            <span className="session-meta-separator">·</span>
            <span>
              {display.label} · {formatAgo(session.updatedAt)}
            </span>
          </span>
        </span>
      </span>
      <span className="session-body">
        <span className="message-line">{session.lastMessage}</span>
        <span className="session-meta">
          <span className="event-line">{session.lastEvent}</span>
          <span className="session-tags">
            {waitingForPermission ? (
              <span className="session-tag tag-attention" title="Open the target CLI to handle the permission request">
                Needs attention
              </span>
            ) : null}
            {reviewPending ? (
              <span className="session-tag tag-review" title="New reply is ready to review">
                Review
              </span>
            ) : null}
            {windowBound && !targetBound ? (
              <span className="session-tag" title={session.windowHint?.boundLabel ?? session.windowHint?.title ?? session.title}>
                {managedConnected ? "Managed CLI" : "Window hint"}
              </span>
            ) : null}
            {targetBound ? (
              <span className="session-tag target-tag" title={targetBinding?.label ?? targetLabelForSession(session)}>
                Target: {targetLabelForSession(session)}
              </span>
            ) : null}
            {managedOffline ? (
              <span className="session-tag" title="This session is not the current session in its previous managed CLI">
                Offline
              </span>
            ) : null}
          </span>
        </span>
        {reviewPending || notePath || canvasPath || targetBound || managedConnected || managedOffline || managedLaunching || waitingForPermission || failed || codexAppAvailable ? (
          <span className="bridge-actions" aria-label="Bridge actions">
            {reviewPending ? (
              <button
                type="button"
                className={`row-tool-button review-button ${reviewing ? "is-busy" : ""}`}
                aria-busy={reviewing}
                title="Mark this reply as reviewed"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onMarkReviewed();
                }}
              >
                <CircleCheck size={13} aria-hidden="true" />
                <span>Seen</span>
              </button>
            ) : null}
            {waitingForPermission || failed ? (
              <button
                type="button"
                className={`row-tool-button attention-action-button tone-${failed ? "failed" : "permission"} ${
                  activating ? "is-busy" : ""
                }`}
                aria-busy={activating}
                title={failed ? "Open target to inspect this failed run" : "Open target to handle the permission request"}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (waitingForPermission) {
                    onHandleAttention();
                  } else {
                    onActivateSession();
                  }
                }}
              >
                {failed ? <AlertTriangle size={13} aria-hidden="true" /> : <SquareTerminal size={13} aria-hidden="true" />}
                <span>{failed ? "Inspect" : "Handle"}</span>
              </button>
            ) : null}
            {notePath ? (
              <button
                type="button"
                className={`row-tool-button ${noteOpening ? "is-busy" : ""}`}
                aria-busy={noteOpening}
                title={`Open note: ${session.lastReplyNote ?? notePath}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenNote();
                }}
              >
                <FileText size={13} aria-hidden="true" />
                <span>Note</span>
              </button>
            ) : null}
            {canvasPath ? (
              <button
                type="button"
                className={`row-tool-button ${canvasOpening ? "is-busy" : ""}`}
                aria-busy={canvasOpening}
                title={`Open canvas: ${session.canvasPath ?? canvasPath}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenCanvas();
                }}
              >
                <MapIcon size={13} aria-hidden="true" />
                <span>Canvas</span>
              </button>
            ) : null}
            {needsTargetChoice ? (
              <button
                type="button"
                className={`row-tool-button target-choice-button ${activating ? "is-busy" : ""}`}
                aria-busy={activating}
                title="Choose Codex CLI or ChatGPT for this card"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onActivateSession();
                }}
              >
                <ListFilter size={13} aria-hidden="true" />
                <span>Target</span>
              </button>
            ) : null}
            {targetBinding?.type === "codex-app-thread" ? (
              <button
                type="button"
                className={`row-tool-button codex-app-target-button ${
                  targetBinding?.type === "codex-app-thread" ? "is-target" : ""
                } ${activating ? "is-busy" : ""}`}
                aria-busy={activating}
                title="Open and bind this card to ChatGPT"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenCodexAppTarget();
                }}
              >
                <Bot size={13} aria-hidden="true" />
                <span>ChatGPT</span>
              </button>
            ) : null}
            {targetBinding?.type === "codex-cli-session" ? (
              <button
                type="button"
                className={`row-tool-button codex-cli-target-button is-target ${activating ? "is-busy" : ""}`}
                aria-busy={activating}
                title="Focus this card's Codex CLI target"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onActivateSession();
                }}
              >
                <SquareTerminal size={13} aria-hidden="true" />
                <span>CLI</span>
              </button>
            ) : null}
            {managedConnected && targetBinding?.type !== "codex-cli-session" ? (
              <button
                type="button"
                className={`row-tool-button codex-cli-target-button is-target ${activating ? "is-busy" : ""}`}
                aria-busy={activating}
                title="Focus this AMO-managed CLI"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onActivateSession();
                }}
              >
                <SquareTerminal size={13} aria-hidden="true" />
                <span>CLI</span>
              </button>
            ) : null}
            {managedOffline || managedLaunching ? (
              <button
                type="button"
                className={`row-tool-button codex-cli-target-button ${activating ? "is-busy" : ""}`}
                aria-busy={activating}
                disabled={activating}
                title={managedLaunching ? "Retry this session in a new managed CLI" : "Resume this session in a new managed CLI"}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onResumeSession();
                }}
              >
                <RotateCcw size={13} aria-hidden="true" />
                <span>{managedLaunching ? "Retry CLI" : "Resume CLI"}</span>
              </button>
            ) : null}
            {managedOffline && codexAppAvailable ? (
              <button
                type="button"
                className={`row-tool-button codex-app-target-button ${activating ? "is-busy" : ""}`}
                aria-busy={activating}
                disabled={activating}
                title="Open this task in ChatGPT"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenCodexAppTarget();
                }}
              >
                <Bot size={13} aria-hidden="true" />
                <span>ChatGPT</span>
              </button>
            ) : null}
            {canUnbindTarget ? (
              <button
                type="button"
                className={`row-tool-button binding-button ${unbindingWindow ? "is-busy" : ""}`}
                aria-busy={unbindingWindow}
                title={`Unbind target: ${targetLabelForSession(session)}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onUnbindWindow();
                }}
              >
                <Unlink2 size={13} aria-hidden="true" />
                <span>Unbind</span>
              </button>
            ) : null}
          </span>
        ) : null}
      </span>
    </span>
  );
}
