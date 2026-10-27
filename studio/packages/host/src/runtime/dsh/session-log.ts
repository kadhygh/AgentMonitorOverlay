import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { TurnDecode } from "@amo-studio/protocol";

// A DSH session's own log (2026-10-22): ACP reports only the context size, so the output tokens and their timing — a
// turn's speed — come from the log DSH keeps in its home: `sessions/<cwd>/<sessionId>/session.v4.jsonl.zstd`, one
// event per line (`turn/start`, `step/start`, `assistant/attempt`, `assistant/message` with `usage` and `stream`).
// Measured as DSH's own session-stats does (packages/session/session-stats/src/projection.ts): per model call, from its
// first output token to the assembled message, and that call's output tokens. Only the turn's own lines are parsed.

export interface DshTurnStats {
  /** When DSH started the turn (ms), to tell it from the one before. */
  startedAt: number;
  /** Generation time and output tokens of the turn's model calls; absent when none reported usage. */
  decode?: TurnDecode;
  input: number;
  cachedInput: number;
  output: number;
}

interface DshEvent {
  type: string;
  time: number;
  data?: { turn?: number; step?: number; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }; stream?: StreamRecord[] };
}

type StreamRecord =
  | { type: "chunk"; time: number; chunk: { type: string; text?: string; argumentsDelta?: string; name?: string } }
  | { type: "text-chunks" | "reasoning-chunks"; time0: number; dt: number[]; texts: string[] }
  | { type: "tool-call-chunks"; time0: number; dt: number[]; args: string[]; name?: string };

/** The session's log file in a DSH home, the newest format first; null when DSH has not written one. */
export function dshLogFile(home: string, sessionId: string): string | null {
  const root = join(home, "sessions");
  if (!existsSync(root)) return null;
  for (const cwd of readdirSync(root)) {
    const dir = join(root, cwd, sessionId);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => /^session\.v\d+\.jsonl(\.zstd)?$/.test(f));
    const version = (f: string) => Number(/^session\.v(\d+)/.exec(f)![1]);
    const best = files.sort((a, b) => version(b) - version(a))[0];
    if (best) return join(dir, best);
  }
  return null;
}

/** The latest turn of a DSH session (the one running, or the one just ended), from its log; null when unreadable. */
export function dshTurnStats(home: string, sessionId: string): DshTurnStats | null {
  // Unreadable (gone, or being written): try again later.
  const text = dshLogText(home, sessionId);
  return text === null ? null : turnStats(text);
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * A log DSH appends to, one zstd frame per write, decompressed frame by frame. 2026-10-27: Electron's
 * zstdDecompressSync stops after the first frame (system Node reads them all), so the Host saw one line of every log
 * and no DSH turn ever got its tokens or speed. A frame is cut at the next magic number (tried further when that one
 * lies inside compressed data); a last frame still being written is left out.
 */
export function zstdFrames(raw: Buffer): string {
  const out: Buffer[] = [];
  let start = 0;
  while (start < raw.length) {
    let end = raw.indexOf(ZSTD_MAGIC, start + 4);
    for (;;) {
      try {
        out.push(zstdDecompressSync(raw.subarray(start, end < 0 ? raw.length : end)));
        break;
      } catch (err) {
        if (end < 0) {
          if (out.length) return Buffer.concat(out).toString("utf8");
          throw err;
        }
        end = raw.indexOf(ZSTD_MAGIC, end + 4);
      }
    }
    start = end < 0 ? raw.length : end;
  }
  return Buffer.concat(out).toString("utf8");
}

/** The stats of the last turn in a log's text (exported for tests). */
export function turnStats(text: string): DshTurnStats | null {
  const at = text.lastIndexOf('"type":"turn/start"');
  if (at < 0) return null;
  const events = parseEvents(text.slice(text.lastIndexOf("\n", at) + 1));
  const turn = events[0]?.data?.turn;
  if (typeof turn !== "number") return null;
  return statsOf(events, turn, events[0]!.time);
}

/**
 * Every turn in a log's text, oldest first (2026-10-27): to fill in turns that ended before Studio could read DSH's
 * logs, matched to Studio's turns by when they started.
 */
export function allTurnStats(text: string): DshTurnStats[] {
  const events = parseEvents(text);
  const out: DshTurnStats[] = [];
  events.forEach((e, i) => {
    if (e.type === "turn/start" && typeof e.data?.turn === "number") out.push(statsOf(events.slice(i), e.data.turn, e.time));
  });
  return out;
}

/** A DSH log's text, read and decompressed; null when there is none or it cannot be read now. */
export function dshLogText(home: string, sessionId: string): string | null {
  const file = dshLogFile(home, sessionId);
  if (!file) return null;
  try {
    const raw = readFileSync(file);
    return file.endsWith(".zstd") ? zstdFrames(raw) : raw.toString("utf8");
  } catch {
    return null;
  }
}

function parseEvents(text: string): DshEvent[] {
  const events: DshEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as DshEvent);
    } catch {
      // A line still being written.
    }
  }
  return events;
}

/** One turn's tokens and generation time, from the events from its start on. */
function statsOf(events: readonly DshEvent[], turn: number, startedAt: number): DshTurnStats {
  const out: DshTurnStats = { startedAt, input: 0, cachedInput: 0, output: 0 };
  let ms = 0;
  let tokens = 0;
  let decoded = false;
  let open: { step: number; first: number | null } | null = null;
  for (const e of events) {
    if (e.data?.turn !== turn) continue;
    if (e.type === "step/start") open = { step: e.data.step ?? -1, first: null };
    else if (e.type === "assistant/attempt" && open && open.step === e.data.step && open.first === null) open.first = firstTokenTime(e.data.stream ?? []);
    else if (e.type === "assistant/message") {
      const usage = e.data.usage;
      if (usage) {
        const read = num(usage.cacheReadTokens);
        out.input += num(usage.inputTokens) + read + num(usage.cacheWriteTokens);
        out.cachedInput += read;
        out.output += num(usage.outputTokens);
      }
      if (!open || open.step !== e.data.step) continue;
      const first = open.first ?? firstTokenTime(e.data.stream ?? []);
      open = null;
      if (first === null || typeof usage?.outputTokens !== "number") continue;
      ms += Math.max(0, e.time - first);
      tokens += usage.outputTokens;
      decoded = true;
    }
  }
  return decoded ? { ...out, decode: { ms, tokens } } : out;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** When the first output token came, as DSH's assistantStreamFirstTokenTime (packages/llm/llm/src/assistant-stream.ts). */
function firstTokenTime(stream: readonly StreamRecord[]): number | null {
  for (const r of stream) {
    if (r.type === "chunk") {
      const c = r.chunk;
      const token = c.type === "text-delta" || c.type === "reasoning-delta" ? !!c.text : c.type === "tool-call-delta" ? !!c.argumentsDelta || c.name !== undefined : false;
      if (token) return r.time;
      continue;
    }
    if (r.type === "tool-call-chunks" && r.name !== undefined) return r.time0;
    const parts = r.type === "tool-call-chunks" ? r.args : r.texts;
    let time = r.time0;
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) time += r.dt[i - 1] ?? 0;
      if (parts[i] !== "") return time;
    }
  }
  return null;
}
