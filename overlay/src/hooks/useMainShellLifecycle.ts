import { useEffect, useLayoutEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export function useMainShellLifecycle() {
  useLayoutEffect(() => {
    void invoke("complete_startup").catch(() => {
      // Browser previews have no native startup window to replace.
    });
  }, []);

  useEffect(() => {
    let disposed = false;
    let paintTimeout: number | null = null;
    const paintFrame = window.requestAnimationFrame(() => {
      paintTimeout = window.setTimeout(() => {
        if (disposed) return;
        void invoke("signal_frontend_ready").catch(() => {
          // Browser previews do not expose the native smoke marker.
        });
      }, 0);
    });

    return () => {
      disposed = true;
      window.cancelAnimationFrame(paintFrame);
      if (paintTimeout !== null) window.clearTimeout(paintTimeout);
    };
  }, []);
}
