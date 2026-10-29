import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// What waits in AMO 中转 shown outside its window (2026-10-29, the user: 「有待处理的 relay 信息时和未读聊天时，relay 的
// 任务栏图标应该闪烁，托盘也闪，托盘最好还带上信息数量。如果是收起来的托盘则切成 relay 图标来闪，也显示信息数量。」).
// The count is the content's (relay-ui Home: sessions waiting for me + unread chats, relayShell.setUnread). Here:
//  - the taskbar button: flashes when the count goes up while the window is not in use (until it is), and carries the
//    count as an overlay badge as long as there is one;
//  - its own tray icon (started on its own): the icon with the count, blinking with the plain one while the window is
//    not in use;
//  - started by AMO 平台 (--amo-tray=platform, no tray icon of its own): the same written to <home>\attention.json, which
//    the platform reads to blink its icon as 中转's (constraint 1: the platform reads a tool's own file; the tool does not
//    know the platform is there, and runs the same without it).

export const ATTENTION_FILE = "attention.json";

/** <home>\attention.json: what waits, and whether it should blink now. `pid` tells a crashed client's leftover. */
export interface AttentionFile {
  count: number;
  blink: boolean;
  pid: number;
  at: string;
}

export interface AttentionEffects {
  /** The taskbar button flashes (true) or stops (false). */
  flash(on: boolean): void;
  /** The taskbar button's badge; 0 for none. */
  overlay(count: number): void;
  /** The tray icon: with the count or plain. */
  tray(badge: boolean, count: number): void;
  tooltip(text: string): void;
  /** For the platform (only started by it); null when the client goes. */
  write?(state: AttentionFile | null): void;
}

export const BLINK_MS = 500;

export function tooltipText(count: number): string {
  return count > 0 ? `AMO 中转 · ${count} 条待处理 / 未读` : "AMO 中转";
}

export class Attention {
  private count = 0;
  private inUse = false;
  private shown = false;
  private written = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly effects: AttentionEffects,
    private readonly pid = process.pid,
    private readonly blinkMs = BLINK_MS,
  ) {}

  get state(): { count: number; inUse: boolean; blinking: boolean } {
    return { count: this.count, inUse: this.inUse, blinking: this.timer !== null };
  }

  /** The content's count (it sends it whenever it changes). */
  setCount(count: number): void {
    const next = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    const prev = this.count;
    this.count = next;
    if (next > prev && !this.inUse) this.effects.flash(true);
    if (next === 0) this.effects.flash(false);
    if (next !== prev) {
      this.effects.overlay(next);
      this.effects.tooltip(tooltipText(next));
    }
    this.update();
  }

  /** The window is on screen and focused (someone is looking at it), or not. */
  setInUse(inUse: boolean): void {
    if (inUse === this.inUse) return;
    this.inUse = inUse;
    if (inUse) this.effects.flash(false);
    this.update();
  }

  /** The client goes: nothing left behind for the platform. */
  dispose(): void {
    this.stop();
    this.effects.write?.(null);
  }

  private update(): void {
    const blink = this.count > 0 && !this.inUse;
    if (blink && !this.timer) {
      this.shown = true;
      this.effects.tray(true, this.count);
      this.timer = setInterval(() => {
        this.shown = !this.shown;
        this.effects.tray(this.shown, this.count);
      }, this.blinkMs);
    } else if (!blink) {
      this.stop();
      this.effects.tray(this.count > 0, this.count);
    } else this.effects.tray(this.shown, this.count);
    // Only when it changed: the platform looks at the file every second.
    if (`${this.count}/${blink}` === this.written) return;
    this.written = `${this.count}/${blink}`;
    this.effects.write?.({ count: this.count, blink, pid: this.pid, at: new Date().toISOString() });
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Writes <home>\attention.json (whole, through a temporary file: the platform never reads half of it); null removes it. */
export function writeAttention(home: string, state: AttentionFile | null): void {
  const file = join(home, ATTENTION_FILE);
  try {
    if (!state) return rmSync(file, { force: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(state));
    renameSync(`${file}.tmp`, file);
  } catch {
    // next change writes it again
  }
}
