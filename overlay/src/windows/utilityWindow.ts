import { useEffect, type PointerEvent } from "react";
import { getCurrentWindow, Window as TauriWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export type UtilityWindowKind = "deploy" | "settings" | "priorities" | "harness";
export type ToolWindowKind = UtilityWindowKind | "canvas";
export type AmoWindowLabel = "main" | "scratchpad" | ToolWindowKind;

// Canvas is an independent work surface; modal utility coordination must never own it.
export const TOOL_WINDOW_POLICY = {
  deploy: { modal: true, closeOnEscape: true, alwaysOnTop: true },
  settings: { modal: true, closeOnEscape: true, alwaysOnTop: true },
  priorities: { modal: true, closeOnEscape: true, alwaysOnTop: true },
  harness: { modal: true, closeOnEscape: true, alwaysOnTop: true },
  canvas: { modal: false, closeOnEscape: false, alwaysOnTop: false },
} as const satisfies Record<ToolWindowKind, { modal: boolean; closeOnEscape: boolean; alwaysOnTop: boolean }>;

export interface UtilityWindowStateEvent {
  label: UtilityWindowKind;
  open: boolean;
}

export const CURRENT_WINDOW_LABEL = getCurrentWebviewWindow().label;

const AMO_FLOATING_WINDOWS: AmoWindowLabel[] = ["main", "scratchpad"];
const AMO_UTILITY_WINDOWS: UtilityWindowKind[] = ["deploy", "settings", "priorities", "harness"];
const AMO_WINDOW_LABELS: AmoWindowLabel[] = [...AMO_FLOATING_WINDOWS, ...AMO_UTILITY_WINDOWS];

export function startUtilityWindowDrag(event: PointerEvent<HTMLElement>) {
  if ((event.target as HTMLElement).closest("button, input, select, textarea, label")) {
    return;
  }

  void getCurrentWindow().startDragging().catch(() => undefined);
}

export async function closeUtilityWindow(label: ToolWindowKind) {
  if (label === "canvas") {
    await getCurrentWindow().hide();
    await getCurrentWindow().emitTo("canvas", "amo-canvas-visibility", false).catch(() => undefined);
    return;
  }
  const payload = { label, open: false } satisfies UtilityWindowStateEvent;
  await getCurrentWindow().emitTo("main", "amo-utility-window-state", payload).catch(() => undefined);
  await getCurrentWindow().hide().catch(() => undefined);
  await setAmoWindowAlwaysOnTop(label, false);
  await setAmoWindowAlwaysOnTop("main", true);
  await getCurrentWindow().emitTo("main", "amo-utility-window-state", payload).catch(() => undefined);
}

export function useUtilityWindowLifecycle(label: ToolWindowKind) {
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault();
        void closeUtilityWindow(label);
      })
      .then((handler) => {
        if (disposed) handler();
        else unlisten = handler;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [label]);

  useEffect(() => {
    if (!TOOL_WINDOW_POLICY[label].closeOnEscape) return;
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
  return Object.prototype.hasOwnProperty.call(TOOL_WINDOW_POLICY, label)
    && TOOL_WINDOW_POLICY[label as ToolWindowKind].modal;
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

export async function bringUtilityWindowToFront(label: ToolWindowKind) {
  const target = await getAmoWindow(label);
  if (!target) return;
  if (label === "canvas") {
    await target.unminimize().catch(() => undefined);
    await target.show();
    await target.emitTo("canvas", "amo-canvas-visibility", true).catch(() => undefined);
    await target.setFocus().catch(() => undefined);
    return;
  }
  await target?.show().catch(() => undefined);
  await Promise.all([
    setAmoWindowAlwaysOnTop("main", false),
    target?.setAlwaysOnTop(true).catch(() => undefined),
  ]);
  await target?.setFocus().catch(() => undefined);
  await Promise.all(
    AMO_UTILITY_WINDOWS.filter((utilityLabel) => utilityLabel !== label).map((utilityLabel) =>
      setAmoWindowAlwaysOnTop(utilityLabel, false),
    ),
  );
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
