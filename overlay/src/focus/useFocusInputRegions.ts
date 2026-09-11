import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { measureInputRegions, regionPayload, type InputRegionPayload } from "./inputRegions";

export function useFocusInputRegions(root: RefObject<HTMLElement>, captureAll: boolean, visible: boolean) {
  const [error, setError] = useState("");
  const state = useRef({ captureAll, visible }); state.current = { captureAll, visible };
  const gesture = useRef(false);
  const control = useRef<{ update: () => void; full: () => Promise<void> } | null>(null);
  useEffect(() => {
    const element = root.current;
    // Browser previews do not own an HWND; their native ports are deliberately simulated.
    if (!element || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false, frame = 0, last = "", pending: InputRegionPayload | null = null;
    let pumping: Promise<void> | null = null;
    const fullPayload = () => regionPayload([], window.innerWidth, window.innerHeight, true);
    const queue = (payload: InputRegionPayload): Promise<void> => {
      const key = JSON.stringify(payload);
      if (key === last && !pending) return pumping ?? Promise.resolve();
      last = key; pending = payload;
      if (!pumping) pumping = (async () => {
        while (pending && !disposed) {
          const next = pending; pending = null;
          try { await invoke("set_focus_input_regions", { payload: next }); if (!disposed) setError(""); }
          catch (reason) {
            last = "";
            if (!disposed) setError(`窗口穿透暂不可用：${String(reason)}`);
            // Failing open preserves all controls even if a geometry update failed.
            await invoke("set_focus_input_regions", { payload: fullPayload() }).catch(() => undefined);
            break;
          }
        }
      })().finally(() => {
        pumping = null;
        if (pending && !disposed) { const next = pending; pending = null; last = ""; void queue(next); }
      });
      return pumping;
    };
    const measure = () => {
      frame = 0;
      if (disposed) return;
      const full = state.current.captureAll || !state.current.visible || gesture.current;
      void queue(full ? fullPayload() : regionPayload(measureInputRegions(element), window.innerWidth, window.innerHeight));
    };
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(measure); };
    control.current = { update: () => {
      if (state.current.captureAll || !state.current.visible || gesture.current) { cancelAnimationFrame(frame); frame = 0; void queue(fullPayload()); }
      else schedule();
    }, full: () => queue(fullPayload()) };
    const resize = new ResizeObserver(schedule);
    const observeSurfaces = () => { resize.disconnect(); resize.observe(element); element.querySelectorAll<HTMLElement>("[data-focus-region]").forEach(node => resize.observe(node)); };
    const changes = new MutationObserver(() => { observeSurfaces(); schedule(); });
    changes.observe(element, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
    observeSurfaces();
    element.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      disposed = true; pending = null; control.current = null; cancelAnimationFrame(frame);
      changes.disconnect(); resize.disconnect();
      element.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); window.removeEventListener("focus", schedule); document.removeEventListener("visibilitychange", schedule);
      void (pumping ?? Promise.resolve()).then(() => invoke("set_focus_input_regions", { payload: fullPayload() })).catch(() => undefined);
    };
  }, [root]);
  useLayoutEffect(() => { control.current?.update(); }, [captureAll, visible]);
  async function runWindowGesture(operation: () => Promise<void>) {
    gesture.current = true;
    try { await control.current?.full(); await operation(); }
    finally { gesture.current = false; control.current?.update(); }
  }
  return { inputRegionError: error, runWindowGesture };
}
