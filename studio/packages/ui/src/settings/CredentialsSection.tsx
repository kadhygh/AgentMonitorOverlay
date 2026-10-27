import { useEffect, useState } from "react";
import type { CredentialStatus } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";

// 设置 → 模型: which keys the built-in models need and whether they are stored (the channel cards show them). API keys
// come from old AMO's settings; nothing is typed in here (the Claude subscription token mode is gone since 2026-10-27).

export type SettingsMessage = { text: string; error?: boolean } | null;

/** The credentials the profiles use (whether stored, never the values). */
export function useCredentials(link: HostLink): [CredentialStatus[] | null, (list: CredentialStatus[]) => void] {
  const [list, setList] = useState<CredentialStatus[] | null>(null);
  useEffect(() => {
    call(link, "GET /api/credentials")
      .then(setList)
      .catch(() => undefined);
  }, [link]);
  return [list, setList];
}

export function CredentialMessage({ message }: { message: SettingsMessage }) {
  if (!message) return null;
  return (
    <span className={message.error ? "form-error" : "settings-hint"} role={message.error ? "alert" : "status"} data-testid="credential-message">
      {message.text}
    </span>
  );
}
