import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  bringUtilityWindowToFront,
  setAmoWindowAlwaysOnTop,
  type UtilityWindowKind,
  type UtilityWindowStateEvent,
} from "../windows/utilityWindow";

interface UseMainUtilityWindowsOptions {
  setFeedback: Dispatch<SetStateAction<string>>;
}

export function useMainUtilityWindows(options: UseMainUtilityWindowsOptions) {
  const [activeUtilityWindow, setActiveUtilityWindow] = useState<UtilityWindowKind | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .listen<UtilityWindowStateEvent>("amo-utility-window-state", (event) => {
        const payload = event.payload;
        if (!payload?.label) return;
        setActiveUtilityWindow((current) => {
          if (payload.open) {
            return payload.label;
          }
          return current === payload.label ? null : current;
        });
      })
      .then((handler) => {
        unlisten = handler;
      });

    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!activeUtilityWindow) return undefined;

    const label = activeUtilityWindow;
    const sync = () => void syncUtilityWindowState(label);
    const intervalId = window.setInterval(sync, 1200);
    window.addEventListener("focus", sync);
    void syncUtilityWindowState(label);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", sync);
    };
  }, [activeUtilityWindow]);

  async function openDeployDialog() {
    await openUtilityWindow("deploy");
  }

  async function openSettingsDialog() {
    await openUtilityWindow("settings");
  }

  async function openPriorityDialog() {
    await openUtilityWindow("priorities");
  }

  async function openUtilityWindow(label: UtilityWindowKind) {
    setActiveUtilityWindow(label);
    try {
      const utilityLabels: UtilityWindowKind[] = ["deploy", "settings", "priorities"];
      await Promise.all(
        utilityLabels.filter((otherLabel) => otherLabel !== label).map(async (otherLabel) => {
          const otherWindow = await WebviewWindow.getByLabel(otherLabel);
          if (otherWindow) await otherWindow.hide();
          await setAmoWindowAlwaysOnTop(otherLabel, false);
        }),
      );
      const targetWindow = await WebviewWindow.getByLabel(label);
      if (!targetWindow) {
        throw new Error(`${label} window is not registered`);
      }
      await bringUtilityWindowToFront(label);
      const title = label === "deploy" ? "Workspace Center" : label === "settings" ? "Settings" : "Task Priorities";
      options.setFeedback(`${title} opened.`);
    } catch (error) {
      setActiveUtilityWindow(null);
      options.setFeedback(`Open ${label} window failed: ${(error as Error).message}`);
    }
  }

  async function hideUtilityWindow(label: UtilityWindowKind) {
    try {
      const targetWindow = await WebviewWindow.getByLabel(label);
      await targetWindow?.hide();
      await setAmoWindowAlwaysOnTop(label, false);
      await setAmoWindowAlwaysOnTop("main", true);
    } catch {
      // A missing utility window should still unblock the main window.
    } finally {
      setActiveUtilityWindow((current) => (current === label ? null : current));
    }
  }

  async function focusUtilityWindow(label: UtilityWindowKind) {
    try {
      await bringUtilityWindowToFront(label);
    } catch (error) {
      setActiveUtilityWindow(null);
      options.setFeedback(`Focus ${label} window failed: ${(error as Error).message}`);
    }
  }

  async function syncUtilityWindowState(label: UtilityWindowKind) {
    try {
      const targetWindow = await WebviewWindow.getByLabel(label);
      const visible = targetWindow ? await targetWindow.isVisible() : false;
      if (!visible) {
        setActiveUtilityWindow((current) => (current === label ? null : current));
        await setAmoWindowAlwaysOnTop("main", true);
      }
    } catch {
      setActiveUtilityWindow((current) => (current === label ? null : current));
      await setAmoWindowAlwaysOnTop("main", true);
    }
  }

  return {
    activeUtilityWindow,
    focusUtilityWindow,
    hideUtilityWindow,
    openDeployDialog,
    openPriorityDialog,
    openSettingsDialog,
  };
}
