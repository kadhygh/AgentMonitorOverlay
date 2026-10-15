import { useEffect, useState } from "react";
import type { Annotation } from "@amo-studio/protocol";

// Which annotations the next message refers to (2026-10-15, like quoting in a chat app): an annotation not yet sent
// is referred to unless the person took its tag off the composer; a sent one only when they chose 「继续引用」. Kept
// per session for this window, shared by the composer and the right column.

interface Choice {
  /** Unsent ones the person took off. */
  off: Set<string>;
  /** Sent ones the person wants referred to again. */
  again: Set<string>;
}

const choices = new Map<string, Choice>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
const choiceOf = (sessionId: string) => {
  let c = choices.get(sessionId);
  if (!c) choices.set(sessionId, (c = { off: new Set(), again: new Set() }));
  return c;
};

/** The annotation's number, 批注 N (older ones without one count in the order they were made). */
export function annotationNumber(a: Annotation, all: readonly Annotation[]): number {
  if (a.n) return a.n;
  const sorted = [...all].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  let max = 0;
  for (const x of sorted) {
    const n = x.n ?? max + 1;
    if (x.id === a.id) return n;
    max = Math.max(max, n);
  }
  return max + 1;
}

export interface AnnotationRefs {
  /** Referred to by the next message, in number order. */
  list: Annotation[];
  has(id: string): boolean;
  add(id: string): void;
  remove(id: string): void;
  /** After a message went out: the sent ones are referred to no more. */
  sent(): void;
}

export function useAnnotationRefs(sessionId: string | null, annotations: readonly Annotation[]): AnnotationRefs {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const c = sessionId ? choiceOf(sessionId) : { off: new Set<string>(), again: new Set<string>() };
  const list = annotations.filter((a) => (a.sentAt ? c.again.has(a.id) : !c.off.has(a.id))).sort((x, y) => annotationNumber(x, annotations) - annotationNumber(y, annotations));
  return {
    list,
    has: (id) => list.some((a) => a.id === id),
    add: (id) => {
      if (!sessionId) return;
      const a = annotations.find((x) => x.id === id);
      if (a?.sentAt) c.again.add(id);
      else c.off.delete(id);
      changed();
    },
    remove: (id) => {
      if (!sessionId) return;
      const a = annotations.find((x) => x.id === id);
      if (a?.sentAt) c.again.delete(id);
      else c.off.add(id);
      changed();
    },
    sent: () => {
      if (!sessionId) return;
      c.again.clear();
      changed();
    },
  };
}
