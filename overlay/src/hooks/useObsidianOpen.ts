import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BROKER_OBSIDIAN_REGISTER_VAULT_URL,
  brokerObsidianOpenResultUrl,
  brokerObsidianRuntimeUrl,
  getBrokerJson,
  postBrokerJson,
} from "../api/brokerClient";
import {
  canvasPathForOpen,
  latestCanvasNotePathForFocus,
  notePathForOpen,
  obsidianAmoOpenUri,
  obsidianOpenUri,
  obsidianVaultOpenUri,
} from "../domain/routingModel";
import { writeClipboardText } from "../native/clipboard";
import {
  confirmedObsidianOpen,
  shouldMarkReviewedForObsidianOpen,
  supportsConfirmedObsidianOpen,
} from "../runtime/obsidianOpenPolicy";
import type { ObsidianVaultRecoveryState } from "../components/ObsidianVaultRecoveryDialog";
import type {
  AgentSession,
  ObsidianOpenResult,
  ObsidianPluginRuntime,
  ObsidianRuntimeResult,
  ObsidianVaultRegistrationResult,
  OpenPathResult,
} from "../types";

const REGISTRATION_TIMEOUT_MS = 1_800;
const ACTIVE_RUNTIME_WAIT_MS = 1_800;
const BOOTSTRAP_RUNTIME_WAIT_MS = 4_000;
const OPEN_ACK_ATTEMPT_TIMEOUT_MS = 2_250;
const RESULT_POLL_MS = 120;
const OPEN_RESULT_CAPABILITY = "open-result-v1";

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function createOpenRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `amo-open-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface UseObsidianOpenOptions {
  markSessionReviewed: (
    session: AgentSession,
    action?: string,
    options?: { quiet?: boolean },
  ) => Promise<void>;
  markSessionVisuallySeen: (session: AgentSession) => void;
  postDebugLog: (event: string, data?: unknown) => void;
  setFeedback: (message: string) => void;
}

export function useObsidianOpen(options: UseObsidianOpenOptions) {
  const [openingPath, setOpeningPath] = useState<{ sessionId: string; target: "note" | "canvas" } | null>(null);
  const [obsidianVaultRecovery, setObsidianVaultRecovery] = useState<ObsidianVaultRecoveryState | null>(null);

  function showObsidianVaultRecovery(
    session: AgentSession,
    target: "note" | "canvas",
    targetPath: string,
    focusNotePath: string | null,
    registration: ObsidianVaultRegistrationResult,
    message: string,
  ) {
    setObsidianVaultRecovery({
      session,
      target,
      targetPath,
      focusNotePath,
      vaultRoot: registration.vaultRoot,
      vaultId: registration.vaultId,
      runtimeConfigPath: registration.runtimeConfigPath ?? null,
      obsidianProcessCount: registration.obsidianProcessCount ?? null,
      busy: null,
    });
    options.setFeedback(message);
  }

  function closeObsidianVaultRecovery() {
    setObsidianVaultRecovery(null);
  }

  async function openRecoveryVaultFolder() {
    if (!obsidianVaultRecovery) return;
    setObsidianVaultRecovery((current) => (current ? { ...current, busy: "explorer" } : current));
    try {
      const result = await invoke<OpenPathResult>("open_path", { path: obsidianVaultRecovery.vaultRoot });
      options.setFeedback(result.ok ? "Opened AMO vault folder." : result.message);
    } catch (error) {
      options.setFeedback(`Open AMO vault folder failed: ${(error as Error).message}`);
    } finally {
      setObsidianVaultRecovery((current) => (current ? { ...current, busy: null } : current));
    }
  }

  async function copyRecoveryVaultPath() {
    if (!obsidianVaultRecovery) return;
    setObsidianVaultRecovery((current) => (current ? { ...current, busy: "copy" } : current));
    try {
      const result = await writeClipboardText(obsidianVaultRecovery.vaultRoot);
      options.setFeedback(result.ok ? "Copied AMO vault path." : result.message);
    } catch (error) {
      options.setFeedback(`Copy AMO vault path failed: ${(error as Error).message}`);
    } finally {
      setObsidianVaultRecovery((current) => (current ? { ...current, busy: null } : current));
    }
  }

  async function dispatchObsidianUri(
    uri: string,
    phase: string,
    context: Record<string, unknown>,
  ) {
    const startedAt = performance.now();
    options.postDebugLog("obsidian.open.uri.dispatch.start", { ...context, phase, uri });
    try {
      const result = await invoke<OpenPathResult>("open_uri", { uri });
      options.postDebugLog(
        result.ok ? "obsidian.open.uri.dispatch.accepted" : "obsidian.open.uri.dispatch.error",
        {
          ...context,
          phase,
          dispatchAccepted: result.ok,
          durationMs: Math.round(performance.now() - startedAt),
          message: result.message,
        },
      );
      return result;
    } catch (error) {
      options.postDebugLog("obsidian.open.uri.dispatch.error", {
        ...context,
        phase,
        dispatchAccepted: false,
        durationMs: Math.round(performance.now() - startedAt),
        message: (error as Error).message,
      });
      throw error;
    }
  }

  async function waitForPluginRuntime(
    vaultId: string | undefined,
    vaultRoot: string | undefined,
    timeoutMs: number,
    context: Record<string, unknown>,
  ): Promise<ObsidianPluginRuntime | null> {
    if (!vaultId && !vaultRoot) return null;
    const startedAt = performance.now();
    while (performance.now() - startedAt < timeoutMs) {
      try {
        const result = await getBrokerJson<ObsidianRuntimeResult>(
          brokerObsidianRuntimeUrl(vaultId, vaultRoot),
          { timeoutMs: Math.min(700, timeoutMs) },
        );
        if (result.active && result.runtime) {
          options.postDebugLog("obsidian.open.runtime.ready", {
            ...context,
            durationMs: Math.round(performance.now() - startedAt),
            pluginVersion: result.runtime.pluginVersion ?? null,
            capabilities: result.runtime.capabilities,
          });
          return result.runtime;
        }
      } catch (error) {
        options.postDebugLog("obsidian.open.runtime.poll_error", {
          ...context,
          message: (error as Error).message,
        });
      }
      await sleep(RESULT_POLL_MS);
    }
    options.postDebugLog("obsidian.open.runtime.timeout", { ...context, timeoutMs });
    return null;
  }

  async function waitForOpenResult(openRequestId: string, context: Record<string, unknown>) {
    const startedAt = performance.now();
    while (performance.now() - startedAt < OPEN_ACK_ATTEMPT_TIMEOUT_MS) {
      try {
        const result = await getBrokerJson<ObsidianOpenResult>(brokerObsidianOpenResultUrl(openRequestId), {
          timeoutMs: 700,
        });
        if (!result.pending) {
          options.postDebugLog("obsidian.open.ack.received", {
            ...context,
            status: result.status ?? null,
            ok: result.ok,
            durationMs: Math.round(performance.now() - startedAt),
            pluginTimings: result.timings ?? null,
          });
          return result;
        }
      } catch (error) {
        options.postDebugLog("obsidian.open.ack.poll_error", {
          ...context,
          message: (error as Error).message,
        });
      }
      await sleep(RESULT_POLL_MS);
    }
    options.postDebugLog("obsidian.open.ack.timeout", { ...context, timeoutMs: OPEN_ACK_ATTEMPT_TIMEOUT_MS });
    return null;
  }

  async function openBridgePath(session: AgentSession, target: "note" | "canvas") {
    const targetPath = target === "note" ? notePathForOpen(session) : canvasPathForOpen(session);
    const focusNotePath = target === "canvas" ? latestCanvasNotePathForFocus(session) : null;
    if (!targetPath) {
      options.setFeedback(`No ${target} path is linked for ${session.title}.`);
      return;
    }

    const openRequestId = createOpenRequestId();
    const openStartedAt = performance.now();
    const context = { openRequestId, sessionId: session.sessionId, target, targetPath };
    options.markSessionVisuallySeen(session);
    setOpeningPath({ sessionId: session.sessionId, target });
    options.setFeedback(`Opening ${target} for ${session.title}...`);
    options.postDebugLog("obsidian.open.start", {
      ...context,
      focusNotePath,
      vaultRoot: session.vaultRoot ?? null,
      vaultId: null,
    });

    try {
      let vaultId: string | undefined;
      let registration: ObsidianVaultRegistrationResult | null = null;
      let pluginRuntime: ObsidianPluginRuntime | null = null;
      if (session.vaultRoot) {
        const registrationStartedAt = performance.now();
        options.postDebugLog("obsidian.open.registration.start", {
          ...context,
          vaultRoot: session.vaultRoot,
          timeoutMs: REGISTRATION_TIMEOUT_MS,
        });
        try {
          registration = await postBrokerJson<ObsidianVaultRegistrationResult>(
            BROKER_OBSIDIAN_REGISTER_VAULT_URL,
            { vaultRoot: session.vaultRoot, openRequestId },
            { timeoutMs: REGISTRATION_TIMEOUT_MS },
          );
        } catch (error) {
          const timedOut = (error as Error).message.includes("timed out");
          options.postDebugLog(
            timedOut ? "obsidian.open.registration.timeout" : "obsidian.open.registration.error",
            {
              ...context,
              vaultRoot: session.vaultRoot,
              durationMs: Math.round(performance.now() - registrationStartedAt),
              message: (error as Error).message,
            },
          );
          throw error;
        }
        vaultId = registration.vaultId;
        pluginRuntime = registration.pluginRuntime ?? null;
        options.postDebugLog("obsidian.open.registration.ok", {
          ...context,
          vaultRoot: session.vaultRoot,
          vaultId,
          changed: registration.changed,
          durationMs: Math.round(performance.now() - registrationStartedAt),
          brokerTimings: registration.timings ?? null,
          processState: registration.obsidianProcessState ?? null,
          processProbeCached: registration.processProbe?.cached ?? null,
          processProbeTimedOut: registration.processProbe?.timedOut ?? null,
          pluginRuntimeActive: pluginRuntime?.active ?? false,
        });
      }

      const needsRuntimeBootstrap = Boolean(registration && !registration.runtimeConfigExists);
      if (registration && needsRuntimeBootstrap && registration.obsidianProcessState === "running") {
        const message = "Obsidian is running but has not loaded this AMO vault. Open the vault folder in Obsidian once, then retry.";
        showObsidianVaultRecovery(session, target, targetPath, focusNotePath, registration, message);
        return;
      }

      const bootstrapUri = vaultId
        ? obsidianOpenUri(targetPath, vaultId, session.vaultRoot, { openRequestId })
        : null;
      const vaultRouteUri = vaultId ? obsidianVaultOpenUri(vaultId, openRequestId) : null;
      if (bootstrapUri && needsRuntimeBootstrap) {
        const bootstrapResult = await dispatchObsidianUri(bootstrapUri, "bootstrap", context);
        if (!bootstrapResult.ok) {
          options.setFeedback(bootstrapResult.message);
          return;
        }
        pluginRuntime = await waitForPluginRuntime(
          vaultId,
          session.vaultRoot,
          BOOTSTRAP_RUNTIME_WAIT_MS,
          context,
        );
        if (!pluginRuntime && registration) {
          const message = "Obsidian accepted the vault request but the AMO plugin did not become ready in time. Open this vault in Obsidian, then retry.";
          showObsidianVaultRecovery(session, target, targetPath, focusNotePath, registration, message);
          return;
        }
      } else if (vaultRouteUri && !pluginRuntime?.active) {
        const routeResult = await dispatchObsidianUri(vaultRouteUri, "vault-route", context);
        if (!routeResult.ok) {
          options.setFeedback(routeResult.message);
          return;
        }
        pluginRuntime = await waitForPluginRuntime(vaultId, session.vaultRoot, ACTIVE_RUNTIME_WAIT_MS, context);
      }

      const uri = obsidianAmoOpenUri(targetPath, target, vaultId, session.vaultRoot, {
        focusNotePath,
        openRequestId,
      });
      const result = await dispatchObsidianUri(uri, "plugin-open", {
        ...context,
        vaultId: vaultId ?? null,
        runtimeActive: pluginRuntime?.active ?? false,
      });
      if (!result.ok) {
        options.setFeedback(result.message);
        return;
      }

      const supportsOpenResult = supportsConfirmedObsidianOpen(pluginRuntime);
      if (!supportsOpenResult) {
        options.setFeedback(
          `${target === "note" ? "Note" : "Canvas"} request was dispatched to Obsidian; this plugin version cannot confirm completion.`,
        );
        options.postDebugLog("obsidian.open.legacy_dispatched", {
          ...context,
          totalMs: Math.round(performance.now() - openStartedAt),
          pluginVersion: pluginRuntime?.pluginVersion ?? null,
        });
        return;
      }

      options.setFeedback(`Obsidian accepted the ${target} request; waiting for confirmation...`);
      let openResult = await waitForOpenResult(openRequestId, context);
      if (!openResult) {
        options.postDebugLog("obsidian.open.retry", { ...context, attempt: 2, reason: "ack-timeout" });
        options.setFeedback(`Obsidian has not confirmed the ${target} yet; retrying once...`);
        const retryResult = await dispatchObsidianUri(uri, "plugin-open-retry", {
          ...context,
          vaultId: vaultId ?? null,
          attempt: 2,
        });
        if (retryResult.ok) openResult = await waitForOpenResult(openRequestId, context);
      }
      if (!openResult) {
        options.setFeedback(`Obsidian did not confirm the ${target} open after one retry. You can retry safely.`);
        return;
      }
      if (!confirmedObsidianOpen(openResult)) {
        options.setFeedback(openResult.message || `Obsidian could not open the ${target}.`);
        return;
      }

      options.setFeedback(
        openResult.status === "focused"
          ? `${target === "note" ? "Note" : "Canvas"} focused in Obsidian.`
          : `${target === "note" ? "Note" : "Canvas"} opened in Obsidian.`,
      );
      if (shouldMarkReviewedForObsidianOpen(pluginRuntime, openResult)) {
        await options.markSessionReviewed(session, `open-${target}-confirmed`, { quiet: true });
      }
      options.postDebugLog("obsidian.open.complete", {
        ...context,
        status: openResult.status,
        totalMs: Math.round(performance.now() - openStartedAt),
        pluginTimings: openResult.timings ?? null,
      });
    } catch (error) {
      options.postDebugLog("obsidian.open.error", {
        ...context,
        durationMs: Math.round(performance.now() - openStartedAt),
        message: (error as Error).message,
      });
      options.setFeedback(`Open ${target} failed: ${(error as Error).message}`);
    } finally {
      setOpeningPath(null);
    }
  }

  return {
    closeObsidianVaultRecovery,
    copyRecoveryVaultPath,
    obsidianVaultRecovery,
    openBridgePath,
    openingPath,
    openRecoveryVaultFolder,
  };
}