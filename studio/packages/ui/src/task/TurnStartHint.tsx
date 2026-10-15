import { useEffect, useRef, useState, type RefObject } from "react";
import { flash } from "./ReplyNav.js";

// 「按 ↑ 回到本轮回复开始」 (2026-10-15): when a turn of the open session ends with its start scrolled out of sight, a
// hint at the bottom of the conversation offers to go back there. The next thing the person does decides: ↑ (or a
// click on the hint) scrolls to where this turn's reply begins; any other key, click or scroll puts the hint away and
// does nothing else.

const EDGE = 12;
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

/** Where the last turn's reply begins: the first thing after the person's message (the folded work, or the answer). */
export function replyStart(scroller: HTMLElement): HTMLElement | null {
  const turns = scroller.querySelectorAll<HTMLElement>("section.turn");
  const last = turns[turns.length - 1];
  if (!last) return null;
  return [...last.children].find((c): c is HTMLElement => c instanceof HTMLElement && !c.classList.contains("msg-user-row")) ?? null;
}

export function useTurnStartHint(scroller: RefObject<HTMLDivElement | null>, sessionId: string | null, generating: boolean) {
  const [shown, setShown] = useState(false);
  const previous = useRef({ sessionId, generating });

  useEffect(() => {
    const before = previous.current;
    previous.current = { sessionId, generating };
    if (before.sessionId !== sessionId || generating) {
      setShown(false);
      return;
    }
    if (!before.generating) return;
    // The turn just ended here: offer the way back once the finished turn is laid out, if its start is out of sight.
    const frame = requestAnimationFrame(() => {
      const el = scroller.current;
      const start = el && replyStart(el);
      if (el && start && start.getBoundingClientRect().top < el.getBoundingClientRect().top) setShown(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [scroller, sessionId, generating]);

  const jump = () => {
    setShown(false);
    const el = scroller.current;
    const start = el && replyStart(el);
    if (!el || !start) return;
    el.scrollTop += start.getBoundingClientRect().top - el.getBoundingClientRect().top - EDGE;
    flash(start);
  };
  const jumpRef = useRef(jump);
  jumpRef.current = jump;

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (MODIFIERS.has(e.key) || e.isComposing) return;
      if (e.key === "ArrowUp" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        // Not the caret in the composer: this ↑ is the hint's.
        e.preventDefault();
        e.stopPropagation();
        jumpRef.current();
        return;
      }
      setShown(false);
    };
    const onPointer = (e: Event) => {
      if (e.target instanceof Element && e.target.closest("[data-turn-start-hint]")) return;
      setShown(false);
    };
    const onWheel = () => setShown(false);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, [shown]);

  return { shown, jump };
}

export function TurnStartHint({ raised, onJump }: { raised: boolean; onJump(): void }) {
  return (
    <button type="button" className={`turn-start-hint${raised ? " raised" : ""}`} data-turn-start-hint data-testid="turn-start-hint" onClick={onJump}>
      按 <kbd>↑</kbd> 回到本轮回复开始
    </button>
  );
}
