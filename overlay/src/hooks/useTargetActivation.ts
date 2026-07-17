import { useState, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  brokerSessionManagedOfflineUrl,
  brokerSessionResumeUrl,
  brokerSessionTargetBindingUrl,
  postBrokerJson,
} from "../api/brokerClient";
import { cliLaunchPreferencePayload } from "../native/cliLaunch";
import {
  isClaudeProviderPresetId,
  resolveModelCredential,
  type ClaudeProviderLaunchConfig,
  type StoredClaudeProviderPresetId,
} from "../native/modelProviders";
import {
  activateSessionWindow,
  listSessionWindowCandidates,
  probeSessionWindow,
  windowCandidateAtCursor,
} from "../platform/windowClient";
import { menuPosition } from "../domain/overlaySessionUi";
import {
  activationCandidateFromWindowTarget,
  activationTargetForSession,
  activationWindowRequest,
  codexAppThreadUri,
  codexAppTargetForSession,
  hasExplicitWindowTarget,
  hasStrongWindowRoutingHint,
  isCodexSession,
  projectName,
  shouldShowCodexCliResumeOption,
  targetBindingForSession,
  windowTargetForSession,
  workspacePathForSession,
} from "../domain/routingModel";
import type { CandidateMenuState } from "../components/CandidateMenu";
import type { LaunchPanelState } from "../components/LaunchPanel";
import type {
  ActivationCandidate,
  AgentSession,
  OpenPathResult,
  TargetBinding,
  WorkspaceLaunchResult,
} from "../types";

interface UseTargetActivationOptions {
  clearSessionAttentionAfterActivation: (session: AgentSession, action?: string) => Promise<AgentSession | null>;
  markSessionReviewed: (
    session: AgentSession,
    action?: string,
    options?: { quiet?: boolean },
  ) => Promise<void>;
  markSessionVisuallySeen: (session: AgentSession) => void;
  postDebugLog: (event: string, data?: unknown) => void;
  refreshSessions: (reason?: string) => Promise<void>;
  setCandidateMenu: Dispatch<SetStateAction<CandidateMenuState | null>>;
  setFeedback: Dispatch<SetStateAction<string>>;
  setLaunchPanel: Dispatch<SetStateAction<LaunchPanelState | null>>;
  setSessions: Dispatch<SetStateAction<AgentSession[]>>;
}

export function useTargetActivation(options: UseTargetActivationOptions) {
  const [activatingId, setActivatingId] = useState<string | null>(null);

  async function markManagedWindowOffline(session: AgentSession, reason: string) {
    if (!session.launchId || session.launchState !== "connected") return session;
    try {
      const response = await postBrokerJson<{ ok: boolean; session: AgentSession }>(
        brokerSessionManagedOfflineUrl(session.sessionId),
        { launchId: session.launchId, reason },
      );
      options.setSessions((previous) =>
        previous.map((item) => (item.sessionId === response.session.sessionId ? response.session : item)),
      );
      options.postDebugLog("managed_window.offline", {
        sessionId: session.sessionId,
        launchId: session.launchId,
        reason,
      });
      return response.session;
    } catch (error) {
      options.postDebugLog("managed_window.offline_error", {
        sessionId: session.sessionId,
        launchId: session.launchId,
        reason,
        message: (error as Error).message,
      });
      return session;
    }
  }

  async function openCodexAppTarget(
    session: AgentSession,
    bindTarget: boolean,
    openOptions: { clearAttentionOnSuccess?: boolean } = {},
  ) {
    const target = codexAppTargetForSession(session);
    const uri = target.uri ?? codexAppThreadUri(session.sessionId);
    options.markSessionVisuallySeen(session);
    setActivatingId(session.sessionId);
    options.setCandidateMenu(null);
    options.setFeedback(`${bindTarget ? "Binding and opening" : "Opening"} ChatGPT for ${projectName(session.cwd)}...`);
    options.postDebugLog("codex_app.target_open.start", {
      sessionId: session.sessionId,
      bindTarget,
      uri,
    });

    try {
      if (bindTarget) {
        const binding = await postBrokerJson<{ ok: boolean; session: AgentSession; targetBinding: TargetBinding }>(
          brokerSessionTargetBindingUrl(session.sessionId),
          target,
        );
        options.setSessions((previous) =>
          previous.map((item) => (item.sessionId === binding.session.sessionId ? binding.session : item)),
        );
        options.postDebugLog("codex_app.target_bound", {
          sessionId: session.sessionId,
          uri,
        });
      }

      const result = await invoke<OpenPathResult>("open_uri", { uri });
      options.postDebugLog("codex_app.target_open.result", {
        sessionId: session.sessionId,
        ok: result.ok,
        message: result.message,
      });
      options.setFeedback(result.ok ? "ChatGPT task opened." : result.message);
      if (result.ok && openOptions.clearAttentionOnSuccess) {
        void options.clearSessionAttentionAfterActivation(session, "open-codex-app");
      }
      if (result.ok) {
        void options.markSessionReviewed(session, "open-codex-app", { quiet: true });
      }
    } catch (error) {
      options.postDebugLog("codex_app.target_open.error", {
        sessionId: session.sessionId,
        bindTarget,
        message: (error as Error).message,
      });
      options.setFeedback(`Open ChatGPT target failed: ${(error as Error).message}`);
    } finally {
      setActivatingId(null);
    }
  }

  async function resumeManagedSession(session: AgentSession) {
    setActivatingId(session.sessionId);
    options.setCandidateMenu(null);
    options.setFeedback(`Resuming ${session.title} in a new managed CLI...`);
    options.postDebugLog("managed_launch.resume.start", {
      sessionId: session.sessionId,
      previousLaunchId: session.launchId ?? null,
      workspacePath: workspacePathForSession(session),
    });

    try {
      let claudeProvider: ClaudeProviderLaunchConfig | undefined;
      const providerId = session.claudeProviderId ?? null;
      if (
        providerId
        && providerId !== "anthropic-default"
        && isClaudeProviderPresetId(providerId)
      ) {
        const apiKey = await resolveModelCredential(providerId as StoredClaudeProviderPresetId);
        claudeProvider = { presetId: providerId, apiKey };
      }
      const result = await postBrokerJson<WorkspaceLaunchResult & { duplicate?: boolean }>(
        brokerSessionResumeUrl(session.sessionId),
        { ...cliLaunchPreferencePayload(), replacePending: true, claudeProvider },
      );
      if (result.session) {
        options.setSessions((previous) =>
          previous.map((item) => (item.sessionId === result.session?.sessionId ? result.session : item)),
        );
      }
      options.setFeedback(result.duplicate ? "This session is already waiting for its resumed CLI hook." : result.message);
      options.postDebugLog("managed_launch.resume.ok", {
        sessionId: session.sessionId,
        launchId: result.launch?.launchId ?? null,
        duplicate: Boolean(result.duplicate),
      });
    } catch (error) {
      options.setFeedback(`Resume CLI failed: ${(error as Error).message}`);
      options.postDebugLog("managed_launch.resume.error", {
        sessionId: session.sessionId,
        message: (error as Error).message,
      });
    } finally {
      setActivatingId(null);
    }
  }

  function openCodexTargetMenu(
    session: AgentSession,
    menuX?: number,
    menuY?: number,
    candidates?: ActivationCandidate[],
    menuOptions: { allowCodexCliResumeWithCandidates?: boolean; clearAttentionOnConfirm?: boolean } = {},
  ) {
    const position = menuPosition(menuX, menuY);
    const hintCandidate = activationCandidateFromWindowTarget(windowTargetForSession(session));
    const mergedCandidates = [...(candidates ?? [])];
    if (
      hintCandidate &&
      !mergedCandidates.some(
        (candidate) => candidate.hwnd === hintCandidate.hwnd && candidate.processId === hintCandidate.processId,
      )
    ) {
      mergedCandidates.unshift(hintCandidate);
    }

    options.setCandidateMenu({
      session,
      candidates: mergedCandidates,
      x: position.x,
      y: position.y,
      bindOnSelect: true,
      clearAttentionOnConfirm: menuOptions.clearAttentionOnConfirm ?? false,
      selectedCandidateKey: null,
      codexAppAvailable: true,
      codexCliResumeAvailable: shouldShowCodexCliResumeOption(
        session,
        mergedCandidates,
        menuOptions.allowCodexCliResumeWithCandidates ?? true,
      ),
    });
  }

  async function openCodexTargetMenuFromWindowList(
    session: AgentSession,
    menuX?: number,
    menuY?: number,
    menuOptions: { clearAttentionOnConfirm?: boolean } = {},
  ) {
    setActivatingId(session.sessionId);
    options.setFeedback(`Finding target windows for ${session.title}...`);
    options.postDebugLog("window.candidate.list.start", {
      sessionId: session.sessionId,
      title: session.title,
      cwd: session.cwd,
    });

    try {
      const result = await listSessionWindowCandidates(
        activationWindowRequest(session, null, { includeWindowHintIdentity: false }),
      );
      const candidates = result.candidates ?? [];
      options.postDebugLog("window.candidate.list.result", {
        sessionId: session.sessionId,
        ok: result.ok,
        message: result.message,
        candidateCount: candidates.length,
      });
      openCodexTargetMenu(session, menuX, menuY, candidates, {
        allowCodexCliResumeWithCandidates: true,
        clearAttentionOnConfirm: menuOptions.clearAttentionOnConfirm ?? false,
      });
      options.setFeedback(candidates.length > 0 ? "Choose a target window, then Focus or Confirm." : result.message);
    } catch (error) {
      options.postDebugLog("window.candidate.list.error", {
        sessionId: session.sessionId,
        message: (error as Error).message,
      });
      openCodexTargetMenu(session, menuX, menuY, [], {
        allowCodexCliResumeWithCandidates: true,
        clearAttentionOnConfirm: menuOptions.clearAttentionOnConfirm ?? false,
      });
      options.setFeedback(`Target listing failed: ${(error as Error).message}`);
    } finally {
      setActivatingId(null);
    }
  }

  async function activateSession(
    session: AgentSession,
    menuX?: number,
    menuY?: number,
    activateOptions: { clearAttentionOnSuccess?: boolean } = {},
  ) {
    options.markSessionVisuallySeen(session);
    options.setLaunchPanel(null);
    const targetBinding = targetBindingForSession(session);
    if (targetBinding?.type === "codex-app-thread") {
      await openCodexAppTarget(session, false, {
        clearAttentionOnSuccess: activateOptions.clearAttentionOnSuccess ?? false,
      });
      return;
    }

    if (session.launchId && session.launchState === "offline") {
      await openCodexTargetMenuFromWindowList(session, menuX, menuY, {
        clearAttentionOnConfirm: activateOptions.clearAttentionOnSuccess ?? false,
      });
      return;
    }

    const activationTarget =
      targetBinding?.type === "codex-cli-session" ? windowTargetForSession(session) : activationTargetForSession(session);
    const canRouteCodexCliByHint =
      hasStrongWindowRoutingHint(session) &&
      (targetBinding?.type === "codex-cli-session" || session.windowHint?.boundBy === "managed-launch");
    if (isCodexSession(session) && !hasExplicitWindowTarget(activationTarget) && !canRouteCodexCliByHint) {
      await openCodexTargetMenuFromWindowList(session, menuX, menuY, {
        clearAttentionOnConfirm: activateOptions.clearAttentionOnSuccess ?? false,
      });
      return;
    }

    setActivatingId(session.sessionId);
    options.setCandidateMenu(null);
    options.setFeedback(`Activating ${activationTarget?.label ?? session.title}...`);
    options.postDebugLog("window.activate.start", {
      sessionId: session.sessionId,
      title: session.title,
      targetType: activationTarget?.type ?? "auto",
      hwnd: session.windowHint?.hwnd ?? null,
      pid: session.windowHint?.pid ?? null,
      cwd: session.cwd,
    });

    try {
      const result = await activateSessionWindow(
        activationWindowRequest(session, activationTarget),
      );
      let menuSession = session;
      if (
        !result.ok &&
        session.launchId &&
        session.launchState === "connected" &&
        session.windowHint?.titleToken &&
        session.windowHint?.hwnd
      ) {
        try {
          const probe = await probeSessionWindow(
            activationWindowRequest(session, null, { includeWindowHintIdentity: true }),
          );
          if (!probe.ok) {
            menuSession = await markManagedWindowOffline(session, "activation-window-not-found");
          }
        } catch (error) {
          options.postDebugLog("managed_window.activation_probe_error", {
            sessionId: session.sessionId,
            launchId: session.launchId,
            message: (error as Error).message,
          });
        }
      }
      if (!result.ok && ((result.candidates?.length ?? 0) > 0 || isCodexSession(session))) {
        if (isCodexSession(session)) {
          openCodexTargetMenu(menuSession, menuX, menuY, result.candidates ?? [], {
            allowCodexCliResumeWithCandidates: true,
            clearAttentionOnConfirm: activateOptions.clearAttentionOnSuccess ?? false,
          });
        } else {
          const position = menuPosition(menuX, menuY);
          options.setCandidateMenu({
            session: menuSession,
            candidates: result.candidates ?? [],
            x: position.x,
            y: position.y,
            bindOnSelect: true,
            clearAttentionOnConfirm: activateOptions.clearAttentionOnSuccess ?? false,
            selectedCandidateKey: null,
            codexAppAvailable: false,
            codexCliResumeAvailable: false,
          });
        }
      }
      options.postDebugLog("window.activate.result", {
        sessionId: session.sessionId,
        ok: result.ok,
        message: result.message,
        candidateCount: result.candidates?.length ?? 0,
      });
      options.setFeedback(result.message);
      if (result.ok && activateOptions.clearAttentionOnSuccess) {
        void options.clearSessionAttentionAfterActivation(session, "activate-target");
      }
    } catch (error) {
      options.postDebugLog("window.activate.error", {
        sessionId: session.sessionId,
        message: (error as Error).message,
      });
      options.setFeedback(`Activation command failed: ${(error as Error).message}`);
    } finally {
      setActivatingId(null);
    }
  }

  async function bindWindowCandidate(session: AgentSession, candidate: ActivationCandidate, action: string) {
    options.postDebugLog("window.candidate.bind.start", {
      sessionId: session.sessionId,
      action,
      hwnd: candidate.hwnd,
      processId: candidate.processId,
      processName: candidate.processName ?? null,
      title: candidate.title,
    });

    const binding = await postBrokerJson<{ ok: boolean; session: AgentSession; targetBinding: TargetBinding }>(
      brokerSessionTargetBindingUrl(session.sessionId),
      {
        type: "window",
        hwnd: candidate.hwnd,
        processId: candidate.processId,
        processName: candidate.processName ?? null,
        title: candidate.title,
        label: candidate.label,
      },
    );

    options.setSessions((previous) =>
      previous.map((item) => (item.sessionId === binding.session.sessionId ? binding.session : item)),
    );
    options.postDebugLog("window.candidate.bound", {
      sessionId: session.sessionId,
      action,
      hwnd: candidate.hwnd,
      processId: candidate.processId,
      processName: candidate.processName ?? null,
    });
  }

  async function bindWindowAtCursor(session: AgentSession) {
    const currentTarget = targetBindingForSession(session);
    if (currentTarget) {
      options.setFeedback("This card already has a target binding.");
      return;
    }

    setActivatingId(session.sessionId);
    options.setFeedback("Reading the window under cursor...");

    try {
      const result = await windowCandidateAtCursor();
      const candidates = result.candidates ?? [];
      options.postDebugLog("window.cursor_candidate.result", {
        sessionId: session.sessionId,
        ok: result.ok,
        message: result.message,
        candidates: candidates.length,
      });
      if (!result.ok || candidates.length === 0) {
        options.setFeedback(result.message || "No window found under cursor.");
        return;
      }

      const candidate = candidates[0];
      await bindWindowCandidate(session, candidate, "drag-to-window");
      options.setFeedback(`Bound to ${candidate.processName ?? "window"}: ${candidate.title}`);
      void options.refreshSessions("window-drag-bind");
    } catch (error) {
      options.postDebugLog("window.cursor_candidate.error", {
        sessionId: session.sessionId,
        message: (error as Error).message,
      });
      options.setFeedback(`Drag bind failed: ${(error as Error).message}`);
    } finally {
      setActivatingId(null);
    }
  }

  async function activateCandidate(
    session: AgentSession,
    candidate: ActivationCandidate,
    bindWindow: boolean,
    candidateOptions: { closeOnSuccess?: boolean; markReviewedOnSuccess?: boolean; clearAttentionOnSuccess?: boolean } = {},
  ) {
    const closeOnSuccess = candidateOptions.closeOnSuccess ?? true;
    const markReviewedOnSuccess = candidateOptions.markReviewedOnSuccess ?? true;
    const clearAttentionOnSuccess = candidateOptions.clearAttentionOnSuccess ?? false;
    options.markSessionVisuallySeen(session);
    setActivatingId(session.sessionId);
    options.setFeedback(`Activating ${candidate.processName ?? "window"}...`);
    options.postDebugLog("window.candidate.activate.start", {
      sessionId: session.sessionId,
      hwnd: candidate.hwnd,
      processId: candidate.processId,
      processName: candidate.processName ?? null,
      bindWindow,
    });

    try {
      const result = await activateSessionWindow({
        sessionId: session.sessionId,
        tool: session.tool,
        title: candidate.title,
        processName: candidate.processName ?? "",
        titleToken: "",
        titleContains: [],
        project: "",
        cwd: session.cwd,
        pid: candidate.processId,
        hwnd: candidate.hwnd,
      });
      options.setFeedback(result.message);
      options.postDebugLog("window.candidate.activate.result", {
        sessionId: session.sessionId,
        ok: result.ok,
        message: result.message,
        bindWindow,
      });
      if (result.ok) {
        if (bindWindow) {
          await bindWindowCandidate(session, candidate, "activate-candidate");
          options.setFeedback(`Bound and activated ${candidate.processName ?? "window"}.`);
        }
        if (closeOnSuccess) {
          options.setCandidateMenu(null);
        }
        if (clearAttentionOnSuccess) {
          void options.clearSessionAttentionAfterActivation(session, "activate-candidate");
        }
        if (markReviewedOnSuccess) {
          void options.markSessionReviewed(session, "activate-candidate", { quiet: true });
        }
      }
    } catch (error) {
      options.postDebugLog("window.candidate.activate.error", {
        sessionId: session.sessionId,
        hwnd: candidate.hwnd,
        processId: candidate.processId,
        message: (error as Error).message,
      });
      options.setFeedback(`Candidate activation failed: ${(error as Error).message}`);
    } finally {
      setActivatingId(null);
    }
  }

  return {
    activateCandidate,
    activateSession,
    activatingId,
    bindWindowAtCursor,
    openCodexAppTarget,
    openCodexTargetMenuFromWindowList,
    resumeManagedSession,
  };
}
