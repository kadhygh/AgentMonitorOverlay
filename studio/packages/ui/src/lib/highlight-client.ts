import { ensureLanguage, highlightLines, type CodeToken } from "./highlight-core.js";
import type { HighlightDone, HighlightJob } from "./highlight.worker.js";

// Colouring long texts in the highlight worker, one job at a time: what the person opened goes first, what was read
// ahead waits. Without workers (tests) or when the worker fails, jobs run in the window, one per task.

interface Job {
  lang: string;
  texts: string[];
  /** Lets a waiting job be moved to the front (the same file, opened now). */
  key?: object;
  resolve(tokens: (CodeToken[][] | null)[]): void;
}

let worker: Worker | null | undefined;
const queue: Job[] = [];
let busy: { id: number; job: Job } | null = null;
let nextId = 1;

function startWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = typeof Worker === "undefined" ? null : new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
  } catch {
    worker = null;
  }
  if (worker) {
    worker.onmessage = (e: MessageEvent<HighlightDone>) => {
      if (busy?.id !== e.data.id) return;
      const { job } = busy;
      busy = null;
      job.resolve(e.data.tokens);
      pump();
    };
    worker.onerror = () => {
      // The worker could not start (or broke): carry on in the window.
      worker?.terminate();
      worker = null;
      if (busy) queue.unshift(busy.job);
      busy = null;
      pump();
    };
  }
  return worker;
}

function pump(): void {
  if (busy || !queue.length) return;
  const job = queue.shift()!;
  const id = nextId++;
  busy = { id, job };
  const w = startWorker();
  if (w) {
    w.postMessage({ id, lang: job.lang, texts: job.texts } satisfies HighlightJob);
    return;
  }
  setTimeout(() => {
    void ensureLanguage(job.lang).then((ok) => {
      busy = null;
      job.resolve(job.texts.map((t) => (ok ? highlightLines(t, job.lang) : null)));
      pump();
    });
  }, 0);
}

/** Each text's lines as tokens (null for a text the grammar could not colour), from the worker. */
export function highlightTexts(texts: string[], lang: string, opts: { urgent?: boolean; key?: object } = {}): Promise<(CodeToken[][] | null)[]> {
  return new Promise((resolve) => {
    const job: Job = { lang, texts, resolve, ...(opts.key ? { key: opts.key } : {}) };
    if (opts.urgent) queue.unshift(job);
    else queue.push(job);
    pump();
  });
}

/** Moves the waiting job for `key` to the front (it was read ahead and is now opened). */
export function hurry(key: object): void {
  const i = queue.findIndex((j) => j.key === key);
  if (i > 0) queue.unshift(...queue.splice(i, 1));
}
