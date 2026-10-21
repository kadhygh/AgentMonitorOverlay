import { useEffect, useRef, useState, type RefObject } from "react";
import { flash } from "./ReplyNav.js";
import { pinScroll } from "../lib/scrollPin.js";

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

/**
 * `arrived`: the session was opened to deal with it — it waited for the person (an approval, a question, a review) or
 * its reply had ended unseen (2026-10-21: from Focus, the board, the session list). Then the hint is offered too, once
 * its items are in (`loaded`), whatever the turn is doing.
 */
export function useTurnStartHint(scroller: RefObject<HTMLDivElement | null>, sessionId: string | null, generating: boolean, arrived = false, loaded = true) {
  const [shown, setShown] = useState(false);
  const previous = useRef({ sessionId, generating });
  // Set when a session is opened to deal with it, until the hint has been offered (or not) once.
  const arrival = useRef<string | null>(arrived ? sessionId : null);

  const offerIfOutOfSight = () => {
    const el = scroller.current;
    const start = el && replyStart(el);
    if (el && start && start.getBoundingClientRect().top < el.getBoundingClientRect().top) setShown(true);
  };

  useEffect(() => {
    const before = previous.current;
    previous.current = { sessionId, generating };
    if (before.sessionId !== sessionId) {
      setShown(false);
      arrival.current = arrived ? sessionId : null;
      return;
    }
    if (generating) {
      setShown(false);
      return;
    }
    if (!before.generating) return;
    // The turn just ended here: offer the way back once the finished turn is laid out, if its start is out of sight.
    const frame = requestAnimationFrame(offerIfOutOfSight);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `arrived` is read when the session changes
  }, [scroller, sessionId, generating]);

  // Opened to deal with it: once its conversation is laid out (and followed to the end), if the turn's start is above.
  useEffect(() => {
    if (!loaded || !sessionId || arrival.current !== sessionId) return;
    let frame = requestAnimationFrame(
      () =>
        (frame = requestAnimationFrame(() => {
          arrival.current = null;
          offerIfOutOfSight();
        })),
    );
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the items arrive
  }, [sessionId, loaded]);

  const jump = () => {
    setShown(false);
    const el = scroller.current;
    const start = el && replyStart(el);
    if (!el || !start) return;
    pinScroll(el, () => start.getBoundingClientRect().top - el.getBoundingClientRect().top - EDGE);
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
