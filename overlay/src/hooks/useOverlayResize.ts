import { useRef, useState, type Dispatch, type PointerEvent, type SetStateAction } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

type ResizeMode = "vertical" | "horizontal" | "both";

interface ResizeState {
  mode: ResizeMode;
  startScreenX: number;
  startScreenY: number;
  startWidth: number;
  startHeight: number;
}

interface UseOverlayResizeOptions {
  collapsed: boolean;
  setFeedback: Dispatch<SetStateAction<string>>;
}

export function useOverlayResize(options: UseOverlayResizeOptions) {
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<ResizeState | null>(null);

  async function startWindowResize(event: PointerEvent<HTMLElement>, mode: ResizeMode) {
    if (options.collapsed) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    try {
      const size = await getCurrentWindow().innerSize();
      resizeRef.current = {
        mode,
        startScreenX: event.screenX,
        startScreenY: event.screenY,
        startWidth: size.width,
        startHeight: size.height,
      };
      setIsResizing(true);
      options.setFeedback("Resizing overlay.");
    } catch {
      resizeRef.current = null;
      setIsResizing(false);
    }
  }

  function continueWindowResize(event: PointerEvent<HTMLElement>) {
    const activeResize = resizeRef.current;
    if (!activeResize) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const nextWidth =
      activeResize.mode === "vertical"
        ? activeResize.startWidth
        : Math.max(320, Math.min(900, activeResize.startWidth + event.screenX - activeResize.startScreenX));
    const nextHeight =
      activeResize.mode === "horizontal"
        ? activeResize.startHeight
        : Math.max(280, Math.min(900, activeResize.startHeight + event.screenY - activeResize.startScreenY));

    void getCurrentWindow().setSize(new LogicalSize(nextWidth, nextHeight)).catch(() => undefined);
  }

  function endWindowResize(event: PointerEvent<HTMLElement>) {
    if (!resizeRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = null;
    setIsResizing(false);
  }

  return {
    continueWindowResize,
    endWindowResize,
    isResizing,
    startWindowResize,
  };
}
