// The viewer windows (查看器, stage 13) as pure logic, so it can be tested without Electron: what address a request
// opens, and which window it goes to. One preview window is reused for every file opened; 固定 (pin) keeps a window,
// and the next file opens in a new preview window.

const ID = /^[\w-]{1,80}$/;
const MAX_PATH = 1000;

const line = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

/**
 * `#viewer?path=…&workspace=…&line=…&end=…&mode=…&session=…&n=…` for a valid request, null otherwise. `n` makes every open a hash
 * change, so the same file asked for twice still scrolls the window back to its line.
 */
export function viewerHash(target: unknown, nonce: number): string | null {
  const t = target as { path?: unknown; pack?: unknown; item?: unknown; workspaceId?: unknown; line?: unknown; endLine?: unknown; mode?: unknown; sessionId?: unknown } | null;
  // 查看包 (2026-10-23): the window shows a pack by its id; it reads the pack itself.
  if (t && typeof t.pack === "string") {
    if (!ID.test(t.pack)) return null;
    // The item to show first (what the agent just added).
    const q = new URLSearchParams({ pack: t.pack });
    if (typeof t.item === "string" && ID.test(t.item)) q.set("item", t.item);
    q.set("n", String(nonce));
    return `#viewer?${q.toString()}`;
  }
  if (typeof t?.path !== "string" || !t.path || t.path.length > MAX_PATH || /[\0\r\n]/.test(t.path)) return null;
  const q = new URLSearchParams({ path: t.path });
  if (typeof t.workspaceId === "string" && ID.test(t.workspaceId)) q.set("workspace", t.workspaceId);
  const start = line(t.line);
  if (start) {
    q.set("line", String(start));
    const end = line(t.endLine);
    if (end && end > start) q.set("end", String(end));
  }
  if (t.mode === "changes") q.set("mode", "changes");
  // The conversation it was opened from (S14-A): comments written in the viewer go there by default.
  if (typeof t.sessionId === "string" && ID.test(t.sessionId)) q.set("session", t.sessionId);
  q.set("n", String(nonce));
  return `#viewer?${q.toString()}`;
}

/**
 * Which windows are viewers and which one is the preview. `W` is the window type (BrowserWindow in the app, anything
 * in tests). Closing a window must be reported with `closed`.
 */
export class ViewerSet<W> {
  private preview: W | null = null;
  private readonly pinned = new Set<W>();

  /** Where an open request goes: the preview window to reuse, or null to create a new one (then call `created`). */
  target(): W | null {
    return this.preview;
  }

  /** A new window became the preview. */
  created(win: W): void {
    this.preview = win;
  }

  /** 固定: the window is kept; the next open makes a new preview. Returns whether `win` is a viewer at all. */
  pin(win: W): boolean {
    if (win === this.preview) this.preview = null;
    else if (!this.pinned.has(win)) return false;
    this.pinned.add(win);
    return true;
  }

  isPinned(win: W): boolean {
    return this.pinned.has(win);
  }

  closed(win: W): void {
    if (win === this.preview) this.preview = null;
    this.pinned.delete(win);
  }

  all(): W[] {
    return [...(this.preview ? [this.preview] : []), ...this.pinned];
  }
}
