import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { FocusApp } from "./focus/FocusApp.js";
import "@fontsource-variable/noto-sans-sc";
import "@fontsource-variable/noto-serif-sc";
import "@fontsource-variable/jetbrains-mono";
import "./styles/app.css";
import "./styles/chat.css";
import "./styles/compose.css";
import { applyTheme, followThemeChanges } from "./lib/theme.js";

// One bundle, two windows: the workbench, and the Focus window (loaded with #focus).
const focus = location.hash === "#focus";
// The saved theme before the first paint; the other window's changes follow.
applyTheme();
followThemeChanges();
if (focus) document.documentElement.classList.add("focus-mode");

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<StrictMode>{focus ? <FocusApp /> : <App />}</StrictMode>);
