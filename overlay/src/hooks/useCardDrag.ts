import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type PointerEvent,
  type SetStateAction,
} from "react";
import { mergeSessionOrder } from "../domain/sessionModel";
import type { AgentSession } from "../types";

interface CardDragState {
  sessionId: string;
  pointerId: number;
  pointerY: number;
  offsetY: number;
  left: number;
  width: number;
  height: number;
}

interface UseCardDragOptions {
  orderedSessionsRef: MutableRefObject<AgentSession[]>;
  rowRefs: MutableRefObject<Map<string, HTMLDivElement>>;
  sessionsRef: MutableRefObject<AgentSession[]>;
  setFeedback: Dispatch<SetStateAction<string>>;
  setSessionOrder: Dispatch<SetStateAction<string[]>>;
  suppressNextClickRef: MutableRefObject<boolean>;
}

export function useCardDrag(options: UseCardDragOptions) {
  const [cardDrag, setCardDrag] = useState<CardDragState | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const cardDragRef = useRef<CardDragState | null>(null);
  const cardDragCleanupRef = useRef<(() => void) | null>(null);

  function moveDraggedSessionToIndex(draggingSessionId: string, targetIndex: number) {
    options.setSessionOrder((previousOrder) => {
      const currentSessions = options.sessionsRef.current;
      const orderedVisibleIds = options.orderedSessionsRef.current.map((session) => session.sessionId);
      const visibleWithoutDragged = orderedVisibleIds.filter((sessionId) => sessionId !== draggingSessionId);
      const baseOrder = mergeSessionOrder(previousOrder, currentSessions).filter(
        (sessionId) => sessionId !== draggingSessionId,
      );

      const beforeId = visibleWithoutDragged[targetIndex] ?? null;
      const afterId = targetIndex > 0 ? visibleWithoutDragged[targetIndex - 1] : null;
      const insertIndex = beforeId
        ? baseOrder.indexOf(beforeId)
        : afterId
          ? baseOrder.indexOf(afterId) + 1
          : baseOrder.length;

      const safeIndex = Math.max(0, Math.min(insertIndex, baseOrder.length));
      const nextOrder = [...baseOrder];
      nextOrder.splice(safeIndex, 0, draggingSessionId);

      if (nextOrder.join("\u0000") === mergeSessionOrder(previousOrder, currentSessions).join("\u0000")) {
        return previousOrder;
      }

      return nextOrder;
    });
  }

  function updateCardDrag(pointerY: number) {
    const activeDrag = cardDragRef.current;
    if (!activeDrag) {
      return;
    }

    const visibleTargets = options.orderedSessionsRef.current.filter(
      (session) => session.sessionId !== activeDrag.sessionId,
    );
    let targetIndex = visibleTargets.length;
    let nextDropTargetId: string | null = null;

    for (let index = 0; index < visibleTargets.length; index += 1) {
      const targetSession = visibleTargets[index];
      const targetElement = options.rowRefs.current.get(targetSession.sessionId);
      if (!targetElement) {
        continue;
      }

      const rect = targetElement.getBoundingClientRect();
      if (pointerY < rect.top + rect.height / 2) {
        targetIndex = index;
        nextDropTargetId = targetSession.sessionId;
        break;
      }

      nextDropTargetId = targetSession.sessionId;
    }

    setDropTargetId(nextDropTargetId);
    moveDraggedSessionToIndex(activeDrag.sessionId, targetIndex);
  }

  function startCardDrag(session: AgentSession, event: PointerEvent<HTMLElement>) {
    const row = options.rowRefs.current.get(session.sessionId);
    if (!row) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture can fail if the handle is remounted during a reorder.
    }

    const rect = row.getBoundingClientRect();
    const nextDrag = {
      sessionId: session.sessionId,
      pointerId: event.pointerId,
      pointerY: event.clientY,
      offsetY: event.clientY - rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    };
    cardDragRef.current = nextDrag;
    options.suppressNextClickRef.current = true;
    setCardDrag(nextDrag);
    setDropTargetId(null);
    options.setFeedback(`Dragging ${session.title}.`);
    attachCardDragListeners(event.pointerId);
  }

  function attachCardDragListeners(pointerId: number) {
    removeCardDragListeners();

    const handleMove = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId) {
        return;
      }

      event.preventDefault();
      continueCardDragAt(event.clientY);
    };

    const handleEnd = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId) {
        return;
      }

      event.preventDefault();
      finishCardDrag();
    };

    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleEnd, { passive: false });
    window.addEventListener("pointercancel", handleEnd, { passive: false });
    cardDragCleanupRef.current = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleEnd);
    };
  }

  function removeCardDragListeners() {
    cardDragCleanupRef.current?.();
    cardDragCleanupRef.current = null;
  }

  function continueCardDragAt(pointerY: number) {
    const activeDrag = cardDragRef.current;
    if (!activeDrag) {
      return;
    }

    const nextDrag = {
      ...activeDrag,
      pointerY,
    };
    cardDragRef.current = nextDrag;
    setCardDrag(nextDrag);
    updateCardDrag(pointerY);
  }

  function finishCardDrag() {
    if (!cardDragRef.current) {
      return;
    }

    removeCardDragListeners();
    cardDragRef.current = null;
    setCardDrag(null);
    setDropTargetId(null);
  }

  function endCardDrag(event: PointerEvent<HTMLElement>) {
    if (!cardDragRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    finishCardDrag();
  }

  useEffect(() => () => removeCardDragListeners(), []);

  return {
    cardDrag,
    dropTargetId,
    endCardDrag,
    startCardDrag,
  };
}
