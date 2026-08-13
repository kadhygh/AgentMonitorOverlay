import { useEffect, useState } from "react";
import { Check, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import {
  CLAUDE_PROVIDER_DEFINITIONS,
  CODEX_PROVIDER_DEFINITIONS,
  deleteModelCredential,
  loadModelCredentialStatus,
  saveModelCredential,
  STORED_MODEL_PROVIDER_DEFINITIONS,
  type ClaudeProviderPresetId,
  type CodexProviderPresetId,
  type StoredModelProviderId,
} from "../native/modelProviders";

interface ModelSettingsBodyProps {
  defaultClaudeProviderId: ClaudeProviderPresetId;
  defaultCodexProviderId: CodexProviderPresetId;
  onDefaultClaudeProviderChange: (providerId: ClaudeProviderPresetId) => void;
  onDefaultCodexProviderChange: (providerId: CodexProviderPresetId) => void;
  onFeedback: (message: string) => void;
}

export function ModelSettingsBody({
  defaultClaudeProviderId,
  defaultCodexProviderId,
  onDefaultClaudeProviderChange,
  onDefaultCodexProviderChange,
  onFeedback,
}: ModelSettingsBodyProps) {
  const [configuredProviderIds, setConfiguredProviderIds] = useState<Set<string>>(new Set());
  const [apiKeys, setApiKeys] = useState<Record<StoredModelProviderId, string>>({
    "deepseek-v4": "",
    "glm-5.2": "",
  });
  const [loading, setLoading] = useState(true);
  const [busyProviderId, setBusyProviderId] = useState<StoredModelProviderId | null>(null);

  useEffect(() => {
    void refreshStatus();
  }, []);

  async function refreshStatus() {
    setLoading(true);
    try {
      const result = await loadModelCredentialStatus();
      setConfiguredProviderIds(new Set(result.configuredProviderIds));
    } catch (error) {
      onFeedback(`Credential status failed: ${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  async function saveCredential(providerId: StoredModelProviderId) {
    const apiKey = apiKeys[providerId].trim();
    if (!apiKey) {
      onFeedback("Enter an API key before saving.");
      return;
    }

    setBusyProviderId(providerId);
    try {
      const result = await saveModelCredential(providerId, apiKey);
      onFeedback(result.message);
      if (result.ok) {
        setApiKeys((current) => ({ ...current, [providerId]: "" }));
        setConfiguredProviderIds((current) => new Set(current).add(providerId));
      }
    } catch (error) {
      onFeedback(`Credential save failed: ${(error as Error).message}`);
    } finally {
      setBusyProviderId(null);
    }
  }

  async function clearCredential(providerId: StoredModelProviderId) {
    setBusyProviderId(providerId);
    try {
      const result = await deleteModelCredential(providerId);
      onFeedback(result.message);
      if (result.ok) {
        setConfiguredProviderIds((current) => {
          const next = new Set(current);
          next.delete(providerId);
          return next;
        });
      }
    } catch (error) {
      onFeedback(`Credential removal failed: ${(error as Error).message}`);
    } finally {
      setBusyProviderId(null);
    }
  }

  return (
    <div className="settings-section-body">
      <label className="settings-field">
        <span>Default Codex model routing</span>
        <select
          value={defaultCodexProviderId}
          onChange={(event) => onDefaultCodexProviderChange(event.currentTarget.value as CodexProviderPresetId)}
        >
          {CODEX_PROVIDER_DEFINITIONS.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.title}
            </option>
          ))}
        </select>
      </label>

      <label className="settings-field">
        <span>Default Claude model routing</span>
        <select
          value={defaultClaudeProviderId}
          onChange={(event) => onDefaultClaudeProviderChange(event.currentTarget.value as ClaudeProviderPresetId)}
        >
          {CLAUDE_PROVIDER_DEFINITIONS.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.title}
            </option>
          ))}
        </select>
      </label>

      <p className="settings-help-copy">
        These presets are selected whenever AMO opens the managed launch dialog. You can still override either client for one launch.
      </p>

      <div className="settings-provider-list">
        {STORED_MODEL_PROVIDER_DEFINITIONS.map((provider) => {
          const providerId = provider.id;
          const configured = configuredProviderIds.has(providerId);
          const busy = busyProviderId === providerId;
          return (
            <section className="settings-provider-card" key={providerId}>
              <header>
                <div>
                  <strong>{provider.title}</strong>
                  <span>{provider.model}</span>
                </div>
                <em className={configured ? "is-configured" : ""}>
                  {loading ? "Checking" : configured ? "Configured" : "Not configured"}
                </em>
              </header>
              <p>{provider.detail}</p>
              <label>
                <span>
                  <KeyRound size={12} aria-hidden="true" />
                  {provider.keyLabel}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={apiKeys[providerId]}
                  disabled={busy}
                  placeholder={configured ? "Enter a new key to replace the saved one" : "API key"}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setApiKeys((current) => ({ ...current, [providerId]: value }));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void saveCredential(providerId);
                  }}
                />
              </label>
              <div className="settings-provider-actions">
                <button
                  type="button"
                  className="settings-primary-action"
                  disabled={busy || !apiKeys[providerId].trim()}
                  onClick={() => void saveCredential(providerId)}
                >
                  <Check size={13} aria-hidden="true" />
                  <span>{configured ? "Replace key" : "Save key"}</span>
                </button>
                <button
                  type="button"
                  className="settings-danger-action"
                  disabled={busy || !configured}
                  onClick={() => void clearCredential(providerId)}
                >
                  <Trash2 size={13} aria-hidden="true" />
                  <span>Clear</span>
                </button>
              </div>
            </section>
          );
        })}
      </div>

      <div className="settings-security-note">
        <ShieldCheck size={14} aria-hidden="true" />
        <span>
          Keys are stored in Windows Credential Manager for the current Windows user. AMO never writes them to localStorage, Broker state, project files, or logs.
          The DeepSeek key is shared by the Codex and Claude launch presets.
        </span>
      </div>
    </div>
  );
}
