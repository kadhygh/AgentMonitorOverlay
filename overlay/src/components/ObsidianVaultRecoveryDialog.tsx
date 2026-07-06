import { ClipboardCheck, FolderOpen, X } from "lucide-react";
import type { AgentSession } from "../types";

export interface ObsidianVaultRecoveryState {
  session: AgentSession;
  target: "note" | "canvas";
  targetPath: string;
  focusNotePath?: string | null;
  vaultRoot: string;
  vaultId: string;
  runtimeConfigPath?: string | null;
  obsidianProcessCount?: number | null;
  busy: "explorer" | "copy" | null;
}

interface ObsidianVaultRecoveryDialogProps {
  state: ObsidianVaultRecoveryState;
  onClose: () => void;
  onOpenFolder: () => void;
  onCopyPath: () => void;
}

export function ObsidianVaultRecoveryDialog({
  state,
  onClose,
  onOpenFolder,
  onCopyPath,
}: ObsidianVaultRecoveryDialogProps) {
  return (
    <div className="confirm-backdrop" role="presentation" onClick={onClose}>
      <section
        className="vault-recovery-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Open AMO vault in Obsidian"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="confirm-dialog-header">
          <strong>Obsidian Vault Not Loaded</strong>
          <button type="button" className="candidate-close" title="Close" onClick={onClose}>
            <X size={13} aria-hidden="true" />
          </button>
        </div>
        <p>
          Obsidian is running, but this AMO vault has not been loaded by the current Obsidian session. Open this
          folder as a vault in Obsidian once, then click the {state.target === "note" ? "Note" : "Canvas"} button
          again.
        </p>
        <div className="vault-recovery-path" title={state.vaultRoot}>
          {state.vaultRoot}
        </div>
        <div className="vault-recovery-manual">
          In Obsidian, use <span>Open folder as vault</span> and choose this path. AMO will use the plugin bridge
          after the vault is loaded.
        </div>
        <div className="vault-recovery-actions">
          <button type="button" onClick={onOpenFolder} disabled={state.busy !== null}>
            <FolderOpen size={13} aria-hidden="true" />
            <span>{state.busy === "explorer" ? "Opening" : "Open Folder"}</span>
          </button>
          <button type="button" onClick={onCopyPath} disabled={state.busy !== null}>
            <ClipboardCheck size={13} aria-hidden="true" />
            <span>{state.busy === "copy" ? "Copying" : "Copy Path"}</span>
          </button>
        </div>
      </section>
    </div>
  );
}
