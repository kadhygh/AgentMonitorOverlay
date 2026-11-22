import { useSyncExternalStore } from "react";
import type { Session } from "./session.js";
import { RelayClientError, TRANSFER_CHUNK, transferFolders, type ShellTransfer, type Transfer, type TransferTarget } from "./shared.js";

// 传文件's engine (2026-11-23, plans/relay-file-transfer.md 第 2 项), in the content so it is fixed by a hot update: it
// watches the sends the session keeps current and moves the bytes — the shell (relayShell.transfer) only reads and
// writes this computer's files. Two loops, each one file at a time: uploading what this device sends once some target
// accepted (from where the service is: a break, a reload, a restart of the client go on from there), and downloading
// what this device accepted as soon as each file is complete on the service (from where the .part is). A file that
// does not match its sha256 starts again (three times, then it stops with the reason, and 重试 goes on). A send that
// ended before everything came drops its parts here.

export interface LocalState {
  phase: "hashing" | "uploading" | "downloading" | "saving" | "error";
  /** Bytes done on this side (sent, or saved here). */
  bytes: number;
  file: string;
  error?: string;
}

const RETRY_MS = 5000;
const IDLE_MS = 15_000;
const REPORT_MS = 1500;

export const shellError = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** My target on this device in a send, or null. */
export function myTarget(t: Transfer, me: string, device: string | undefined): TransferTarget | null {
  return (device && t.targets.find((x) => x.account === me && x.device === device)) || null;
}

export class TransferEngine {
  private local = new Map<string, LocalState>();
  private listeners = new Set<() => void>();
  private snapshot = new Map<string, LocalState>();
  private stopped = false;
  private wakers = new Set<() => void>();
  /** Sends whose loop stopped on an error until 重试. */
  private failed = new Set<string>();
  /** Paths saved here, per send (read once from the shell, kept up to date). */
  private saved = new Map<string, Set<string>>();
  private hashes = new Map<string, string>();
  private cleaned = new Set<string>();
  private pruned = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly session: Session,
    private readonly tx: ShellTransfer,
  ) {}

  private get me() {
    return this.session.me.name;
  }
  private get device() {
    return this.session.snapshot.device?.id;
  }

  start(): void {
    this.unsubscribe = this.session.subscribe(() => this.kick());
    void this.loop("up");
    void this.loop("down");
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.kick();
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  state = () => this.snapshot;

  private setLocal(id: string, s: LocalState | null): void {
    if (s) this.local.set(id, s);
    else this.local.delete(id);
    this.snapshot = new Map(this.local);
    for (const l of this.listeners) l();
  }

  /** Something changed: the loops look again. */
  kick(): void {
    for (const w of [...this.wakers]) w();
  }

  retry(id: string): void {
    this.failed.delete(id);
    this.setLocal(id, null);
    this.kick();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => (clearTimeout(timer), this.wakers.delete(done), resolve());
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }

  private async savedOf(id: string): Promise<Set<string> | null> {
    const have = this.saved.get(id);
    if (have) return have;
    const rec = await this.tx.received(id).catch(() => null);
    if (!rec) return null;
    const set = new Set(rec.done);
    this.saved.set(id, set);
    return set;
  }

  /** Ended sends: the parts here go (a receive that did not finish), the sender forgets its files. Once each. */
  private async tidy(list: Transfer[]): Promise<void> {
    // Only once the list came from the service: an empty list before that would drop every record.
    if (!this.pruned && this.session.snapshot.transfersLoaded) {
      this.pruned = true;
      await this.tx.prune(list.map((t) => t.id)).catch(() => undefined);
    }
    for (const t of list) {
      if (t.state === "open" || this.cleaned.has(t.id)) continue;
      this.cleaned.add(t.id);
      if (t.from === this.me && t.fromDevice === this.device) await this.tx.forgetSend(t.id).catch(() => undefined);
      const mine = myTarget(t, this.me, this.device);
      if (mine && mine.state !== "done") await this.tx.discard(t.id).catch(() => undefined);
      this.setLocal(t.id, null);
    }
  }

  private async loop(kind: "up" | "down"): Promise<void> {
    while (!this.stopped) {
      const list = this.session.snapshot.transfers;
      if (kind === "down") await this.tidy(list);
      let job: Transfer | null = null;
      for (const t of [...list].reverse()) {
        if (t.state !== "open" || this.failed.has(t.id)) continue;
        if (kind === "up" ? await this.wantsUpload(t) : await this.wantsDownload(t)) {
          job = t;
          break;
        }
      }
      if (!job) {
        await this.sleep(IDLE_MS);
        continue;
      }
      try {
        if (kind === "up") await this.upload(job.id);
        else await this.download(job.id);
        // A job that found nothing to do after all does not spin: the next look waits for a change, or a moment.
        await this.sleep(100);
      } catch (err) {
        if (err instanceof RelayClientError && err.status === 0) {
          // The service away: as it was, a little later.
          await this.sleep(RETRY_MS);
          continue;
        }
        // Ended meanwhile (cancelled, expired, declined elsewhere): nothing to say about it.
        if (this.session.snapshot.transfers.find((x) => x.id === job.id)?.state !== "open") continue;
        this.failed.add(job.id);
        this.setLocal(job.id, { phase: "error", bytes: this.local.get(job.id)?.bytes ?? 0, file: this.local.get(job.id)?.file ?? "", error: shellError(err) });
      }
    }
  }

  private async wantsUpload(t: Transfer): Promise<boolean> {
    return t.from === this.me && t.fromDevice === this.device && t.targets.some((x) => x.state === "accepted") && t.files.some((f) => !f.done);
  }

  private async wantsDownload(t: Transfer): Promise<boolean> {
    const mine = myTarget(t, this.me, this.device);
    if (mine?.state !== "accepted") return false;
    const saved = await this.savedOf(t.id);
    if (!saved) return false;
    // Something to download, or everything here and the service not told yet.
    return t.files.some((f) => f.done && !saved.has(f.path)) || t.files.every((f) => saved.has(f.path));
  }

  /** The send as the service has it now. */
  private async fresh(id: string): Promise<Transfer> {
    const t = await this.session.client.transfer(id);
    this.session.putTransfer(t);
    return t;
  }

  private async upload(id: string): Promise<void> {
    const device = this.device!;
    // Where the service is now: what the session heard last can be a second old (pushes of pieces are spaced out).
    let t = await this.fresh(id);
    const sentBefore = (t: Transfer, index: number) => t.files.filter((f) => f.index !== index && f.done).reduce((n, f) => n + f.size, 0);
    for (const first of t.files) {
      if (first.done) continue;
      let restarts = 0;
      for (;;) {
        const f = t.files.find((x) => x.index === first.index)!;
        if (f.done) break;
        // What the pushes say (cancelled, declined) wins over the copy here, whose state is from the last fetch.
        const now = this.session.snapshot.transfers.find((x) => x.id === id);
        if (this.stopped || !now || now.state !== "open" || !now.targets.some((x) => x.state === "accepted")) return;
        const key = `${id}/${f.index}`;
        let sha = this.hashes.get(key);
        if (!sha) {
          this.setLocal(id, { phase: "hashing", bytes: sentBefore(t, f.index) + f.received, file: f.path });
          const h = await this.tx.hash(id, f.path);
          if (h.size !== f.size) throw new Error(`「${f.path}」的大小变了（选的时候 ${f.size} 字节，现在 ${h.size}）：取消后重新发`);
          sha = h.sha256;
          this.hashes.set(key, sha);
        }
        try {
          let offset = f.received;
          for (;;) {
            this.setLocal(id, { phase: "uploading", bytes: sentBefore(t, f.index) + offset, file: f.path });
            const data = await this.tx.read(id, f.path, offset, Math.min(TRANSFER_CHUNK, f.size - offset));
            const got = await this.session.client.putTransferPiece(id, f.index, { device, offset, sha256: sha }, data);
            offset = got.received;
            if (got.done) {
              // The send as known here, with this file done (not fetched again: a folder of thousands of small files
              // would fetch the whole list each time).
              t = { ...t, files: t.files.map((x) => (x.index === got.index ? got : x)) };
              break;
            }
            if (this.stopped) return;
            // Cancelled, or nobody left to receive, while this went: stop.
            const now = this.session.snapshot.transfers.find((x) => x.id === id);
            if (!now || now.state !== "open") return;
          }
        } catch (err) {
          if (!(err instanceof RelayClientError) || err.status !== 409) throw err;
          // The service is somewhere else (a lost answer, a restart), or the file started again there.
          if (/从头再传/.test(err.message)) {
            this.hashes.delete(key);
            if (++restarts > 3) throw err;
          }
          t = await this.fresh(id);
          if (t.state !== "open") return;
          if (!t.targets.some((x) => x.state === "accepted")) return;
        }
      }
    }
    this.setLocal(id, null);
  }

  private async download(id: string): Promise<void> {
    const device = this.device!;
    const saved = (await this.savedOf(id))!;
    let reported = 0;
    for (;;) {
      const t = this.session.snapshot.transfers.find((x) => x.id === id);
      if (!t || t.state !== "open" || myTarget(t, this.me, device)?.state !== "accepted") return;
      const savedBytes = () => t.files.filter((f) => saved.has(f.path)).reduce((n, f) => n + f.size, 0);
      if (t.files.every((f) => saved.has(f.path))) {
        this.session.putTransfer(await this.session.client.transferProgress(id, device, t.totalSize, true));
        this.setLocal(id, null);
        return;
      }
      const f = t.files.find((x) => x.done && !saved.has(x.path));
      if (!f) {
        this.setLocal(id, null);
        return;
      }
      let restarts = 0;
      for (;;) {
        let have = await this.tx.partSize(id, f.path);
        if (have < 0) {
          saved.add(f.path);
          break;
        }
        while (have < f.size) {
          this.setLocal(id, { phase: "downloading", bytes: savedBytes() + have, file: f.path });
          const data = await this.session.client.transferPiece(id, f.index, device, have, Math.min(have + TRANSFER_CHUNK, f.size) - 1);
          if (!data.length) throw new Error(`「${f.path}」下载不到内容`);
          await this.tx.write(id, f.path, have, data);
          have += data.length;
          if (this.stopped) return;
          if (Date.now() - reported > REPORT_MS) {
            reported = Date.now();
            void this.session.client.transferProgress(id, device, savedBytes() + have).catch(() => undefined);
          }
          const now = this.session.snapshot.transfers.find((x) => x.id === id);
          if (!now || now.state !== "open" || myTarget(now, this.me, device)?.state !== "accepted") return;
        }
        this.setLocal(id, { phase: "saving", bytes: savedBytes() + f.size, file: f.path });
        const done = await this.tx.finish(id, f.path, f.sha256!);
        if (done !== false) {
          saved.add(f.path);
          break;
        }
        if (++restarts > 3) throw new Error(`「${f.path}」下载了几次都校验不对`);
      }
    }
  }

  /** Accept on this device into `dir`: the names there first, then the service (which tells the sender to go). */
  async accept(t: Transfer, dir: string): Promise<void> {
    const state = await this.tx.prepare(t.id, dir, { roots: t.roots, folders: transferFolders(t), dirs: t.dirs });
    this.saved.set(t.id, new Set(state.done));
    try {
      this.session.putTransfer(await this.session.client.answerTransfer(t.id, this.device!, true));
    } catch (err) {
      await this.tx.discard(t.id).catch(() => undefined);
      this.saved.delete(t.id);
      throw err;
    }
    this.kick();
  }
}

export function useTransferState(engine: TransferEngine | null): Map<string, LocalState> {
  return useSyncExternalStore(engine ? engine.subscribe : () => () => undefined, engine ? engine.state : () => EMPTY);
}
const EMPTY = new Map<string, LocalState>();
