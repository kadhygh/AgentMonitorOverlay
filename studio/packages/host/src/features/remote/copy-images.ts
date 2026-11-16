import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Attachment, Id, MessageImage, SessionItem } from "@amo-studio/protocol";
import { HostError } from "../../core/shared.js";
import type { RemoteContext } from "./grants.js";
import type { RemoteFiles } from "./files.js";

// 远程 on B (2026-10-30, the user: a screenshot sent in a remote task's conversation did not show here — A had it): A's
// items name pictures by A's attachment ids, which this computer does not have. Each becomes one of this computer's own
// attachments — the one sent from here (taken back when A's message comes), or else fetched from A (rt.file gives a
// granted task's attachments) — and the copy's items name it instead. Kept per task (kv `remote.images`), so a later
// sync from A is rewritten the same way; null: A would not give it (the item shows its name, not a broken picture).

const KEY = "remote.images";
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

type Known = Record<Id, Record<Id, Id | null>>;

export class CopyImages {
  /** Pictures a message from here carries, until A's copy of the message comes back (by session). */
  private readonly sending = new Map<Id, Id[]>();
  /** A's picture → its fetch under way (asked twice at once, it is fetched once). */
  private readonly fetching = new Map<Id, Promise<Id | null>>();

  constructor(
    private readonly ctx: RemoteContext,
    private readonly files: RemoteFiles,
    /** Puts an item of a copy again (it is rewritten on the way). */
    private readonly put: (item: SessionItem) => void,
  ) {}

  private get store() {
    return this.ctx.host.store;
  }

  private known(): Known {
    try {
      const v = JSON.parse(this.store.getKv(KEY)?.value ?? "{}") as Known;
      return v && typeof v === "object" ? v : {};
    } catch {
      return {};
    }
  }

  private remember(taskId: Id, pairs: Record<Id, Id | null>): void {
    const all = this.known();
    all[taskId] = { ...all[taskId], ...pairs };
    this.store.setKv(KEY, JSON.stringify(all));
  }

  private local(id: Id): Attachment | null {
    try {
      return this.ctx.host.attachments.get(id);
    } catch {
      return null;
    }
  }

  /** A message with pictures goes to A from here. */
  sent(sessionId: Id, attachmentIds: readonly Id[]): void {
    if (attachmentIds.length) this.sending.set(sessionId, [...attachmentIds]);
    else this.sending.delete(sessionId);
  }

  /** It did not go. */
  failed(sessionId: Id): void {
    this.sending.delete(sessionId);
  }

  /** The copy's task is gone. */
  drop(taskId: Id): void {
    const all = this.known();
    if (!(taskId in all)) return;
    delete all[taskId];
    this.store.setKv(KEY, JSON.stringify(all));
  }

  /** An item of A's as this computer keeps it: its pictures this computer's own (those not here yet are fetched). */
  localize(taskId: Id, item: SessionItem): SessionItem {
    if ((item.type !== "user" && item.type !== "tool") || !item.images?.length) return item;
    let known = this.known()[taskId] ?? {};
    const foreign = item.images.filter((im): im is MessageImage & { id: Id } => !!im.id && !(im.id in known) && !this.local(im.id));
    // The pictures of a message sent from here, in the order they went (A keeps that order).
    const mine = item.type === "user" ? this.sending.get(item.sessionId) : undefined;
    if (mine && foreign.length === mine.length) {
      this.sending.delete(item.sessionId);
      this.remember(taskId, Object.fromEntries(foreign.map((im, i) => [im.id, mine[i]!])));
      known = this.known()[taskId] ?? {};
    }
    let changed = false;
    const images = item.images.map((im): MessageImage => {
      if (!im.id || !(im.id in known)) {
        if (im.id && !this.local(im.id)) this.fetch(taskId, item.id, im.id, im.path);
        return im;
      }
      const mineId = known[im.id];
      const a = mineId ? this.local(mineId) : null;
      changed = true;
      return a ? { id: a.id, path: a.path } : { id: null, path: im.path };
    });
    return changed ? ({ ...item, images } as SessionItem) : item;
  }

  /**
   * One picture of A's fetched and kept as this computer's attachment (null: not a picture this computer keeps), and
   * remembered for the task. A refusal is remembered too (null: not asked again by itself) and thrown; not reachable,
   * nothing is remembered and it is thrown.
   */
  private fetchOne(taskId: Id, theirs: Id, path: string): Promise<Id | null> {
    const had = this.fetching.get(theirs);
    if (had) return had;
    const ext = /\.[^./\\]+$/.exec(path)?.[0].toLowerCase() ?? "";
    const run = this.files
      .fetch(taskId, path)
      .then(
        (f) => {
          const mime = MIME[ext];
          return !mime || f.kind !== "image" ? null : this.ctx.host.attachments.save(readFileSync(f.path), { name: basename(path), mime }).id;
        },
        (err: unknown) => {
          if (err instanceof HostError && err.code !== "runtime_error" && this.store.getTask(taskId)?.remote) this.remember(taskId, { [theirs]: null });
          throw err;
        },
      )
      .then((mineId) => {
        // The copy may have been archived meanwhile: nothing is kept for it.
        if (this.store.getTask(taskId)?.remote) this.remember(taskId, { [theirs]: mineId });
        return mineId;
      })
      .finally(() => this.fetching.delete(theirs));
    this.fetching.set(theirs, run);
    return run;
  }

  /** The item again as this computer keeps it (its pictures this computer's own now). */
  private putAgain(taskId: Id, itemId: Id): void {
    if (!this.store.getTask(taskId)?.remote) return;
    const item = this.store.getItem(itemId);
    if (item) this.put(item);
  }

  /** A picture of A's this computer does not have: fetched, kept as an attachment, the item put again. */
  private fetch(taskId: Id, itemId: Id, theirs: Id, path: string): void {
    void this.fetchOne(taskId, theirs, path).then(
      () => this.putAgain(taskId, itemId),
      // A refused it: the item shows its name (the refusal is remembered). Not reachable: the picture stays broken until
      // the person looks at it (request) or the item comes again.
      (err: unknown) => {
        if (err instanceof HostError && err.code !== "runtime_error") this.putAgain(taskId, itemId);
      },
    );
  }

  /**
   * 补取 (2026-11-17, the user: 后来连上的控制端，对话里早先发过的文件读不到): the pictures of one item of a copy that are
   * not here, asked of A now — the person is looking at them. Before, a picture was asked for only when its item came:
   * a device that came later gets a long conversation's items all at once, a fetch that then failed (no answer in time,
   * A away for a moment) was never tried again — catching up asks only for items after the last one, so that item never
   * came again — and it showed broken (A's attachment id, which this computer does not have). Throws A's reason when A
   * cannot give it (gone there too: A says so).
   */
  async request(taskId: Id, itemId: Id): Promise<void> {
    const item = this.store.getItem(itemId);
    if (!item || this.store.getSession(item.sessionId)?.taskId !== taskId || !this.store.getTask(taskId)?.remote) throw new HostError("not_found", "这条消息不在这个远程任务里");
    if ((item.type !== "user" && item.type !== "tool") || !item.images?.length) return;
    const known = this.known()[taskId] ?? {};
    let failed: unknown = null;
    for (const im of item.images) {
      if (!im.id || this.local(im.id)) continue;
      // Fetched meanwhile (the item was stored before it came): only the item needs putting again.
      const mine = known[im.id];
      if (mine && this.local(mine)) continue;
      try {
        await this.fetchOne(taskId, im.id, im.path);
      } catch (err) {
        failed ??= err;
      }
    }
    this.putAgain(taskId, itemId);
    if (failed) throw failed instanceof HostError ? failed : new HostError("runtime_error", failed instanceof Error ? failed.message : String(failed));
  }
}
