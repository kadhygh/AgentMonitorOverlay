import type { GitChangedFile, GitFileDiff, GitRange } from "@amo-studio/protocol";

// The review window's diffs, kept once read (stage 12 follow-up): a file opened again shows at once, and the files
// next to the selection (and the one under the pointer) are read ahead in the background, a couple at a time.

export interface DiffRequest {
  range: GitRange;
  /** The commit the range compares with (rangeBase of the listing's status). */
  base: string;
  file: GitChangedFile;
}

/** Files this large are only read when opened. */
export const PREFETCH_MAX_CHANGES = 3000;

export const diffKey = ({ range, base, file }: DiffRequest) => `${range}\u0000${base}\u0000${file.oldPath ?? ""}\u0000${file.path}`;

export class DiffCache {
  /** Read diffs, least recently used first. */
  private readonly done = new Map<string, GitFileDiff>();
  private readonly pending = new Map<string, Promise<GitFileDiff>>();
  private queue: DiffRequest[] = [];
  private running = 0;
  /** Bumped by clear(): answers to older requests are not kept. */
  private generation = 0;

  constructor(
    private readonly fetchDiff: (req: DiffRequest) => Promise<GitFileDiff>,
    private readonly onRead: (diff: GitFileDiff) => void = () => {},
    private readonly max = 60,
    private readonly parallel = 2,
  ) {}

  /** A diff already read (and now the most recently used). */
  peek(req: DiffRequest): GitFileDiff | undefined {
    const key = diffKey(req);
    const hit = this.done.get(key);
    if (hit) {
      this.done.delete(key);
      this.done.set(key, hit);
    }
    return hit;
  }

  /** The diff, read now (or joined with a read already on its way). */
  load(req: DiffRequest): Promise<GitFileDiff> {
    const hit = this.peek(req);
    if (hit) return Promise.resolve(hit);
    const key = diffKey(req);
    const on = this.pending.get(key);
    if (on) return on;
    const generation = this.generation;
    const p = this.fetchDiff(req).then(
      (diff) => {
        if (generation === this.generation) {
          this.pending.delete(key);
          this.done.set(key, diff);
          while (this.done.size > this.max) this.done.delete(this.done.keys().next().value!);
          this.onRead(diff);
        }
        return diff;
      },
      (err: unknown) => {
        if (generation === this.generation) this.pending.delete(key);
        throw err;
      },
    );
    this.pending.set(key, p);
    return p;
  }

  /** Reads these ahead, in order, replacing what was waiting; files read, on their way or very large are skipped. */
  prefetch(reqs: readonly DiffRequest[]): void {
    this.queue = reqs.filter((r) => r.file.additions + r.file.deletions <= PREFETCH_MAX_CHANGES && !this.done.has(diffKey(r)) && !this.pending.has(diffKey(r)));
    this.pump();
  }

  /** Forgets everything (the files changed on disk: 刷新). */
  clear(): void {
    this.generation++;
    this.done.clear();
    this.pending.clear();
    this.queue = [];
  }

  get size(): number {
    return this.done.size;
  }

  private pump(): void {
    while (this.running < this.parallel && this.queue.length) {
      const req = this.queue.shift()!;
      if (this.done.has(diffKey(req)) || this.pending.has(diffKey(req))) continue;
      // Reads still on their way when the cache is cleared count until they end.
      this.running++;
      this.load(req)
        .catch(() => undefined)
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}
