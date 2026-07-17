import { useEffect, useState } from "react";
import { Bot, KeyRound, Radio, ShieldCheck, SquareTerminal, X } from "lucide-react";
import {
  workspaceLaunchLabel,
  workspaceAdapterLaunchDetail,
  workspaceAdapterLaunchable,
  type LaunchPanelAdapterId,
} from "../domain/workspaceModel";
import { projectName, shortPathLabel } from "../domain/routingModel";
import {
  CLAUDE_PROVIDER_DEFINITIONS,
  loadDefaultClaudeProvider,
  loadModelCredentialStatus,
  resolveModelCredential,
  type ClaudeProviderLaunchConfig,
  type ClaudeProviderPresetId,
  type StoredClaudeProviderPresetId,
} from "../native/modelProviders";
import type { AgentSession, WorkspaceInspection } from "../types";
import { LaunchToolMark } from "./SessionCard";

export interface ManagedLaunchSelection {
  adapterId: LaunchPanelAdapterId;
  claudeProvider?: ClaudeProviderLaunchConfig;
}

export interface LaunchPanelState {
  source: "card" | "workspace";
  session: AgentSession | null;
  workspacePath: string;
  inspection: WorkspaceInspection | null;
  initialAdapterId?: LaunchPanelAdapterId;
  busy: "inspect" | "launch" | null;
  error: string | null;
}

interface LaunchPanelProps {
  state: LaunchPanelState;
  onClose: () => void;
  onLaunch: (selection: ManagedLaunchSelection) => void;
}

const adapters: LaunchPanelAdapterId[] = ["codex-cli", "claude-cli", "codex-app"];

export function LaunchPanel({ state, onClose, onLaunch }: LaunchPanelProps) {
  const [adapterId, setAdapterId] = useState<LaunchPanelAdapterId>(state.initialAdapterId ?? "codex-cli");
  const [claudeProviderId, setClaudeProviderId] = useState<ClaudeProviderPresetId>(() =>
    loadDefaultClaudeProvider(),
  );
  const [configuredProviderIds, setConfiguredProviderIds] = useState<Set<string>>(new Set());
  const [credentialStatusLoading, setCredentialStatusLoading] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [resolvingCredential, setResolvingCredential] = useState(false);

  useEffect(() => {
    setAdapterId(state.initialAdapterId ?? "codex-cli");
    setClaudeProviderId(loadDefaultClaudeProvider());
    setApiKey("");
    setCredentialError(null);
    setCredentialStatusLoading(true);
    void loadModelCredentialStatus()
      .then((result) => {
        setConfiguredProviderIds(new Set(result.configuredProviderIds));
      })
      .catch((error) => {
        setConfiguredProviderIds(new Set());
        setCredentialError(`Credential status unavailable: ${(error as Error).message}`);
      })
      .finally(() => setCredentialStatusLoading(false));
  }, [state.source, state.session?.sessionId, state.workspacePath, state.initialAdapterId]);

  const provider =
    CLAUDE_PROVIDER_DEFINITIONS.find((item) => item.id === claudeProviderId)
    ?? CLAUDE_PROVIDER_DEFINITIONS[0];
  const launchable = workspaceAdapterLaunchable(state.inspection, adapterId);
  const checking = state.busy === "inspect";
  const launching = state.busy === "launch" || resolvingCredential;
  const storedCredentialConfigured = configuredProviderIds.has(claudeProviderId);
  const missingProviderKey =
    adapterId === "claude-cli"
    && claudeProviderId !== "anthropic-default"
    && !storedCredentialConfigured
    && !apiKey.trim();
  const contextTitle = state.source === "card" ? "New task from card workspace" : "New workspace task";
  const contextDetail = state.source === "card"
    ? state.session?.taskTitle || state.session?.title || "Current card"
    : "No card is created until the launched tool emits its first hook.";

  async function submitLaunch() {
    if (!launchable || checking || launching || missingProviderKey) return;
    setCredentialError(null);
    let launchApiKey = apiKey.trim();

    if (
      adapterId === "claude-cli"
      && claudeProviderId !== "anthropic-default"
      && !launchApiKey
    ) {
      setResolvingCredential(true);
      try {
        launchApiKey = await resolveModelCredential(claudeProviderId as StoredClaudeProviderPresetId);
      } catch (error) {
        setCredentialError(`Stored API key could not be loaded: ${(error as Error).message}`);
        return;
      } finally {
        setResolvingCredential(false);
      }
    }

    onLaunch({
      adapterId,
      claudeProvider: adapterId === "claude-cli"
        ? {
            presetId: claudeProviderId,
            apiKey: claudeProviderId === "anthropic-default" ? undefined : launchApiKey,
          }
        : undefined,
    });
  }

  return (
    <div
      className="managed-launch-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !launching) onClose();
      }}
    >
      <section className="managed-launch-dialog" role="dialog" aria-modal="true" aria-label="Launch workspace tool">
        <header className="managed-launch-header">
          <div className="managed-launch-heading">
            <Radio size={16} aria-hidden="true" />
            <div>
              <strong>Launch Task</strong>
              <span>{contextTitle}</span>
            </div>
          </div>
          <button type="button" className="candidate-close" title="Close" disabled={launching} onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <div className="managed-launch-body">
          <section className="managed-launch-context">
            <div>
              <span>Workspace</span>
              <strong>{projectName(state.workspacePath)}</strong>
              <code title={state.workspacePath}>{shortPathLabel(state.workspacePath)}</code>
            </div>
            <div>
              <span>{state.source === "card" ? "Source card" : "Launch behavior"}</span>
              <strong>{contextDetail}</strong>
              {state.source === "card" && state.session ? <code>{state.session.sessionId}</code> : null}
            </div>
          </section>

          {state.error ? <p className="managed-launch-error">{state.error}</p> : null}
          {credentialError ? <p className="managed-launch-error">{credentialError}</p> : null}

          <section className="managed-launch-section">
            <div className="managed-launch-section-title">
              <strong>Client</strong>
              <span>{checking ? "Checking deployment" : workspaceAdapterLaunchDetail(state.inspection, adapterId)}</span>
            </div>
            <div className="managed-launch-clients" role="radiogroup" aria-label="Launch client">
              {adapters.map((candidateId) => {
                const candidateLaunchable = workspaceAdapterLaunchable(state.inspection, candidateId);
                return (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={adapterId === candidateId}
                    className={adapterId === candidateId ? "is-selected" : ""}
                    key={candidateId}
                    disabled={checking || launching || !candidateLaunchable}
                    onClick={() => setAdapterId(candidateId)}
                  >
                    <LaunchToolMark adapterId={candidateId} />
                    <span>
                      <strong>{workspaceLaunchLabel(candidateId)}</strong>
                      <small>{checking ? "checking" : workspaceAdapterLaunchDetail(state.inspection, candidateId)}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {adapterId === "claude-cli" ? (
            <section className="managed-launch-section">
              <div className="managed-launch-section-title">
                <strong>Model routing</strong>
                <span>Only this Claude CLI process</span>
              </div>
              <div className="managed-launch-providers" role="radiogroup" aria-label="Claude model provider">
                {CLAUDE_PROVIDER_DEFINITIONS.map((item) => (
                  <label className={claudeProviderId === item.id ? "is-selected" : ""} key={item.id}>
                    <input
                      type="radio"
                      name="claude-provider"
                      value={item.id}
                      checked={claudeProviderId === item.id}
                      disabled={launching}
                      onChange={() => {
                        setClaudeProviderId(item.id);
                        setApiKey("");
                        setCredentialError(null);
                      }}
                    />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.detail}</small>
                    </span>
                    {item.id !== "anthropic-default" ? (
                      <em className={configuredProviderIds.has(item.id) ? "is-configured" : ""}>
                        {credentialStatusLoading
                          ? "Checking"
                          : configuredProviderIds.has(item.id)
                            ? "Configured"
                            : "Key required"}
                      </em>
                    ) : null}
                  </label>
                ))}
              </div>

              {provider.keyLabel ? (
                <label className="managed-launch-key">
                  <span>
                    <KeyRound size={12} aria-hidden="true" />
                    {provider.keyLabel}
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={apiKey}
                    disabled={launching}
                    placeholder={
                      storedCredentialConfigured
                        ? "Optional: override the saved key for this launch"
                        : "Used once; save a default key in Settings > Models"
                    }
                    onChange={(event) => setApiKey(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void submitLaunch();
                    }}
                  />
                </label>
              ) : null}

              <div className="managed-launch-security-note">
                <ShieldCheck size={13} aria-hidden="true" />
                <span>
                  {storedCredentialConfigured && !apiKey.trim()
                    ? "The saved key is resolved only at launch and copied into a temporary Claude settings file."
                    : "This key is written only to a temporary launch settings file and removed when Claude exits."}
                </span>
              </div>
            </section>
          ) : null}
        </div>

        <footer className="managed-launch-footer">
          <span>
            {adapterId === "codex-app"
              ? "ChatGPT opens a new task and does not create a card until a hook exists."
              : "The managed card appears or reconnects after the CLI emits a hook."}
          </span>
          <div>
            <button type="button" disabled={launching} onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="primary"
              disabled={!launchable || checking || launching || missingProviderKey}
              onClick={() => void submitLaunch()}
            >
              {adapterId === "codex-app" ? <Bot size={13} aria-hidden="true" /> : <SquareTerminal size={13} aria-hidden="true" />}
              <span>
                {resolvingCredential
                  ? "Loading credential"
                  : state.busy === "launch"
                    ? "Launching"
                    : adapterId === "codex-app"
                      ? "Open ChatGPT"
                      : "Launch managed CLI"}
              </span>
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
