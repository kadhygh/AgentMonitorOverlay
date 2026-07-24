import { useEffect, type PointerEvent } from "react";
import { getCurrentWindow, Window as TauriWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export type UtilityWindowKind = "deploy" | "settings" | "priorities";
export type AmoWindowLabel = "main" | "scratchpad" | UtilityWindowKind;

export interface UtilityWindowStateEvent {
  label: UtilityWindowKind;
  open: boolean;
}

export const CURRENT_WINDOW_LABEL = getCurrentWebviewWindow().label;

const AMO_FLOATING_WINDOWS: AmoWindowLabel[] = ["main", "scratchpad"];
const AMO_UTILITY_WINDOWS: UtilityWindowKind[] = ["deploy", "settings", "priorities"];
const AMO_WINDOW_LABELS: AmoWindowLabel[] = [...AMO_FLOATING_WINDOWS, ...AMO_UTILITY_WINDOWS];

export function startUtilityWindowDrag(event: PointerEvent<HTMLElement>) {
  if ((event.target as HTMLElement).closest("button, input, select, textarea, label")) {
    return;
  }

  void getCurrentWindow().startDragging().catch(() => undefined);
}

export async function closeUtilityWindow(label: UtilityWindowKind) {
  const payload = { label, open: false } satisfies UtilityWindowStateEvent;
  await getCurrentWindow().emitTo("main", "amo-utility-window-state", payload).catch(() => undefined);
  await getCurrentWindow().hide().catch(() => undefined);
  await setAmoWindowAlwaysOnTop(label, false);
  await setAmoWindowAlwaysOnTop("main", true);
  await getCurrentWindow().emitTo("main", "amo-utility-window-state", payload).catch(() => undefined);
}

export function useUtilityWindowLifecycle(label: UtilityWindowKind) {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        void closeUtilityWindow(label);
      })
      .then((handler) => {
        unlisten = handler;
      });

    return () => {
      unlisten?.();
    };
  }, [label]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void closeUtilityWindow(label);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [label]);
}

export function isUtilityWindowLabel(label: string): label is UtilityWindowKind {
  return label === "deploy" || label === "settings" || label === "priorities";
}

async function getAmoWindow(label: AmoWindowLabel) {
  return label === CURRENT_WINDOW_LABEL ? getCurrentWindow() : await TauriWindow.getByLabel(label);
}

export async function setAmoWindowAlwaysOnTop(label: AmoWindowLabel, alwaysOnTop: boolean) {
  const target = await getAmoWindow(label);
  await target?.setAlwaysOnTop(alwaysOnTop).catch(() => undefined);
}

export async function setAmoWindowsAlwaysOnTop(alwaysOnTop: boolean) {
  await Promise.all(AMO_WINDOW_LABELS.map((label) => setAmoWindowAlwaysOnTop(label, alwaysOnTop)));
}

export async function bringUtilityWindowToFront(label: UtilityWindowKind) {
  const target = await getAmoWindow(label);
  await setAmoWindowAlwaysOnTop("main", false);
  await Promise.all(
    AMO_UTILITY_WINDOWS.filter((utilityLabel) => utilityLabel !== label).map((utilityLabel) =>
      setAmoWindowAlwaysOnTop(utilityLabel, false),
    ),
  );
  await setAmoWindowAlwaysOnTop(label, true);
  await target?.show().catch(() => undefined);
  await target?.setFocus().catch(() => undefined);
}

export async function restoreAmoWindowLayerAfterNativeDialog() {
  await Promise.all(AMO_FLOATING_WINDOWS.map((label) => setAmoWindowAlwaysOnTop(label, true)));

  if (isUtilityWindowLabel(CURRENT_WINDOW_LABEL)) {
    await bringUtilityWindowToFront(CURRENT_WINDOW_LABEL);
    return;
  }

  await Promise.all(AMO_UTILITY_WINDOWS.map((label) => setAmoWindowAlwaysOnTop(label, false)));
  await getCurrentWindow().setFocus().catch(() => undefined);
}

export async function runWithNativeDialogLayer<T>(operation: () => Promise<T>): Promise<T> {
  await setAmoWindowsAlwaysOnTop(false);
  await sleep(40);

  try {
    return await operation();
  } finally {
    await restoreAmoWindowLayerAfterNativeDialog();
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
