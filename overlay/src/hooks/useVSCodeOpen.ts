import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { projectName, workspacePathForSession } from "../domain/routingModel";
import type { AgentSession, OpenPathResult } from "../types";

interface UseVSCodeOpenOptions {
  postDebugLog: (event: string, data?: unknown) => void;
  setFeedback: (message: string) => void;
}

export function useVSCodeOpen(options: UseVSCodeOpenOptions) {
  const [openingVSCodeSessionId, setOpeningVSCodeSessionId] = useState<string | null>(null);

  async function openSessionWorkspaceInVSCode(session: AgentSession) {
    const path = workspacePathForSession(session)?.trim();
    if (!path) {
      options.setFeedback("This task does not have a workspace path to open in VS Code.");
      return;
    }

    setOpeningVSCodeSessionId(session.sessionId);
    options.setFeedback(`Opening ${projectName(path)} in VS Code...`);
    options.postDebugLog("vscode.open.started", { sessionId: session.sessionId, path });

    try {
      const result = await invoke<OpenPathResult>("open_vscode", { path });
      options.setFeedback(result.message);
      options.postDebugLog(result.ok ? "vscode.open.succeeded" : "vscode.open.failed", {
        sessionId: session.sessionId,
        path,
        message: result.message,
      });
    } catch (error) {
      const message = `Could not open VS Code: ${(error as Error).message}`;
      options.setFeedback(message);
      options.postDebugLog("vscode.open.failed", { sessionId: session.sessionId, path, message });
    } finally {
      setOpeningVSCodeSessionId((current) => (current === session.sessionId ? null : current));
    }
  }

  return {
    openingVSCodeSessionId,
    openSessionWorkspaceInVSCode,
  };
}
