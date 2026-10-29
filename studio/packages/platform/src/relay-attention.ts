import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// AMO 中转 started by the platform has no tray icon of its own (--amo-tray=platform), so what waits there is shown on
// the platform's (2026-10-29, the user: 「如果是收起来的托盘则切成 relay 图标来闪，也显示信息数量」): while it has a
// count the platform's icon becomes 中转's with the count, blinking while 中转's window is not looked at, and back to
// the platform's own once nothing waits. The count is in the file 中转 writes in its own folder (relay-app's
// attention.ts, <AMO_RELAY_HOME or %APPDATA%\AMO Relay>\attention.json); the platform only reads it (constraint 1).

export interface RelayAttention {
  count: number;
  blink: boolean;
}

/** 中转's folder, as it finds it itself (relay's relayHome): the platform starts it with this same environment. */
export function relayHomeDir(env: Record<string, string | undefined>): string {
  if (env.AMO_RELAY_HOME) return env.AMO_RELAY_HOME;
  return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "AMO Relay");
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: there, only not ours to signal.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The file's content when 中转 that wrote it still runs and something waits; null otherwise. */
export function parseRelayAttention(text: string, isAlive: (pid: number) => boolean = alive): RelayAttention | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const d = data as { count?: unknown; blink?: unknown; pid?: unknown };
  if (typeof d?.count !== "number" || !(d.count > 0) || typeof d.pid !== "number") return null;
  if (!isAlive(d.pid)) return null;
  return { count: Math.floor(d.count), blink: d.blink === true };
}

/** Reads the file again only when it changed (it is looked at every second). */
export class RelayAttentionReader {
  private stamp = "";
  private last: RelayAttention | null = null;
  private pidChecked = 0;

  constructor(
    private readonly file: string,
    private readonly isAlive: (pid: number) => boolean = alive,
  ) {}

  static forEnv(env: Record<string, string | undefined>): RelayAttentionReader {
    return new RelayAttentionReader(join(relayHomeDir(env), "attention.json"));
  }

  read(now = Date.now()): RelayAttention | null {
    let stamp: string;
    try {
      const s = statSync(this.file);
      stamp = `${s.mtimeMs}/${s.size}`;
    } catch {
      this.stamp = "";
      return (this.last = null);
    }
    // Unchanged: still asked whether 中转 runs now and then (it may have crashed without removing it).
    if (stamp === this.stamp && (!this.last || now - this.pidChecked < 5000)) return this.last;
    this.stamp = stamp;
    this.pidChecked = now;
    try {
      this.last = parseRelayAttention(readFileSync(this.file, "utf8"), this.isAlive);
    } catch {
      this.last = null;
    }
    return this.last;
  }
}

/** The platform's tray icon: its own, or 中转's with the count (blinking with the plain 中转 icon). */
export interface TrayLook {
  icon: "platform" | "relay";
  count: number;
  blink: boolean;
  tooltip: string;
}

export function trayLook(relay: RelayAttention | null): TrayLook {
  if (!relay || relay.count <= 0) return { icon: "platform", count: 0, blink: false, tooltip: "AMO 平台" };
  return { icon: "relay", count: relay.count, blink: relay.blink, tooltip: `AMO 平台 · 中转有 ${relay.count} 条待处理 / 未读` };
}
