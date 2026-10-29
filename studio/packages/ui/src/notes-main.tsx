import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ScratchpadApp } from "./scratchpad/ScratchpadApp.js";
import { NotesSettingsApp } from "./notes/NotesSettingsApp.js";
import { TrayMenu } from "./notes/TrayMenu.js";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "@fontsource-variable/jetbrains-mono";
// The controls the 便签 windows use (buttons, fields), then their own styles.
import "./styles/base.css";
import "./shell/shell.css";
import "./task/task.css";
import "./settings/settings.css";
import "./scratchpad/scratchpad.css";
import "./notes/notes.css";
import { applyTheme } from "./lib/theme.js";
import { WindowBoundary } from "./lib/ErrorBoundary.js";

// The AMO 便签 program's own entry (notes.html, 2026-10-23): its three windows only — the 便签 (#scratchpad), its
// settings (#notes-settings) and its tray menu (#notes-tray-menu) — not Studio's whole bundle, so it starts quicker.

// 主题 is 便签's own setting (2026-10-29): its main process sets the system colours for its windows, which base.css
// follows when no theme is forced here.
applyTheme("system");
const hash = location.hash;
const view = hash === "#notes-settings" ? "settings" : hash === "#notes-tray-menu" ? "tray" : "pad";
document.documentElement.classList.add(view === "settings" ? "notes-settings-mode" : view === "tray" ? "notes-tray-mode" : "scratchpad-mode");

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <WindowBoundary>{view === "settings" ? <NotesSettingsApp /> : view === "tray" ? <TrayMenu /> : <ScratchpadApp />}</WindowBoundary>
  </StrictMode>,
);
