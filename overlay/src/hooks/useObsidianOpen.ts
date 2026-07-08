import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BROKER_OBSIDIAN_REGISTER_VAULT_URL,
  postBrokerJson,
} from "../api/brokerClient";
import {
  canvasPathForOpen,
  latestCanvasNotePathForFocus,
  notePathForOpen,
  obsidianAmoOpenUri,
  obsidianOpenUri,
} from "../domain/routingModel";
import { writeClipboardText } from "../native/clipboard";
import type { ObsidianVaultRecoveryState } from "../components/ObsidianVaultRecoveryDialog";
import type {
  AgentSession,
  ObsidianVaultRegistrationResult,
  OpenPathResult,
} from "../types";

const OBSIDIAN_PLUGIN_BOOTSTRAP_DELAY_MS = 1200;

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
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

  async function openBridgePath(session: AgentSession, target: "note" | "canvas") {
    const targetPath = target === "note" ? notePathForOpen(session) : canvasPathForOpen(session);
    const focusNotePath = target === "canvas" ? latestCanvasNotePathForFocus(session) : null;
    if (!targetPath) {
      options.setFeedback(`No ${target} path is linked for ${session.title}.`);
      return;
    }

    options.markSessionVisuallySeen(session);
    setOpeningPath({ sessionId: session.sessionId, target });
    options.setFeedback(`Opening ${target} for ${session.title}...`);
    options.postDebugLog("obsidian.open.start", {
      sessionId: session.sessionId,
      target,
      targetPath,
      focusNotePath,
      vaultRoot: session.vaultRoot ?? null,
      vaultId: null,
    });

    try {
      let vaultId: string | undefined;
      let registration: ObsidianVaultRegistrationResult | null = null;
      if (session.vaultRoot) {
        registration = await postBrokerJson<ObsidianVaultRegistrationResult>(
          BROKER_OBSIDIAN_REGISTER_VAULT_URL,
          { vaultRoot: session.vaultRoot },
        );
        vaultId = registration.vaultId;
        options.postDebugLog("obsidian.open.vault_registered", {
          sessionId: session.sessionId,
          target,
          vaultRoot: session.vaultRoot,
          vaultId,
          changed: registration.changed,
          runtimeConfigExists: registration.runtimeConfigExists ?? null,
          runtimeConfigFileExists: registration.runtimeConfigFileExists ?? null,
          vaultRuntimeLoaded: registration.vaultRuntimeState?.loaded ?? null,
          runtimeConfigPath: registration.runtimeConfigPath ?? null,
          obsidianProcessCount: registration.obsidianProcessCount ?? null,
        });
      }

      const bootstrapUri = vaultId ? obsidianOpenUri(targetPath, vaultId, session.vaultRoot) : null;
      let bootstrapResult: OpenPathResult | null = null;
      const needsRuntimeBootstrap = Boolean(registration && !registration.runtimeConfigExists);
      if (registration && needsRuntimeBootstrap && (registration.obsidianProcessCount ?? 0) > 0) {
        const message =
          "Obsidian has not loaded this AMO vault yet. Open this folder as a vault in Obsidian once, then try again.";
        options.postDebugLog("obsidian.open.runtime_missing", {
          sessionId: session.sessionId,
          target,
          vaultRoot: session.vaultRoot,
          vaultId: registration.vaultId,
          runtimeConfigPath: registration.runtimeConfigPath ?? null,
          runtimeConfigFileExists: registration.runtimeConfigFileExists ?? null,
          vaultRuntimeLoaded: registration.vaultRuntimeState?.loaded ?? null,
          obsidianProcessCount: registration.obsidianProcessCount ?? null,
          skippedBootstrap: true,
        });
        showObsidianVaultRecovery(session, target, targetPath, focusNotePath, registration, message);
        options.setFeedback(message);
        return;
      }

      if (bootstrapUri && needsRuntimeBootstrap) {
        options.postDebugLog("obsidian.open.bootstrap_uri", {
          sessionId: session.sessionId,
          target,
          uri: bootstrapUri,
          vaultId,
        });
        bootstrapResult = await invoke<OpenPathResult>("open_uri", { uri: bootstrapUri });
        options.postDebugLog("obsidian.open.bootstrap_result", {
          sessionId: session.sessionId,
          target,
          ok: bootstrapResult.ok,
          message: bootstrapResult.message,
        });
        if (!bootstrapResult.ok) {
          options.setFeedback(bootstrapResult.message);
          return;
        }

        await sleep(OBSIDIAN_PLUGIN_BOOTSTRAP_DELAY_MS);
        if (registration && needsRuntimeBootstrap && session.vaultRoot) {
          registration = await postBrokerJson<ObsidianVaultRegistrationResult>(
            BROKER_OBSIDIAN_REGISTER_VAULT_URL,
            { vaultRoot: session.vaultRoot },
          );
          options.postDebugLog("obsidian.open.runtime_check", {
            sessionId: session.sessionId,
            target,
            vaultRoot: session.vaultRoot,
            vaultId: registration.vaultId,
            runtimeConfigExists: registration.runtimeConfigExists ?? null,
            runtimeConfigFileExists: registration.runtimeConfigFileExists ?? null,
            vaultRuntimeLoaded: registration.vaultRuntimeState?.loaded ?? null,
            runtimeConfigPath: registration.runtimeConfigPath ?? null,
            obsidianProcessCount: registration.obsidianProcessCount ?? null,
          });
          if (!registration.runtimeConfigExists) {
            const message =
              "Obsidian accepted the open request, but this AMO vault is still not loaded. Open this folder as a vault in Obsidian once, then try again.";
            options.postDebugLog("obsidian.open.runtime_missing", {
              sessionId: session.sessionId,
              target,
              vaultRoot: session.vaultRoot,
              vaultId: registration.vaultId,
              runtimeConfigPath: registration.runtimeConfigPath ?? null,
              runtimeConfigFileExists: registration.runtimeConfigFileExists ?? null,
              vaultRuntimeLoaded: registration.vaultRuntimeState?.loaded ?? null,
              obsidianProcessCount: registration.obsidianProcessCount ?? null,
              skippedBootstrap: false,
            });
            showObsidianVaultRecovery(session, target, targetPath, focusNotePath, registration, message);
            options.setFeedback(message);
            return;
          }
        }
      }

      const uri = obsidianAmoOpenUri(targetPath, target, vaultId, session.vaultRoot, { focusNotePath });
      options.postDebugLog("obsidian.open.uri", {
        sessionId: session.sessionId,
        target,
        uri,
        vaultId: vaultId ?? null,
        bootstrapUsed: Boolean(bootstrapResult),
        pluginOpenSkipped: false,
      });
      const result = await invoke<OpenPathResult>("open_uri", { uri });
      options.postDebugLog("obsidian.open.result", {
        sessionId: session.sessionId,
        target,
        focusNotePath,
        ok: result.ok,
        message: result.message,
        bootstrapUsed: Boolean(bootstrapResult),
        pluginOpenSkipped: false,
      });
      if (result.ok) {
        options.setFeedback(`${target === "note" ? "Note" : "Canvas"} opened in Obsidian.`);
        void options.markSessionReviewed(session, `open-${target}`, { quiet: true });
      } else {
        options.setFeedback(result.message);
      }
    } catch (error) {
      options.postDebugLog("obsidian.open.error", {
        sessionId: session.sessionId,
        target,
        targetPath,
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
