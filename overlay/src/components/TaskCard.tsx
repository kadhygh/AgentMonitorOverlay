import { memo, type PointerEvent } from "react";
import type { AgentSession } from "../types";
import { SessionRowContent, type SessionRowContentProps } from "./SessionCard";

export interface TaskCardCommands {
  openNote(session: AgentSession): void;
  openVSCode(session: AgentSession): void;
  openCanvas(session: AgentSession): void;
  markReviewed(session: AgentSession): void;
  unbindWindow(session: AgentSession): void;
  archive(session: AgentSession): void;
  dismiss(session: AgentSession): void;
  openApp(session: AgentSession): void;
  activate(session: AgentSession): void;
  resume(session: AgentSession): void;
  handleAttention(session: AgentSession): void;
  openLaunchPanel(session: AgentSession, x: number, y: number): void;
  openWorkspacePanel(session: AgentSession, x: number, y: number): void;
  startWindowBindDrag(session: AgentSession, event: PointerEvent<HTMLButtonElement>): void;
}

type TaskCardProps = Omit<SessionRowContentProps, `on${string}`> & { commands: TaskCardCommands };

// Containers own selection, layout and commands; this component owns one task's presentation.
export const TaskCard = memo(function TaskCard({ commands, session, ...props }: TaskCardProps) {
  return <SessionRowContent {...props} session={session}
    onOpenNote={() => commands.openNote(session)}
    onOpenVSCode={() => commands.openVSCode(session)}
    onOpenCanvas={() => commands.openCanvas(session)}
    onMarkReviewed={() => commands.markReviewed(session)}
    onUnbindWindow={() => commands.unbindWindow(session)}
    onArchive={() => commands.archive(session)}
    onDismiss={() => commands.dismiss(session)}
    onOpenCodexAppTarget={() => commands.openApp(session)}
    onActivateSession={() => commands.activate(session)}
    onResumeSession={() => commands.resume(session)}
    onHandleAttention={() => commands.handleAttention(session)}
    onOpenLaunchPanel={(x, y) => commands.openLaunchPanel(session, x, y)}
    onOpenWorkspacePanel={(x, y) => commands.openWorkspacePanel(session, x, y)}
    onStartWindowBindDrag={(event) => commands.startWindowBindDrag(session, event)}
  />;
});
