import type { Annotation, Id, NewAnnotationInput, Scratchpad } from "@amo-studio/protocol";
import { composeAnnotationMessage } from "@amo-studio/protocol";
import { newId } from "../../store/store.js";
import type { SendMode } from "../../runtime/runtime.js";
import { HostError, SCRATCHPAD_KEY } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/** Review (stage 2): the scratchpad and annotations sent back to a session. */
export class ReviewFeature extends Feature {
  scratchpad(): Scratchpad {
    const kv = this.store.getKv(SCRATCHPAD_KEY);
    return { text: kv?.value ?? "", updatedAt: kv?.updatedAt ?? null };
  }

  saveScratchpad(text: unknown): Scratchpad {
    if (typeof text !== "string") throw new HostError("bad_request", "text must be a string");
    if (text.length > 200_000) throw new HostError("bad_request", "scratchpad is limited to 200000 characters");
    const kv = this.store.setKv(SCRATCHPAD_KEY, text);
    const scratchpad = { text: kv.value, updatedAt: kv.updatedAt };
    this.publish({ type: "scratchpad.updated", scratchpad });
    return scratchpad;
  }

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
      createdAt: new Date().toISOString(),
      sentAt: null,
    };
    this.store.putAnnotation(annotation);
    this.publish({ type: "annotation.upserted", annotation });
    return annotation;
  }

  updateAnnotation(id: Id, note: string): Annotation {
    const current = this.requireAnnotation(id);
    if (current.sentAt) throw new HostError("conflict", "sent annotations cannot be edited");
    const trimmed = typeof note === "string" ? note.trim() : "";
    if (!trimmed) throw new HostError("bad_request", "note is required");
    const next = { ...current, note: trimmed };
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
    const seq = (a: Annotation) => this.store.getItem(a.itemId)?.seq ?? Number.MAX_SAFE_INTEGER;
    pending.sort((a, b) => seq(a) - seq(b) || a.start - b.start);
    const result = await this.f.sessions.sendMessage(sessionId, composeAnnotationMessage(pending));
    const at = new Date().toISOString();
    const sent = pending.map((a) => {
      const next = { ...a, sentAt: at };
      this.store.putAnnotation(next);
      this.publish({ type: "annotation.upserted", annotation: next });
      return next;
    });
    return { mode: result.mode, sent };
  }

  private requireAnnotation(id: Id): Annotation {
    const a = this.store.getAnnotation(id);
    if (!a) throw new HostError("not_found", `annotation ${id} not found`);
    return a;
  }
}
