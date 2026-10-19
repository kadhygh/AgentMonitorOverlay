import type { Annotation, Id, NewAnnotationInput } from "@amo-studio/protocol";
import { composeAnnotationMessage } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import type { SendMode } from "../../runtime/runtime.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/** Review (stage 2): annotations sent back to a session. The scratchpad has its own feature since stage 11. */
export class ReviewFeature extends Feature {
  annotations(sessionId: Id): Annotation[] {
    this.requireSession(sessionId);
    return this.store.listAnnotations(sessionId);
  }

  addAnnotation(sessionId: Id, input: NewAnnotationInput): Annotation {
    this.requireSession(sessionId);
    const item = this.store.getItem(String(input?.itemId ?? ""));
    if (!item || item.sessionId !== sessionId) throw new HostError("bad_request", "itemId must be an item of this session");
    if (item.type !== "agent") throw new HostError("bad_request", "only agent replies can be annotated");
    const quote = typeof input.quote === "string" ? input.quote : "";
    const note = typeof input.note === "string" ? input.note.trim() : "";
    if (!quote.trim()) throw new HostError("bad_request", "quote is required");
    if (!note) throw new HostError("bad_request", "note is required");
    const start = Number(input.start);
    const end = Number(input.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) throw new HostError("bad_request", "start/end must be a non-empty range");
    if (end > item.markdown.replace(/\r\n/g, "\n").length) throw new HostError("bad_request", "start/end lie outside the reply");
    const annotation: Annotation = {
      id: newId("an"),
      sessionId,
      itemId: item.id,
      quote,
      start,
      end,
      prefix: typeof input.prefix === "string" ? input.prefix.slice(-24) : "",
      suffix: typeof input.suffix === "string" ? input.suffix.slice(0, 24) : "",
      note,
      // 批注 1, 2, … in the session, never reused (a sent message may name a deleted one); nothing is renumbered.
      n: this.nextAnnotationNumber(sessionId),
      createdAt: new Date().toISOString(),
      sentAt: null,
    };
    this.store.putAnnotation(annotation);
    this.publish({ type: "annotation.upserted", annotation });
    return annotation;
  }

  /** Changes the note (unsent only) and/or pins it to the top of the panel (sent or not). */
  updateAnnotation(id: Id, patch: { note?: unknown; pinned?: unknown }): Annotation {
    const current = this.requireAnnotation(id);
    let next: Annotation = current;
    if (patch.note !== undefined) {
      if (current.sentAt) throw new HostError("conflict", "sent annotations cannot be edited");
      const trimmed = typeof patch.note === "string" ? patch.note.trim() : "";
      if (!trimmed) throw new HostError("bad_request", "note is required");
      next = { ...next, note: trimmed };
    }
    if (patch.pinned !== undefined) {
      if (typeof patch.pinned !== "boolean") throw new HostError("bad_request", "pinned must be true or false");
      next = { ...next, pinnedAt: patch.pinned ? (current.pinnedAt ?? new Date().toISOString()) : null };
    }
    if (next === current) throw new HostError("bad_request", "give note or pinned");
    this.store.putAnnotation(next);
    this.publish({ type: "annotation.upserted", annotation: next });
    return next;
  }

  deleteAnnotation(id: Id): void {
    const current = this.requireAnnotation(id);
    this.store.deleteAnnotation(id);
    this.publish({ type: "annotation.removed", sessionId: current.sessionId, annotationId: id });
  }

  /** Sends all unsent annotations as one message (reply order, then position in the reply) and marks them sent. */
  async sendAnnotations(sessionId: Id): Promise<{ mode: SendMode; sent: Annotation[] }> {
    const pending = this.annotations(sessionId).filter((a) => !a.sentAt);
    if (!pending.length) throw new HostError("bad_request", "no annotations to send");
    // The same message as referring to them from the composer (2026-10-15), without text of the person's own.
    const result = await this.f.sessions.sendMessage(sessionId, "", [], pending.map((a) => a.id));
    const sent = pending.map((a) => this.store.getAnnotation(a.id) ?? a);
    return { mode: result.mode, sent };
  }

  private nextAnnotationNumber(sessionId: Id): number {
    const key = `annotation-seq:${sessionId}`;
    const n = Math.max(Number(this.store.getKv(key)?.value ?? 0) || 0, this.annotationNumbers(sessionId).max) + 1;
    this.store.setKv(key, String(n));
    return n;
  }

  /** Each annotation's number; older ones made before numbers existed count in the order they were made. */
  annotationNumbers(sessionId: Id): { of(a: Annotation): number; max: number } {
    const list = [...this.store.listAnnotations(sessionId)].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const numbers = new Map<Id, number>();
    let max = 0;
    for (const a of list) {
      const n = a.n ?? max + 1;
      numbers.set(a.id, n);
      max = Math.max(max, n);
    }
    return { of: (a) => numbers.get(a.id) ?? a.n ?? 0, max };
  }

  /**
   * The annotations a message refers to, numbered, and marks them sent once it went out. Annotations of another
   * session are refused.
   */
  referencedAnnotations(sessionId: Id, ids: readonly Id[]): { refs: Array<{ n: number; quote: string; note: string }>; markSent(): void } {
    const all = this.store.listAnnotations(sessionId);
    const numbers = this.annotationNumbers(sessionId);
    const chosen = [...new Set(ids)].map((id) => {
      const a = all.find((x) => x.id === id);
      if (!a) throw new HostError("bad_request", `annotation ${id} is not one of this session's`);
      return a;
    });
    return {
      refs: chosen.map((a) => ({ n: numbers.of(a), quote: a.quote, note: a.note })),
      markSent: () => {
        const at = new Date().toISOString();
        for (const a of chosen) {
          const next = { ...a, n: numbers.of(a), sentAt: at };
          this.store.putAnnotation(next);
          this.publish({ type: "annotation.upserted", annotation: next });
        }
      },
    };
  }

  private requireAnnotation(id: Id): Annotation {
    const a = this.store.getAnnotation(id);
    if (!a) throw new HostError("not_found", `annotation ${id} not found`);
    return a;
  }
}
