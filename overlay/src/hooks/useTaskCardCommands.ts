import { useMemo, useRef } from "react";
import type { TaskCardCommands } from "../components/TaskCard";

export function useTaskCardCommands(commands: TaskCardCommands): TaskCardCommands {
  const current = useRef(commands);
  current.current = commands;
  return useMemo(() => ({
    openNote: (session) => current.current.openNote(session),
    openVSCode: (session) => current.current.openVSCode(session),
    openCanvas: (session) => current.current.openCanvas(session),
    markReviewed: (session) => current.current.markReviewed(session),
    unbindWindow: (session) => current.current.unbindWindow(session),
    archive: (session) => current.current.archive(session),
    dismiss: (session) => current.current.dismiss(session),
    openApp: (session) => current.current.openApp(session),
    activate: (session) => current.current.activate(session),
    resume: (session) => current.current.resume(session),
    handleAttention: (session) => current.current.handleAttention(session),
    openLaunchPanel: (session, x, y) => current.current.openLaunchPanel(session, x, y),
    openWorkspacePanel: (session, x, y) => current.current.openWorkspacePanel(session, x, y),
    startWindowBindDrag: (session, event) => current.current.startWindowBindDrag(session, event),
  }), []);
}
