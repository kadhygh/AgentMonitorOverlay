import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { BROKER_SYNC_BACK_URL } from "../api/brokerClient";
import { targetBindingForSession } from "../domain/routingModel";
import {
  loadCliSafePasteEnabled,
  toCliPasteClipboardText,
  writeClipboardText,
} from "../native/clipboard";
import type { AgentSession } from "../types";

function clipboardPromptForSession(session: AgentSession) {
  const prompt = session.pendingPrompt ?? "";
  const safePaste =
    session.pendingPromptClipboardMode === "safe"
      ? true
      : session.pendingPromptClipboardMode === "raw"
        ? false
        : loadCliSafePasteEnabled();
  return toCliPasteClipboardText(prompt, safePaste);
}

interface UsePendingPromptSyncOptions {
  activateSession: (session: AgentSession) => Promise<void>;
  postDebugLog: (event: string, data?: unknown) => void;
  refreshSessions: (reason?: string) => Promise<void>;
  setFeedback: Dispatch<SetStateAction<string>>;
}

export function usePendingPromptSync(options: UsePendingPromptSyncOptions) {
  const [, setCopyingPromptId] = useState<string | null>(null);
  const autoSyncPromptIdsRef = useRef(new Set<string>());

  async function copyPendingPrompt(session: AgentSession) {
    if (!session.pendingPrompt) {
      options.setFeedback(`No pending prompt is linked for ${session.title}.`);
      return;
    }

    setCopyingPromptId(session.sessionId);
    options.setFeedback(`Copying pending prompt for ${session.title}...`);
    const clipboardPrompt = clipboardPromptForSession(session);
    const clipboardMode =
      session.pendingPromptClipboardMode ?? (loadCliSafePasteEnabled() ? "safe" : "raw");
    options.postDebugLog("sync.copy.start", {
      sessionId: session.sessionId,
      pendingPromptId: session.pendingPromptId ?? null,
      promptLength: session.pendingPrompt.length,
      clipboardLength: clipboardPrompt.length,
      clipboardMode,
      hasWindowBinding: Boolean(session.windowHint?.hwnd || session.windowHint?.pid),
      targetType: targetBindingForSession(session)?.type ?? "auto",
    });

    try {
      const result = await writeClipboardText(clipboardPrompt);
      if (!result.ok) {
        options.postDebugLog("sync.copy.clipboard_failed", {
          sessionId: session.sessionId,
          message: result.message,
        });
        options.setFeedback(result.message);
        return;
      }
      options.postDebugLog("sync.copy.clipboard_ok", {
        sessionId: session.sessionId,
        pendingPromptId: session.pendingPromptId ?? null,
      });

      const response = await fetch(BROKER_SYNC_BACK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: session.sessionId,
          pendingPromptId: session.pendingPromptId ?? null,
          action: "copy-focus",
        }),
      });
      if (!response.ok) {
        throw new Error(`broker returned ${response.status}`);
      }
      const syncResult = (await response.json()) as {
        promptNotePath?: string | null;
        promptCanvasNodeId?: string | null;
      };

      options.postDebugLog("sync.copy.broker_ok", {
        sessionId: session.sessionId,
        pendingPromptId: session.pendingPromptId ?? null,
        promptNotePath: syncResult.promptNotePath ?? null,
        promptCanvasNodeId: syncResult.promptCanvasNodeId ?? null,
      });
      options.setFeedback("Pending prompt copied. Focusing target...");
      void options.refreshSessions("sync-copy");
      await options.activateSession(session);
    } catch (error) {
      options.postDebugLog("sync.copy.error", {
        sessionId: session.sessionId,
        pendingPromptId: session.pendingPromptId ?? null,
        message: (error as Error).message,
      });
      options.setFeedback(`Copy + focus failed: ${(error as Error).message}`);
    } finally {
      setCopyingPromptId(null);
    }
  }

  function autoCopyAndFocusPendingPrompt(session: AgentSession, reason: string) {
    if (reason === "obsidian-return") {
      options.postDebugLog("sync.return.focus", {
        sessionId: session.sessionId,
        reason,
        targetType: targetBindingForSession(session)?.type ?? "auto",
      });
      void options.activateSession(session);
      return;
    }

    if (!session.pendingPrompt) {
      return;
    }

    const autoSyncKey =
      session.pendingPromptId ||
      `${session.sessionId}:${session.pendingPromptCreatedAt || session.updatedAt || session.pendingPrompt.slice(0, 48)}`;
    if (autoSyncPromptIdsRef.current.has(autoSyncKey)) {
      options.postDebugLog("sync.auto_copy.skip_duplicate", {
        sessionId: session.sessionId,
        pendingPromptId: session.pendingPromptId ?? null,
        reason,
      });
      return;
    }

    autoSyncPromptIdsRef.current.add(autoSyncKey);
    options.postDebugLog("sync.auto_copy.start", {
      sessionId: session.sessionId,
      pendingPromptId: session.pendingPromptId ?? null,
      reason,
      promptLength: session.pendingPrompt.length,
    });
    void copyPendingPrompt(session);
  }

  return {
    autoCopyAndFocusPendingPrompt,
    copyPendingPrompt,
  };
}
