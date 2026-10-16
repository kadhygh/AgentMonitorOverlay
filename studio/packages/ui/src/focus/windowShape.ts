import { useEffect, useLayoutEffect, useRef } from "react";
import { shapeRects } from "./attention.js";

// Focus window shape (stage 16 split out of FocusApp.tsx).

/**
 * Tells the main process which parts of the window are Focus — the panel, the robot, the settings box — so clicks
 * anywhere else go to the windows below. Sent when their boxes change.
 */
export function useWindowShape() {
  const last = useRef("");
  const send = useRef(() => {});
  send.current = () => {
    const boxes = [...document.querySelectorAll<HTMLElement>(".focus-panel, .pixel-bot, .focus-pop")].map((el) => el.getBoundingClientRect());
    const rects = shapeRects(boxes, { width: window.innerWidth, height: window.innerHeight });
    const key = JSON.stringify(rects);
    if (!rects.length || key === last.current) return;
    last.current = key;
    window.amo?.focus?.setShape?.(rects);
  };
  const observer = useRef<ResizeObserver | null>(null);
  useEffect(() => {
    observer.current = new ResizeObserver(() => send.current());
    const onResize = () => send.current();
    window.addEventListener("resize", onResize);
    return () => {
      observer.current?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, []);
  // After every render: watch the parts there are now, and send their boxes if they moved.
  useLayoutEffect(() => {
    for (const el of document.querySelectorAll(".focus-panel, .pixel-bot, .focus-pop")) observer.current?.observe(el);
    send.current();
    // Once the robot's pop-in (a scale animation, which no observer sees) is over.
    const t = setTimeout(() => send.current(), 300);
    return () => clearTimeout(t);
  });
}
