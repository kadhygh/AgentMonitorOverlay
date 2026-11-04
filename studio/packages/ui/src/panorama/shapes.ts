// Topics' region shapes, asked for without blocking (11-04, the user: opening took 2–3 s with the page frozen; now an
// opening animation plays while they are worked out). A Web Worker computes them (regions.worker.ts) one topic a message,
// each answered as soon as it is done; the answers go into regions.ts's cache (by theme and content), so the next layout
// — or the next time the page opens in this window — has them at once. Where no worker can start (tests, a page that
// does not allow one) they are computed here, one topic a task, so the page still gets to draw between them.
import { cachedShape, putShape, shapeKey, topicShape, type TopicFrame, type TopicShape, type WorldKind } from "./regions.js";

type Done = (shape: TopicShape, ms: number) => void;

const jobs = new Map<string, { frame: TopicFrame; kind: WorldKind; done: Done[] }>();
let worker: Worker | null | undefined;

function finish(key: string, shape: TopicShape, ms: number): void {
  putShape(key, shape);
  const job = jobs.get(key);
  jobs.delete(key);
  for (const d of job?.done ?? []) d(shape, ms);
}

function here(key: string): void {
  setTimeout(() => {
    const job = jobs.get(key);
    if (!job) return;
    const t0 = performance.now();
    finish(key, topicShape(job.frame, job.kind), performance.now() - t0);
  }, 0);
}

function start(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./regions.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ key: string; shape: TopicShape; ms: number }>) => finish(e.data.key, e.data.shape, e.data.ms);
    // It could not start (or broke): what it had is done here.
    worker.onerror = () => {
      worker?.terminate();
      worker = null;
      for (const key of jobs.keys()) here(key);
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** A topic's shape: `done` at once when known, else when worked out (in the order asked). Returns the cache key. */
export function requestShape(frame: TopicFrame, kind: WorldKind, done: Done): string {
  const key = shapeKey(frame, kind);
  const hit = cachedShape(key);
  if (hit) {
    done(hit, 0);
    return key;
  }
  const job = jobs.get(key);
  if (job) {
    job.done.push(done);
    return key;
  }
  jobs.set(key, { frame, kind, done: [done] });
  const w = start();
  if (w) w.postMessage({ key, frame, kind });
  else here(key);
  return key;
}

/** The shape if it is known already. */
export function knownShape(frame: TopicFrame, kind: WorldKind): TopicShape | undefined {
  return cachedShape(shapeKey(frame, kind));
}
