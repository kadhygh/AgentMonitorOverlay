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

type LazyWindowKind = UtilityWindowKind | "scratchpad";

const utilityWindowDefinitions: Record<
  LazyWindowKind,
  { title: string; width: number; height: number; minWidth: number; minHeight: number }
> = {
  deploy: {
    title: "AMO Workspace Center",
    width: 1000,
    height: 640,
    minWidth: 760,
    minHeight: 500,
  },
  scratchpad: {
    title: "AMO Scratchpad",
    width: 480,
    height: 320,
    minWidth: 340,
    minHeight: 220,
  },
  settings: {
    title: "AMO Settings",
    width: 660,
    height: 500,
    minWidth: 540,
    minHeight: 400,
  },
  priorities: {
    title: "AMO Task Priorities",
    width: 720,
    height: 580,
    minWidth: 560,
    minHeight: 430,
  },
};

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
      await getOrCreateUtilityWindow(label);
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
export function ensureScratchpadWindow() {
  return getOrCreateUtilityWindow("scratchpad");
}

async function getOrCreateUtilityWindow(label: LazyWindowKind) {
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) return existing;

  const definition = utilityWindowDefinitions[label];
  const target = new WebviewWindow(label, {
    url: "/",
    title: definition.title,
    width: definition.width,
    height: definition.height,
    minWidth: definition.minWidth,
    minHeight: definition.minHeight,
    resizable: true,
    decorations: false,
    alwaysOnTop: true,
    transparent: true,
    shadow: true,
    skipTaskbar: true,
    visible: false,
    center: true,
  });

  await new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`${label} window creation timed out`));
    }, 8000);

    void target.once("tauri://created", () => {
      window.clearTimeout(timeoutId);
      resolve();
    });
    void target.once<string>("tauri://error", (event) => {
      window.clearTimeout(timeoutId);
      reject(new Error(event.payload || `${label} window creation failed`));
    });
  });

  return target;
}
