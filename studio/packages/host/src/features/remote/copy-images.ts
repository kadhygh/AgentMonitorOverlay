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
  private readonly fetching = new Set<Id>();

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

  /** A picture of A's this computer does not have: fetched, kept as an attachment, the item put again. */
  private fetch(taskId: Id, itemId: Id, theirs: Id, path: string): void {
    if (this.fetching.has(theirs)) return;
    this.fetching.add(theirs);
    const ext = /\.[^./\\]+$/.exec(path)?.[0].toLowerCase() ?? "";
    void this.files
      .fetch(taskId, path)
      .then((f) => {
        const mime = MIME[ext];
        if (!mime || f.kind !== "image") return null;
        return this.ctx.host.attachments.save(readFileSync(f.path), { name: basename(path), mime }).id;
      })
      // A refused it: not asked again. Away or not reachable: asked again when the item comes again.
      .catch((err: unknown) => (err instanceof HostError && err.code !== "runtime_error" ? null : undefined))
      .then((mineId) => {
        // The copy may have been archived meanwhile: nothing is kept for it.
        if (mineId === undefined || !this.store.getTask(taskId)?.remote) return;
        this.remember(taskId, { [theirs]: mineId });
        const item = this.store.getItem(itemId);
        if (item) this.put(item);
      })
      .finally(() => this.fetching.delete(theirs));
  }
}
