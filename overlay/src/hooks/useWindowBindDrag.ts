import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type PointerEvent,
  type SetStateAction,
} from "react";
import { targetBindingForSession } from "../domain/routingModel";
import type { AgentSession } from "../types";

interface WindowBindDragState {
  sessionId: string;
  pointerId: number;
  pointerX: number;
  pointerY: number;
}

interface UseWindowBindDragOptions {
  bindWindowAtCursor: (session: AgentSession) => Promise<void>;
  sessionsRef: MutableRefObject<AgentSession[]>;
  setFeedback: Dispatch<SetStateAction<string>>;
  suppressNextClickRef: MutableRefObject<boolean>;
}

export function useWindowBindDrag(options: UseWindowBindDragOptions) {
  const [windowBindDrag, setWindowBindDrag] = useState<WindowBindDragState | null>(null);
  const windowBindDragRef = useRef<WindowBindDragState | null>(null);
  const windowBindDragCleanupRef = useRef<(() => void) | null>(null);

  function startWindowBindDrag(session: AgentSession, event: PointerEvent<HTMLElement>) {
    const currentTarget = targetBindingForSession(session);
    if (currentTarget && currentTarget.type !== "codex-cli-session") {
      options.setFeedback("This card already has a target. Unbind it before dragging to a different window.");
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail if the button is remounted while the card updates.
    }

    const nextDrag = {
      sessionId: session.sessionId,
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
    };
    windowBindDragRef.current = nextDrag;
    options.suppressNextClickRef.current = true;
    setWindowBindDrag(nextDrag);
    options.setFeedback(`Drag to the target CLI/app window and release to bind ${session.title}.`);
    attachWindowBindDragListeners(event.pointerId);
  }

  function attachWindowBindDragListeners(pointerId: number) {
    removeWindowBindDragListeners();

    const handleMove = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId) {
        return;
      }

      event.preventDefault();
      continueWindowBindDragAt(event.clientX, event.clientY);
    };

    const handleEnd = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId) {
        return;
      }

      event.preventDefault();
      void finishWindowBindDrag();
    };

    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleEnd, { passive: false });
    window.addEventListener("pointercancel", handleEnd, { passive: false });
    windowBindDragCleanupRef.current = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
    };
  }

  function removeWindowBindDragListeners() {
    windowBindDragCleanupRef.current?.();
    windowBindDragCleanupRef.current = null;
  }

  function continueWindowBindDragAt(pointerX: number, pointerY: number) {
    const activeDrag = windowBindDragRef.current;
    if (!activeDrag) {
      return;
    }

    const nextDrag = {
      ...activeDrag,
      pointerX,
      pointerY,
    };
    windowBindDragRef.current = nextDrag;
    setWindowBindDrag(nextDrag);
  }

  async function finishWindowBindDrag() {
    const activeDrag = windowBindDragRef.current;
    if (!activeDrag) {
      return;
    }

    removeWindowBindDragListeners();
    windowBindDragRef.current = null;
    setWindowBindDrag(null);

    const session = options.sessionsRef.current.find((item) => item.sessionId === activeDrag.sessionId);
    if (!session) {
      options.setFeedback("The card is no longer available.");
      return;
    }

    const currentTarget = targetBindingForSession(session);
    if (currentTarget && currentTarget.type !== "codex-cli-session") {
      options.setFeedback("This card already has a target binding.");
      return;
    }

    await options.bindWindowAtCursor(session);
  }

  useEffect(() => () => removeWindowBindDragListeners(), []);

  return {
    startWindowBindDrag,
    windowBindDrag,
  };
}
