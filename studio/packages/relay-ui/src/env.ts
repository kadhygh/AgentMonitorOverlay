import type { RelayShell, SavedAccount } from "./shared.js";

declare global {
  interface Window {
    relayShell?: RelayShell;
  }
}

/** The desktop shell; null in a browser. */
export const shell: RelayShell | null = typeof window !== "undefined" ? (window.relayShell ?? null) : null;

const BROWSER_ACCOUNTS = "amo-relay.accounts";

/** In a browser: the service is the page's own, accounts are remembered by name only (the browser keeps passwords). */
export const browserServer = () => (location.protocol.startsWith("http") ? location.origin : "");

export function browserAccounts(): SavedAccount[] {
  try {
    return JSON.parse(localStorage.getItem(BROWSER_ACCOUNTS) ?? "[]") as SavedAccount[];
  } catch {
    return [];
  }
}

export function rememberBrowserAccount(server: string, name: string): void {
  try {
    const list = browserAccounts().filter((a) => !(a.server === server && a.name === name));
    list.unshift({ server, name, password: null, lastUsed: Date.now() });
    localStorage.setItem(BROWSER_ACCOUNTS, JSON.stringify(list.slice(0, 8)));
  } catch {
    // storage blocked: nothing remembered
  }
}

export async function copyText(text: string): Promise<void> {
  if (shell) return shell.copy(text);
  await navigator.clipboard.writeText(text);
}
