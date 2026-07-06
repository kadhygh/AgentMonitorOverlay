import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type AmoTheme = "dark" | "light";

interface AmoThemeChangedEvent {
  theme: AmoTheme;
}

const AMO_THEME_STORAGE_KEY = "amo.theme";
const AMO_THEME_WINDOW_LABELS = ["main", "scratchpad", "deploy", "settings"];

function normalizeAmoTheme(value: unknown): AmoTheme {
  return value === "light" ? "light" : "dark";
}

function loadAmoTheme(): AmoTheme {
  try {
    return normalizeAmoTheme(localStorage.getItem(AMO_THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
}

function applyAmoTheme(theme: AmoTheme) {
  document.documentElement.dataset.amoTheme = theme;
}

function saveAmoTheme(theme: AmoTheme) {
  try {
    localStorage.setItem(AMO_THEME_STORAGE_KEY, theme);
  } catch {
    // The visual preference still applies to the current window even if storage is unavailable.
  }
  applyAmoTheme(theme);
}

async function broadcastAmoTheme(theme: AmoTheme) {
  const payload = { theme } satisfies AmoThemeChangedEvent;
  await Promise.all(
    AMO_THEME_WINDOW_LABELS.map((label) =>
      getCurrentWindow()
        .emitTo(label, "amo-theme-changed", payload)
        .catch(() => undefined),
    ),
  );
}

export function useAmoThemeRuntime(): [AmoTheme, (next: AmoTheme) => Promise<void>] {
  const [theme, setTheme] = useState<AmoTheme>(() => loadAmoTheme());

  useEffect(() => {
    applyAmoTheme(theme);
  }, [theme]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void getCurrentWindow()
      .listen<AmoThemeChangedEvent>("amo-theme-changed", (event) => {
        const nextTheme = normalizeAmoTheme(event.payload?.theme);
        setTheme(nextTheme);
        saveAmoTheme(nextTheme);
      })
      .then((handler) => {
        unlisten = handler;
      });

    function handleStorage(event: StorageEvent) {
      if (event.key !== AMO_THEME_STORAGE_KEY) return;
      const nextTheme = normalizeAmoTheme(event.newValue);
      setTheme(nextTheme);
      applyAmoTheme(nextTheme);
    }

    window.addEventListener("storage", handleStorage);
    return () => {
      unlisten?.();
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  async function updateTheme(next: AmoTheme) {
    setTheme(next);
    saveAmoTheme(next);
    await broadcastAmoTheme(next);
  }

  return [theme, updateTheme];
}

applyAmoTheme(loadAmoTheme());
