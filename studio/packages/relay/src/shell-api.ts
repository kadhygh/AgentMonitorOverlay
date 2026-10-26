// What the desktop client's shell (packages/relay-app, fixed, Electron) gives the client's content (packages/relay-ui,
// hot-updated from the service) as `window.relayShell`. In a browser there is no shell: the content runs without
// saved passwords, notifications, AI hookup and updates. Bump SHELL_VERSION when this changes; content built for a
// newer shell says so in its manifest (minShell).

export const SHELL_VERSION = 1;

export interface SavedAccount {
  server: string;
  name: string;
  /** null when it was saved without the password. */
  password: string | null;
  lastUsed: number;
}

export interface UpdateInfo {
  current: string | null;
  latest: string;
  /** The content needs a newer shell: download the client again from the service's page. */
  needShell: boolean;
}

export interface ShellInfo {
  shellVersion: number;
  contentVersion: string;
  server: string;
  update: UpdateInfo | null;
  platform: string;
}

/** How an AI client starts this machine's relay MCP (the shell's own exe runs it as Node). */
export interface McpHookup {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** The command line for agents without MCP, e.g. "C:\…\amo-relay.cmd". */
  cli: string;
}

export interface RelayShell {
  info(): Promise<ShellInfo>;
  accounts(): Promise<SavedAccount[]>;
  saveAccount(account: { server: string; name: string; password: string | null }): Promise<void>;
  forgetAccount(server: string, name: string): Promise<void>;
  /** The identity this machine's MCP and command line use; null on logout. */
  signedIn(identity: { server: string; name: string; key: string } | null): Promise<void>;
  mcp(): Promise<McpHookup>;
  copy(text: string): Promise<void>;
  notify(n: { title: string; body: string; threadId: string }): void;
  /** A notification was clicked. */
  onOpenThread(listener: (threadId: string) => void): void;
  setUnread(count: number): void;
  checkUpdate(): Promise<UpdateInfo | null>;
  /** Downloads the latest content, switches to it and reloads the window (no restart). */
  applyUpdate(): Promise<void>;
  onUpdateProgress(listener: (p: { done: number; total: number }) => void): void;
  /** Back to the loader, to enter another service address. */
  changeServer(): void;
  openExternal(url: string): void;
}
