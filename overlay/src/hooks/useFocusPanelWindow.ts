import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getOrCreateUtilityWindow } from "./useMainUtilityWindows";
import { bringUtilityWindowToFront, publishFocusWindowVisibility } from "../windows/utilityWindow";

export function useFocusPanelWindow(setFeedback: (message: string) => void) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const transition = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = async () => {
      const revision = ++epoch.current;
      try {
        const target = await WebviewWindow.getByLabel("focus");
        const showing = !!target && await target.isVisible();
        if (!disposed && revision === epoch.current) setVisible(showing);
      } catch { /* Keep the last known visibility until the next event/reconciliation. */ }
    };
    void getCurrentWindow().listen<boolean>("amo-focus-window-state", event => {
      if (typeof event.payload !== "boolean") return;
      epoch.current++;
      setVisible(event.payload);
    }).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => undefined);
    window.addEventListener("focus", sync);
    void sync();
    return () => { disposed = true; epoch.current++; unlisten?.(); window.removeEventListener("focus", sync); };
  }, []);

  async function toggle() {
    if (transition.current) return;
    transition.current = true;
    setBusy(true);
    epoch.current++;
    try {
      const existing = await WebviewWindow.getByLabel("focus");
      if (existing && await existing.isVisible()) {
        await existing.hide();
        await publishFocusWindowVisibility(existing, false);
        setVisible(false);
        setFeedback("Focus Panel hidden. Your processing queue is preserved.");
      } else {
        await getOrCreateUtilityWindow("focus");
        await bringUtilityWindowToFront("focus");
        setVisible(true);
        setFeedback("Focus Panel opened.");
      }
    } catch (error) {
      const existing = await WebviewWindow.getByLabel("focus").catch(() => null);
      setVisible(existing ? await existing.isVisible().catch(() => false) : false);
      setFeedback(`Focus Panel could not be toggled: ${(error as Error).message}`);
    } finally { epoch.current++; transition.current = false; setBusy(false); }
  }
  return { focusPanelVisible: visible, focusPanelBusy: busy, toggleFocusPanel: toggle };
}
